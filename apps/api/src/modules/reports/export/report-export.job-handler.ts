import { Injectable, Logger } from '@nestjs/common';
import type { Job, Prisma } from '@parc-auto/db';
import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors.js';
import { AuditService } from '../../../infra/audit.service.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { ObjectStorage } from '../../../infra/storage.service.js';
import { ContextBuilderService } from '../../auth/context-builder.service.js';
import { JobAbortedError, type JobHandler } from '../../jobs/jobs.service.js';
import { REPORT_CODES, REPORT_FILTER_KEYS, type ReportFilters } from '../report-types.js';
import { type PreparedReport, ReportsService } from '../reports.service.js';
import { REPORT_EXPORT_JOB, ReportExportService, type ReportExportPayload, type ReportExportResult } from './report-export.service.js';
import { ReportExportPolicy } from './report-export.policy.js';

/**
 * Gestionnaire des exports différés (D-272, D-273), exécuté par le worker via JobsService.runOne. Les droits
 * du demandeur sont relus à l'exécution (compte actif, reports.export, périmètre, costs.read) : un refus
 * abandonne le job sans nouvelle tentative. Le fichier produit est une pièce jointe privée ownerType EXPORT
 * (sans société, rattachée au job), réservée au demandeur et purgée après la durée de conservation.
 */
@Injectable()
export class ReportExportJobHandler implements JobHandler {
  readonly type = REPORT_EXPORT_JOB;
  private readonly logger = new Logger(ReportExportJobHandler.name);

  constructor(
    private readonly contexts: ContextBuilderService,
    private readonly reports: ReportsService,
    private readonly exports: ReportExportService,
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly policy: ReportExportPolicy,
  ) {}

  async handle(job: Job, progress: (percent: number) => Promise<void>): Promise<Prisma.InputJsonValue> {
    const payload = parsePayload(job.payload);
    if (!payload || !job.organizationId) throw new JobAbortedError('Demande d’export invalide.');
    const ctx = await this.contexts.forUser(payload.requestedById, job.organizationId, `job:${job.id}`);
    if (!ctx) throw new JobAbortedError('Le compte du demandeur est désactivé : export abandonné.');
    let prepared: PreparedReport;
    try {
      prepared = await this.reports.prepare(ctx, payload.code, payload.filters, 'export');
    } catch (error) {
      if (error instanceof AppError) throw new JobAbortedError(`Droits revérifiés à l’exécution : ${error.message}`);
      throw error;
    }
    let file: Awaited<ReturnType<ReportExportService['generate']>>;
    try {
      file = await this.exports.generate(prepared, payload.format, progress);
    } catch (error) {
      // Refus métier (plafond de lignes dépassé depuis la demande…) : définitif, sans nouvelle tentative.
      if (error instanceof AppError) throw new JobAbortedError(error.message);
      throw error;
    }
    const stored = await this.storage.put(file.buffer);
    const now = this.clock.now();
    const result: ReportExportResult = {
      attachmentId: '',
      fileName: file.fileName,
      contentType: file.contentType,
      rowCount: file.rowCount,
      companyIds: prepared.run.scope.companyIds,
      hasCostColumns: prepared.hasCostColumns,
      expiresAt: new Date(now.getTime() + this.policy.retentionMs).toISOString(),
    };
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const attachment = await tx.attachment.create({
          data: {
            organizationId: job.organizationId as string,
            companyId: null,
            ownerType: 'EXPORT',
            ownerId: job.id,
            storageKey: stored.storageKey,
            originalName: file.fileName,
            mimeType: file.contentType.split(';')[0] as string,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            uploadedById: payload.requestedById,
            attachedAt: now,
            createdAt: now,
          },
        });
        result.attachmentId = attachment.id;
        await this.audit.record(ctx, { action: 'export.fichier_genere', objectType: 'Job', objectId: job.id, after: { report: payload.code, format: payload.format, rowCount: file.rowCount, attachmentId: attachment.id, companyIds: result.companyIds, costColumns: result.hasCostColumns } }, tx);
      });
    } catch (error) {
      await this.storage.remove(stored.storageKey);
      throw error;
    }
    return result as unknown as Prisma.InputJsonValue;
  }

  /** Purge des fichiers d'export au-delà de la durée de conservation (appelée périodiquement par le worker). */
  async purgeExpiredExports(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.policy.retentionMs);
    const stale = await this.prisma.client.attachment.findMany({ where: { ownerType: 'EXPORT', deletedAt: null, createdAt: { lt: cutoff } }, select: { id: true, storageKey: true }, take: 500 });
    for (const attachment of stale) {
      await this.storage.remove(attachment.storageKey);
      await this.prisma.client.attachment.update({ where: { id: attachment.id }, data: { deletedAt: this.clock.now() } });
    }
    if (stale.length > 0) this.logger.log(`${stale.length} fichier(s) d’export expiré(s) purgé(s).`);
    return stale.length;
  }
}

function parsePayload(raw: Prisma.JsonValue): ReportExportPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p['code'] !== 'string' || !(REPORT_CODES as readonly string[]).includes(p['code'])) return null;
  if (p['format'] !== 'csv' && p['format'] !== 'xlsx') return null;
  if (typeof p['requestedById'] !== 'string') return null;
  const filters: ReportFilters = {};
  const source = (p['filters'] ?? {}) as Record<string, unknown>;
  for (const key of REPORT_FILTER_KEYS) {
    const value = source[key];
    if (typeof value === 'string') filters[key] = value;
  }
  return { code: p['code'], format: p['format'], requestedById: p['requestedById'], filters };
}
