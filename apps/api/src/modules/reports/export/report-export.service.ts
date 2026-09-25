import { HttpStatus, Injectable } from '@nestjs/common';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { Job, Prisma } from '@parc-auto/db';
import { Clock } from '../../../common/clock.js';
import { AppError, BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../../common/errors.js';
import type { RequestContext } from '../../../common/request-context.js';
import { localDate } from '../../../domain/civil-date.js';
import { AuditService } from '../../../infra/audit.service.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { ObjectStorage } from '../../../infra/storage.service.js';
import { AccessControlService } from '../../access-control/access-control.service.js';
import { JobsService } from '../../jobs/jobs.service.js';
import type { ExportAcceptedDto, ExportJobViewDto, ReportExportQueryDto, ReportMetaDto } from '../dto/reports.dto.js';
import { type PreparedReport, ReportsService } from '../reports.service.js';
import type { ReportFilters, ReportResult, ReportRow } from '../report-types.js';
import { formatLocalDateTime } from './format.js';
import { EXPORT_CONTENT_TYPES, type ExportDocument, type ExportFormat, writeExport } from './report-file-writer.js';
import { ReportExportPolicy } from './report-export.policy.js';

/** Type de job des exports différés (D-272). */
export const REPORT_EXPORT_JOB = 'report-export';

/** Charge utile d'un job d'export : rapport, filtres normalisés, format et demandeur. */
export interface ReportExportPayload {
  code: string;
  format: ExportFormat;
  filters: ReportFilters;
  requestedById: string;
}

/** Résultat d'un job d'export : fichier privé et droits nécessaires à son téléchargement. */
export interface ReportExportResult {
  attachmentId: string;
  fileName: string;
  contentType: string;
  rowCount: number;
  /** Sociétés dont le fichier contient des données (droits revérifiés au téléchargement). */
  companyIds: string[];
  /** Le fichier contient des colonnes de coût (costs.read revérifié au téléchargement). */
  hasCostColumns: boolean;
  expiresAt: string;
}

export interface SyncExport {
  kind: 'file';
  fileName: string;
  contentType: string;
  rowCount: number;
  write(target: Writable): Promise<void>;
}

export interface GeneratedExport {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  rowCount: number;
}

/**
 * Exports CSV/XLSX des rapports (CDC 11.2 ; D-266, D-270, D-272, D-273). Mêmes lignes que l'écran, lues par
 * le même fournisseur sur un périmètre restreint aux sociétés où reports.export est détenue ; colonnes de
 * coût seulement avec costs.read sur toutes les sociétés exportées. Synchrone en flux jusqu'au seuil,
 * job différé au-delà (fichier privé réservé au demandeur, droits revérifiés au téléchargement, conservé
 * 24 h). Chaque export et chaque téléchargement sont audités.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly reports: ReportsService,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly access: AccessControlService,
    private readonly clock: Clock,
    private readonly policy: ReportExportPolicy,
  ) {}

  async start(ctx: RequestContext, code: string, query: ReportExportQueryDto): Promise<SyncExport | ({ kind: 'job' } & ExportAcceptedDto)> {
    const { format, ...filters } = query;
    const prepared = await this.reports.prepare(ctx, code, filters, 'export');
    const first = await this.reports.read(prepared, { skip: 0, take: this.policy.syncMaxRows });
    this.assertBelowCeiling(first.total);
    const auditAfter = { report: prepared.provider.code, view: prepared.view.code, format, filters: prepared.run.filters, companyIds: prepared.run.scope.companyIds, costColumns: prepared.hasCostColumns, rowCount: first.total };
    if (first.total > this.policy.syncMaxRows) {
      const payload: ReportExportPayload = { code: prepared.provider.code, format, filters: prepared.run.filters, requestedById: ctx.userId };
      const job = await this.prisma.client.$transaction(async (tx) => {
        const created = await this.jobs.enqueue({ organizationId: ctx.organizationId, type: REPORT_EXPORT_JOB, payload: payload as unknown as Prisma.InputJsonValue, requestedById: ctx.userId }, tx);
        await this.audit.record(ctx, { action: 'export.rapport', objectType: 'Job', objectId: created.id, after: { ...auditAfter, mode: 'asynchrone' } }, tx);
        return created;
      });
      return { kind: 'job', jobId: job.id, rowCount: first.total, statusPath: `/api/v1/reports/exports/${job.id}` };
    }
    await this.audit.record(ctx, { action: 'export.rapport', objectType: 'Rapport', objectId: prepared.provider.code, after: { ...auditAfter, mode: 'synchrone' } });
    const doc = this.document(prepared, first);
    return {
      kind: 'file',
      fileName: this.fileName(prepared, format),
      contentType: EXPORT_CONTENT_TYPES[format],
      rowCount: first.total,
      write: async (target) => {
        await writeExport(format, target, doc, single(first.rows));
      },
    };
  }

  /**
   * Génération complète d'un export différé (gestionnaire de job) : lecture par lots du même fournisseur,
   * progression, fichier en mémoire (plafond 100 000 lignes).
   */
  async generate(prepared: PreparedReport, format: ExportFormat, progress: (percent: number) => Promise<void>): Promise<GeneratedExport> {
    const chunk = Math.max(1, this.policy.chunkSize);
    const first = await this.reports.read(prepared, { skip: 0, take: chunk });
    this.assertBelowCeiling(first.total);
    const total = first.total;
    const reports = this.reports;
    async function* rows(): AsyncGenerator<readonly ReportRow[]> {
      yield first.rows;
      let skip = first.rows.length;
      await progress((90 * skip) / Math.max(1, total));
      while (skip < total && skip > 0) {
        const next = await reports.read(prepared, { skip, take: Math.min(chunk, total - skip) });
        if (next.rows.length === 0) break;
        yield next.rows;
        skip += next.rows.length;
        await progress((90 * skip) / Math.max(1, total));
      }
    }
    const sink = new PassThrough();
    const parts: Buffer[] = [];
    sink.on('data', (part: Buffer) => parts.push(part));
    const finished = new Promise<void>((resolve, reject) => {
      sink.on('end', resolve);
      sink.on('error', reject);
    });
    const rowCount = await writeExport(format, sink, this.document(prepared, first), rows());
    await finished;
    return { buffer: Buffer.concat(parts), fileName: this.fileName(prepared, format), contentType: EXPORT_CONTENT_TYPES[format], rowCount };
  }

  /** Suivi d'un export différé : réservé au demandeur (404 sinon). */
  async status(ctx: RequestContext, jobId: string): Promise<ExportJobViewDto> {
    const job = await this.ownJob(ctx, jobId);
    const payload = job.payload as unknown as Partial<ReportExportPayload>;
    const result = parseResult(job);
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      reportCode: payload.code ?? '',
      format: payload.format ?? '',
      rowCount: result?.rowCount ?? null,
      fileName: result?.fileName ?? null,
      error: job.status === 'ECHEC' || job.status === 'ABANDONNE' ? job.lastError : null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      expiresAt: result?.expiresAt ?? null,
      downloadPath: job.status === 'TERMINE' && result ? `/api/v1/reports/exports/${job.id}/download` : null,
    };
  }

  /**
   * Téléchargement d'un export différé : demandeur seulement ; droits REVÉRIFIÉS (périmètre inchangé,
   * reports.export sur chaque société du fichier, costs.read s'il contient des colonnes de coût) ; 403 sinon.
   */
  async download(ctx: RequestContext, jobId: string): Promise<{ fileName: string; contentType: string; sizeBytes: number; stream: Readable }> {
    this.access.requireStaff(ctx);
    const job = await this.ownJob(ctx, jobId);
    if (job.status !== 'TERMINE') throw new ConflictError('EXPORT_NON_PRET', job.status === 'ECHEC' || job.status === 'ABANDONNE' ? `L’export a échoué : ${job.lastError ?? 'motif inconnu'}.` : 'L’export est en cours de préparation ; réessayez dans un instant.');
    const result = parseResult(job);
    if (!result || new Date(result.expiresAt).getTime() <= this.clock.now().getTime()) throw expired();
    for (const companyId of result.companyIds) {
      if (!this.access.canReadCompany(ctx, companyId)) throw new ForbiddenActionError('Votre périmètre a changé : cet export contient des données de sociétés qui ne vous sont plus accessibles.');
      if (!this.access.hasPermission(ctx, companyId, 'reports.export')) throw new ForbiddenActionError('Permission « reports.export » requise pour télécharger cet export.', { permission: 'reports.export' });
      if (result.hasCostColumns && !this.access.hasPermission(ctx, companyId, 'costs.read')) throw new ForbiddenActionError('Permission « costs.read » requise : cet export contient des colonnes de coût.', { permission: 'costs.read' });
    }
    const attachment = await this.prisma.client.attachment.findFirst({ where: { id: result.attachmentId, organizationId: ctx.organizationId, ownerType: 'EXPORT', ownerId: job.id, deletedAt: null } });
    if (!attachment) throw expired();
    const stream = await this.storage.openRead(attachment.storageKey);
    await this.audit.record(ctx, { action: 'export.telechargement', objectType: 'Job', objectId: job.id, after: { attachmentId: attachment.id, fileName: result.fileName, rowCount: result.rowCount } });
    return { fileName: result.fileName, contentType: result.contentType, sizeBytes: attachment.sizeBytes, stream };
  }

  private async ownJob(ctx: RequestContext, jobId: string): Promise<Job> {
    const job = await this.prisma.client.job.findFirst({ where: { id: jobId, organizationId: ctx.organizationId, requestedById: ctx.userId, type: REPORT_EXPORT_JOB } });
    if (!job) throw new NotFoundOrOutOfScopeError('Export');
    return job;
  }

  private assertBelowCeiling(total: number): void {
    if (total > this.policy.maxRows) {
      throw new BusinessRuleError('EXPORT_TROP_VOLUMINEUX', `L’export compterait ${total.toLocaleString('fr-FR')} lignes, au-delà du plafond de ${this.policy.maxRows.toLocaleString('fr-FR')} : affinez les filtres.`, { details: { rowCount: total, maxRows: this.policy.maxRows } });
    }
  }

  private fileName(prepared: PreparedReport, format: ExportFormat): string {
    return `rapport-${prepared.provider.code}-${prepared.view.code}-${localDate(prepared.run.now, prepared.run.timezone)}.${format}`;
  }

  /** Bloc de paramètres (D-270) : rapport, génération avec fuseau, auteur, périmètre, filtres, unités. */
  private document(prepared: PreparedReport, first: ReportResult): ExportDocument {
    const meta: ReportMetaDto = this.reports.withSummary(prepared, first);
    const tz = meta.timezone;
    const metadata: Array<[string, string]> = [
      ['Rapport', `${meta.label} — ${meta.view.label}`],
      ['Généré le', `${formatLocalDateTime(prepared.run.now, tz, { withSeconds: true })} (${tz})`],
      ['Auteur', meta.author],
      ['Périmètre', meta.scope.map((c) => `${c.code} — ${c.legalName}`).join(', ')],
    ];
    const filters = meta.filters.filter((f) => f.key !== 'vue');
    if (filters.length === 0) metadata.push(['Filtres', 'Aucun']);
    for (const f of filters) metadata.push([`Filtre — ${f.label}`, f.display]);
    metadata.push(['Unités', meta.units.join(' ') || 'Sans unité']);
    if (meta.costColumns !== 'sans_objet') metadata.push(['Colonnes de coût', prepared.hasCostColumns ? 'Incluses' : 'Non incluses : permission costs.read requise sur toutes les sociétés exportées.']);
    metadata.push(['Lignes', String(first.total)]);
    for (const s of meta.summary) metadata.push([`Total — ${s.label}`, s.value === null ? 'N/D' : `${s.value.replace('.', ',')}${s.unit ? ` ${s.unit}` : ''}`]);
    for (const note of meta.notes) metadata.push(['Remarque', note]);
    return { metadata, columns: prepared.columns, timezone: tz };
  }
}

function expired(): AppError {
  return new AppError(HttpStatus.GONE, 'EXPORT_EXPIRE', 'Le fichier d’export n’est plus disponible (conservation 24 h) : relancez l’export.');
}

export function parseResult(job: Job): ReportExportResult | null {
  const r = job.result as unknown as Partial<ReportExportResult> | null;
  if (!r || typeof r.attachmentId !== 'string' || !Array.isArray(r.companyIds) || typeof r.expiresAt !== 'string') return null;
  return {
    attachmentId: r.attachmentId,
    fileName: r.fileName ?? 'export',
    contentType: r.contentType ?? 'application/octet-stream',
    rowCount: r.rowCount ?? 0,
    companyIds: r.companyIds.filter((c): c is string => typeof c === 'string'),
    hasCostColumns: r.hasCostColumns === true,
    expiresAt: r.expiresAt,
  };
}

async function* single(rows: readonly ReportRow[]): AsyncGenerator<readonly ReportRow[]> {
  yield rows;
}
