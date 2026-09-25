import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { ImportBatch, ImportKind, ImportRowStatus, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { toCsv } from '../../common/csv-writer.js';
import { formatLocalDateTime } from '../../domain/civil-date.js';
import { BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService, stableStringify } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { ObjectStorage } from '../../infra/storage.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { MANAGER_ROLES } from '../access-control/permissions.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AbandonImportDto, ImportBatchViewDto, ImportCountsDto, ImportModelDto, ImportRowViewDto, ImportRowsQueryDto, ImportsQueryDto, ValidateImportDto } from './dto/imports.dto.js';
import { ImportAppliersService, type RowMessage, type RowValues } from './import-appliers.service.js';
import { IMPORT_COLUMNS, suggestMapping } from './import-columns.js';
import { type Table, readTable } from './parsers/tabular.js';
import { cellText } from './parsers/values.js';

/** Durée maximale d'une transaction de lot (2 000 lignes au plus, 12.1). */
const IMPORT_TX_TIMEOUT_MS = 180_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const KIND_LABELS: Record<ImportKind, string> = {
  VEHICULES: 'Véhicules',
  CONDUCTEURS: 'Conducteurs',
  RELEVES: 'Relevés kilométriques',
  BASES_ENTRETIEN: 'Bases d’entretien',
};

interface RowResult {
  line: number;
  values: Record<string, string>;
  status: 'VALIDE' | 'IGNOREE' | 'ERREUR';
  errors: RowMessage[];
  notes: string[];
  companyId: string | null;
  createdObjectId: string | null;
}

interface BatchReport {
  headers: string[];
  warnings: string[];
  counts: ImportCountsDto | null;
}

/** Fin du contrôle : porte les résultats hors de la transaction, qui est annulée. */
class DryRunFinished extends Error {
  constructor(readonly results: RowResult[]) {
    super('contrôle terminé');
  }
}

/** Revalidation échouée à la confirmation : la transaction est annulée, rien n'est écrit. */
class RevalidationFailed extends Error {
  constructor(readonly results: RowResult[]) {
    super('revalidation échouée');
  }
}

/**
 * Import assisté (CDC 12.1, 12.2 ; D-277 à D-280). Parcours : modèle, téléversement, association des
 * colonnes, contrôle, confirmation, rapport. Le contrôle exécute la logique de confirmation ligne par
 * ligne dans une transaction annulée ; aucune ligne n'est écrite avant la confirmation, qui revalide
 * tout dans une transaction unique et refuse le lot au moindre écart. Réservé au chef de parc et à
 * l'administrateur, sur les sociétés de leur périmètre.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly storage: ObjectStorage,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
    private readonly appliers: ImportAppliersService,
  ) {}

  models(ctx: RequestContext): ImportModelDto[] {
    this.requireImporter(ctx);
    return (Object.keys(IMPORT_COLUMNS) as ImportKind[]).map((kind) => ({ kind, label: KIND_LABELS[kind], columns: IMPORT_COLUMNS[kind].map((c) => ({ ...c })) }));
  }

  /** Modèle vierge : ligne d'en-tête (CSV) ou classeur avec feuilles « Données » et « Aide » (XLSX). */
  async template(ctx: RequestContext, kind: ImportKind, format: 'csv' | 'xlsx'): Promise<{ fileName: string; contentType: string; content: Buffer }> {
    this.requireImporter(ctx);
    const columns = IMPORT_COLUMNS[kind];
    const base = `modele-import-${kind.toLowerCase()}`;
    if (format === 'csv') {
      return { fileName: `${base}.csv`, contentType: 'text/csv; charset=utf-8', content: Buffer.from(toCsv(columns.map((c) => c.name), []), 'utf8') };
    }
    const workbook = new ExcelJS.Workbook();
    const data = workbook.addWorksheet('Données');
    data.addRow(columns.map((c) => c.name));
    data.getRow(1).font = { bold: true };
    columns.forEach((c, i) => {
      const col = data.getColumn(i + 1);
      col.width = Math.max(16, c.name.length + 4);
      // Cellules au format texte : codes, dates et kilomètres ne sont pas réinterprétés par le tableur.
      col.numFmt = '@';
    });
    const help = workbook.addWorksheet('Aide');
    help.addRow(['Colonne', 'Obligatoire', 'Description', 'Exemple']);
    help.getRow(1).font = { bold: true };
    for (const c of columns) help.addRow([c.name, c.required ? 'oui' : 'non', c.description, c.example]);
    help.addRow([]);
    help.addRow(['Formats', '', 'Dates : AAAA-MM-JJ ou JJ/MM/AAAA. Horodatages : AAAA-MM-JJ HH:mm, JJ/MM/AAAA HH:mm ou ISO avec décalage (sinon heure locale du groupe). Kilomètres : entiers sans séparateur. Booléens : oui/non, true/false, 1/0, actif/inactif.', '']);
    help.getColumn(1).width = 24;
    help.getColumn(2).width = 12;
    help.getColumn(3).width = 90;
    help.getColumn(4).width = 24;
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    return { fileName: `${base}.xlsx`, contentType: XLSX_MIME, content };
  }

  async list(ctx: RequestContext, query: ImportsQueryDto): Promise<Page<ImportBatchViewDto>> {
    this.requireImporter(ctx);
    const where: Prisma.ImportBatchWhereInput = { ...this.batchScope(ctx), ...(query.kind ? { kind: query.kind } : {}), ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([this.prisma.client.importBatch.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }), this.prisma.client.importBatch.count({ where })]);
    return pageOf(await this.views(items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<ImportBatchViewDto> {
    const batch = await this.load(ctx, id);
    const [view] = await this.views([batch]);
    return view as ImportBatchViewDto;
  }

  async rows(ctx: RequestContext, id: string, query: ImportRowsQueryDto): Promise<Page<ImportRowViewDto>> {
    await this.load(ctx, id);
    const where: Prisma.ImportRowWhereInput = { batchId: id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([this.prisma.client.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, ...skipTake(query) }), this.prisma.client.importRow.count({ where })]);
    return pageOf(items.map((r) => rowView(r)), total, query);
  }

  /** Téléversement : lecture et contrôle de forme du fichier, stockage privé, association proposée. */
  async upload(ctx: RequestContext, file: { originalname: string; buffer: Buffer; size: number }, kind: ImportKind): Promise<ImportBatchViewDto> {
    this.requireImporter(ctx);
    const lower = file.originalname.toLowerCase();
    const isXlsx = lower.endsWith('.xlsx');
    if (!isXlsx && !lower.endsWith('.csv')) throw new BusinessRuleError('FORMAT_IMPORT', 'Seuls les fichiers CSV (UTF-8) et XLSX sont acceptés.', { fieldErrors: { file: ['Extension .csv ou .xlsx attendue.'] } });
    const maxSize = await this.settings.get(ctx.organizationId, 'imports.maxSizeBytes');
    if (file.size <= 0) throw new BusinessRuleError('FICHIER_VIDE', 'Le fichier est vide.');
    if (file.size > maxSize) throw new BusinessRuleError('FICHIER_TROP_VOLUMINEUX', `Le fichier dépasse la taille maximale d’un import (${(maxSize / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo).`);
    // Signature réelle : un XLSX est une archive ZIP ; un CSV ne doit pas l'être.
    const isZip = file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (isXlsx !== isZip) throw new BusinessRuleError('FORMAT_IMPORT', 'Le contenu du fichier ne correspond pas à son extension.');
    const maxRows = await this.settings.get(ctx.organizationId, 'imports.maxRows');
    const table = await readTable(file.buffer, file.originalname, maxRows);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const warnings: string[] = [];
    const previous = await this.prisma.client.importBatch.findFirst({ where: { organizationId: ctx.organizationId, fileSha256: sha256, status: 'CONFIRME' }, orderBy: { committedAt: 'desc' } });
    if (previous?.committedAt) {
      const timezone = await this.timezone(ctx.organizationId);
      warnings.push(`Ce fichier a déjà été importé le ${formatLocalDateTime(previous.committedAt, timezone, { sentence: true })} : les dossiers existants seront signalés en erreur et les relevés identiques ignorés.`);
    }
    const stored = await this.storage.put(file.buffer);
    const safeName = file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150) || (isXlsx ? 'import.xlsx' : 'import.csv');
    const mapping = suggestMapping(kind, table.headers);
    const report: BatchReport = { headers: table.headers, warnings, counts: null };
    const batch = await this.prisma.client.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: { organizationId: ctx.organizationId, companyId: null, storageKey: stored.storageKey, originalName: safeName, mimeType: isXlsx ? XLSX_MIME : 'text/csv', sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedById: ctx.userId, createdAt: this.clock.now() },
      });
      const created = await tx.importBatch.create({
        data: { organizationId: ctx.organizationId, kind, fileName: safeName, fileSha256: sha256, attachmentId: attachment.id, columnMapping: mapping, rowCount: table.rows.length, report: report as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
      });
      await tx.attachment.update({ where: { id: attachment.id }, data: { ownerType: 'IMPORT', ownerId: created.id, attachedAt: this.clock.now() } });
      await this.audit.record(ctx, { action: 'import.televersement', objectType: 'ImportBatch', objectId: created.id, companyId: null, after: { kind, fileName: safeName, rowCount: table.rows.length, sha256 } }, tx);
      return created;
    });
    return this.get(ctx, batch.id);
  }

  /**
   * Contrôle : association des colonnes vérifiée, puis chaque ligne est appliquée dans une transaction
   * annulée (points de sauvegarde par ligne) ; le résultat ligne/colonne/message est enregistré.
   */
  async validate(ctx: RequestContext, id: string, dto: ValidateImportDto): Promise<ImportBatchViewDto> {
    const batch = await this.load(ctx, id);
    if (batch.status !== 'TELEVERSE' && batch.status !== 'CONTROLE') throw new ConflictError('ETAT_INVALIDE', 'Ce lot est déjà confirmé ou abandonné.');
    assertExpectedVersion(batch, dto.expectedVersion, 'lot d’import');
    const table = await this.readStored(batch);
    const mapping = checkMapping(batch.kind, table.headers, dto.mapping);
    const timezone = await this.timezone(ctx.organizationId);

    let results: RowResult[];
    try {
      await this.prisma.serializable(
        async (tx) => {
          const rows = await this.runAll(tx, ctx, batch, table, mapping, timezone, new AfterCommit());
          throw new DryRunFinished(rows);
        },
        { timeoutMs: IMPORT_TX_TIMEOUT_MS },
      );
      throw new Error('Le contrôle d’import s’est terminé sans résultat.');
    } catch (error) {
      if (!(error instanceof DryRunFinished)) throw error;
      results = error.results;
    }

    const counts = countsOf(results);
    const report: BatchReport = { ...reportOf(batch), counts };
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.importBatch.updateMany({
        where: { id, version: dto.expectedVersion, status: { in: ['TELEVERSE', 'CONTROLE'] } },
        data: { status: 'CONTROLE', columnMapping: mapping, errorCount: counts.errors, validatedAt: this.clock.now(), report: report as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      });
      if (updated.count === 0) throw new ConflictError('VERSION_OBSOLETE', 'Le lot a été modifié entre-temps ; rechargez-le.');
      await this.replaceRows(tx, ctx, id, results, (r) => r.status);
      await this.audit.record(ctx, { action: 'import.controle', objectType: 'ImportBatch', objectId: id, companyId: null, after: { mapping, counts } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Confirmation (D-277) : idempotente par clé d'idempotence et par lot (commitKey = empreinte du lot,
   * du fichier et de l'association). Transaction unique qui revalide toutes les lignes ; au moindre
   * écart, rien n'est écrit et le lot revient au contrôle avec les erreurs constatées.
   */
  async commit(ctx: RequestContext, id: string, idempotencyKey: string): Promise<ImportBatchViewDto> {
    await this.load(ctx, id);
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `import.commit:${id}`, key: idempotencyKey }, { batchId: id }, async () => {
      await this.commitOnce(ctx, id);
      return { status: 200, body: await this.get(ctx, id), resourceId: id };
    });
    return result.body;
  }

  private async commitOnce(ctx: RequestContext, id: string): Promise<void> {
    const batch = await this.load(ctx, id);
    if (batch.status === 'CONFIRME') return;
    if (batch.status !== 'CONTROLE') throw new ConflictError('ETAT_INVALIDE', batch.status === 'ABANDONNE' ? 'Ce lot a été abandonné.' : 'Contrôlez le lot avant de le confirmer.');
    if (batch.errorCount > 0) throw new BusinessRuleError('LOT_INVALIDE', `Le lot comporte ${batch.errorCount} ligne(s) en erreur : aucune ligne n’est importée. Corrigez le fichier et téléversez-le à nouveau.`, { details: { errorCount: batch.errorCount } });
    const mapping = batch.columnMapping as Record<string, string>;
    const table = await this.readStored(batch);
    const timezone = await this.timezone(ctx.organizationId);
    const commitKey = createHash('sha256').update(`${batch.id}|${batch.fileSha256}|${stableStringify(mapping)}`).digest('hex');

    let after: AfterCommit | null = null;
    try {
      after = await this.prisma.serializable(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id}::uuid FOR UPDATE`;
          const fresh = await tx.importBatch.findUniqueOrThrow({ where: { id } });
          if (fresh.status === 'CONFIRME') return null;
          if (fresh.status !== 'CONTROLE' || fresh.errorCount > 0 || fresh.version !== batch.version) throw new ConflictError('VERSION_OBSOLETE', 'Le lot a changé pendant la confirmation ; rechargez-le.');
          const pending = new AfterCommit();
          const results = await this.runAll(tx, ctx, fresh, table, mapping, timezone, pending);
          if (results.some((r) => r.status === 'ERREUR')) throw new RevalidationFailed(results);
          const counts = countsOf(results);
          await this.replaceRows(tx, ctx, id, results, (r) => (r.status === 'VALIDE' ? 'IMPORTEE' : r.status));
          await tx.importBatch.update({
            where: { id },
            data: { status: 'CONFIRME', commitKey, committedAt: this.clock.now(), committedById: ctx.userId, errorCount: 0, report: { ...reportOf(fresh), counts } as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
          });
          await this.audit.record(ctx, { action: 'import.confirmation', objectType: 'ImportBatch', objectId: id, companyId: null, after: { kind: fresh.kind, fileName: fresh.fileName, counts, commitKey } }, tx);
          return pending;
        },
        { timeoutMs: IMPORT_TX_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof RevalidationFailed)) throw error;
      const counts = countsOf(error.results);
      await this.prisma.client.$transaction(async (tx) => {
        await tx.importBatch.update({ where: { id }, data: { errorCount: counts.errors, validatedAt: this.clock.now(), report: { ...reportOf(batch), counts } as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
        await this.replaceRows(tx, ctx, id, error.results, (r) => r.status);
        await this.audit.record(ctx, { action: 'import.confirmation_refusee', objectType: 'ImportBatch', objectId: id, companyId: null, after: { counts } }, tx);
      });
      throw new BusinessRuleError('LOT_INVALIDE', `Les données ont changé depuis le contrôle : ${counts.errors} ligne(s) en erreur, aucune ligne importée. Consultez le rapport.`, { details: { errorCount: counts.errors } });
    }
    if (after) await after.run();
  }

  async abandon(ctx: RequestContext, id: string, dto: AbandonImportDto): Promise<ImportBatchViewDto> {
    const batch = await this.load(ctx, id);
    if (batch.status !== 'TELEVERSE' && batch.status !== 'CONTROLE') throw new ConflictError('ETAT_INVALIDE', 'Seul un lot non confirmé peut être abandonné.');
    assertExpectedVersion(batch, dto.expectedVersion, 'lot d’import');
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.importBatch.updateMany({ where: { id, version: dto.expectedVersion, status: { in: ['TELEVERSE', 'CONTROLE'] } }, data: { status: 'ABANDONNE', version: { increment: 1 } } });
      if (updated.count === 0) throw new ConflictError('VERSION_OBSOLETE', 'Le lot a été modifié entre-temps ; rechargez-le.');
      await this.audit.record(ctx, { action: 'import.abandon', objectType: 'ImportBatch', objectId: id, companyId: null, reason: dto.reason ?? null }, tx);
    });
    return this.get(ctx, id);
  }

  /** Rapport ligne/colonne/message (12.1) en CSV, cellules neutralisées (T34). */
  async reportCsv(ctx: RequestContext, id: string): Promise<{ fileName: string; content: string }> {
    const batch = await this.load(ctx, id);
    const rows = await this.prisma.client.importRow.findMany({ where: { batchId: id }, orderBy: { rowNumber: 'asc' } });
    const lines: unknown[][] = [];
    for (const row of rows) {
      const view = rowView(row);
      const messages = [...view.errors.map((e) => [e.column ?? '', e.message]), ...view.notes.map((n) => ['', n])];
      if (messages.length === 0) lines.push([view.rowNumber, view.status, '', '', view.createdObjectId ?? '']);
      for (const [column, message] of messages) lines.push([view.rowNumber, view.status, column, message, view.createdObjectId ?? '']);
    }
    const base = batch.fileName.replace(/\.(csv|xlsx)$/i, '');
    return { fileName: `rapport-${base}.csv`, content: toCsv(['ligne', 'statut', 'colonne', 'message', 'objet_cree'], lines) };
  }

  // ---------------------------------------------------------------------------------------------

  /** Exécute toutes les lignes, chacune sous un point de sauvegarde : une ligne en erreur n'affecte pas les autres. */
  private async runAll(tx: Tx, ctx: RequestContext, batch: ImportBatch, table: Table, mapping: Record<string, string>, timezone: string, after: AfterCommit): Promise<RowResult[]> {
    const state = await this.appliers.newState(tx, ctx, batch.kind, batch.id, timezone, after);
    const indexes = new Map(Object.entries(mapping).map(([column, header]) => [column, table.headers.indexOf(header)]));
    const results: RowResult[] = [];
    for (const row of table.rows) {
      const values: RowValues = {};
      const texts: Record<string, string> = {};
      for (const col of IMPORT_COLUMNS[batch.kind]) {
        const index = indexes.get(col.name);
        const cell = index !== undefined && index >= 0 ? (row.cells[index] ?? null) : null;
        values[col.name] = cell;
        const t = cellText(cell);
        if (t !== '') texts[col.name] = t;
      }
      await tx.$executeRawUnsafe('SAVEPOINT import_row');
      try {
        const outcome = await this.appliers.apply(tx, state, values, row.line);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
        results.push({ line: row.line, values: texts, status: outcome.status, errors: [], notes: outcome.notes, companyId: outcome.companyId, createdObjectId: outcome.createdObjectId });
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
        results.push({ line: row.line, values: texts, status: 'ERREUR', errors: this.appliers.describe(batch.kind, error), notes: [], companyId: null, createdObjectId: null });
      }
    }
    return results;
  }

  private async replaceRows(tx: Tx, ctx: RequestContext, batchId: string, results: RowResult[], status: (r: RowResult) => ImportRowStatus): Promise<void> {
    await tx.importRow.deleteMany({ where: { batchId } });
    await tx.importRow.createMany({
      data: results.map((r) => ({
        organizationId: ctx.organizationId,
        batchId,
        rowNumber: r.line,
        companyId: r.companyId,
        data: { values: r.values, notes: r.notes },
        errors: r.errors as unknown as Prisma.InputJsonValue,
        status: status(r),
        createdObjectId: r.createdObjectId,
      })),
    });
  }

  private async readStored(batch: ImportBatch): Promise<Table> {
    const attachment = await this.prisma.client.attachment.findFirst({ where: { id: batch.attachmentId, organizationId: batch.organizationId, deletedAt: null } });
    if (!attachment) throw new NotFoundOrOutOfScopeError('Fichier du lot');
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.openRead(attachment.storageKey)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const buffer = Buffer.concat(chunks);
    if (createHash('sha256').update(buffer).digest('hex') !== batch.fileSha256) throw new ConflictError('FICHIER_ALTERE', 'Le fichier stocké ne correspond plus à l’empreinte du lot.');
    const maxRows = await this.settings.get(batch.organizationId, 'imports.maxRows');
    return readTable(buffer, batch.fileName, maxRows);
  }

  /** Lot visible : l'administrateur voit tous les lots ; le chef de parc, ceux qu'il a téléversés. */
  private async load(ctx: RequestContext, id: string): Promise<ImportBatch> {
    this.requireImporter(ctx);
    const batch = await this.prisma.client.importBatch.findFirst({ where: { id, ...this.batchScope(ctx) } });
    if (!batch) throw new NotFoundOrOutOfScopeError('Lot d’import');
    return batch;
  }

  private batchScope(ctx: RequestContext): Prisma.ImportBatchWhereInput {
    return ctx.isAdmin ? { organizationId: ctx.organizationId } : { organizationId: ctx.organizationId, createdById: ctx.userId };
  }

  private requireImporter(ctx: RequestContext): void {
    if (this.access.companiesWithRole(ctx, MANAGER_ROLES).length === 0) throw new ForbiddenActionError('L’import est réservé au chef de parc et à l’administrateur.');
  }

  private async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    return org.timezone;
  }

  private async views(batches: ImportBatch[]): Promise<ImportBatchViewDto[]> {
    const authorIds = [...new Set(batches.map((b) => b.createdById).filter((v): v is string => v !== null))];
    const authors = authorIds.length > 0 ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    return batches.map((b) => {
      const report = reportOf(b);
      return {
        id: b.id,
        kind: b.kind,
        status: b.status,
        fileName: b.fileName,
        rowCount: b.rowCount,
        errorCount: b.errorCount,
        headers: report.headers,
        columnMapping: (b.columnMapping as Record<string, string> | null) ?? null,
        warnings: report.warnings,
        counts: report.counts,
        createdByName: ((a) => (a ? `${a.firstName} ${a.lastName}` : null))(authors.find((a) => a.id === b.createdById)),
        createdAt: b.createdAt.toISOString(),
        validatedAt: b.validatedAt?.toISOString() ?? null,
        committedAt: b.committedAt?.toISOString() ?? null,
        version: b.version,
      };
    });
  }
}

/** Association colonnes → en-têtes : colonnes connues, en-têtes présents, obligatoires toutes associées. */
function checkMapping(kind: ImportKind, headers: readonly string[], mapping: Record<string, unknown>): Record<string, string> {
  const columns = IMPORT_COLUMNS[kind];
  const fieldErrors: Record<string, string[]> = {};
  const result: Record<string, string> = {};
  const used = new Map<string, string>();
  for (const [column, header] of Object.entries(mapping)) {
    if (header === '' || header === null || header === undefined) continue;
    if (!columns.some((c) => c.name === column)) fieldErrors[column] = ['Colonne inconnue pour ce modèle.'];
    else if (typeof header !== 'string' || !headers.includes(header)) fieldErrors[column] = ['En-tête absent du fichier.'];
    else if (used.has(header)) fieldErrors[column] = [`En-tête déjà associé à la colonne ${used.get(header)}.`];
    else {
      used.set(header, column);
      result[column] = header;
    }
  }
  for (const c of columns) if (c.required && !result[c.name] && !fieldErrors[c.name]) fieldErrors[c.name] = ['Colonne obligatoire non associée.'];
  if (Object.keys(fieldErrors).length > 0) throw new BusinessRuleError('ASSOCIATION_INCOMPLETE', 'Associez chaque colonne obligatoire à un en-tête du fichier.', { fieldErrors });
  return result;
}

function reportOf(batch: ImportBatch): BatchReport {
  const r = (batch.report ?? {}) as Partial<BatchReport>;
  return { headers: r.headers ?? [], warnings: r.warnings ?? [], counts: r.counts ?? null };
}

function countsOf(results: RowResult[]): ImportCountsDto {
  const errors = results.filter((r) => r.status === 'ERREUR').length;
  const ignored = results.filter((r) => r.status === 'IGNOREE').length;
  const valid = results.filter((r) => r.status === 'VALIDE').length;
  return { total: results.length, valid, errors, ignored, withNotes: results.filter((r) => r.status === 'VALIDE' && r.notes.length > 0).length };
}

function rowView(r: { rowNumber: number; status: ImportRowStatus; data: Prisma.JsonValue; errors: Prisma.JsonValue; createdObjectId: string | null }): ImportRowViewDto {
  const data = (r.data ?? {}) as { values?: Record<string, string>; notes?: string[] };
  return { rowNumber: r.rowNumber, status: r.status, values: data.values ?? {}, errors: (r.errors ?? []) as unknown as RowMessage[], notes: data.notes ?? [], createdObjectId: r.createdObjectId };
}
