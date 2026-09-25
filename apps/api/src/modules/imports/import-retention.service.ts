import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock.js';
import { describeErrorSafely } from '../../common/secret-redaction.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { ObjectStorage } from '../../infra/storage.service.js';

const DAY_MS = 86_400_000;
/** Un lot non confirmé est abandonné automatiquement 7 jours après son téléversement (D-279). */
export const IMPORT_ABANDON_AFTER_DAYS = 7;
/** Les données brutes des lignes et le fichier source sont purgés 90 jours après la fin du lot (D-279). */
export const IMPORT_DATA_RETENTION_DAYS = 90;
/** Borne de lots traités par passage (le worker repasse au créneau suivant). */
const BATCH_LIMIT = 200;

export interface ImportRetentionResult {
  lotsAbandonnes: number;
  lotsPurges: number;
  lignesPurgees: number;
  fichiersSupprimes: number;
}

/**
 * Rétention des imports (CDC 12.1, 17.2 ; D-279), appelée par le worker : abandon automatique des lots
 * restés TELEVERSE ou CONTROLE plus de 7 jours (audit système), puis, 90 jours après la fin du lot
 * (confirmation ou abandon), effacement des valeurs brutes des lignes (ImportRow.data) et du fichier
 * source privé. Le statut, les messages d'erreur et le rapport du lot sont conservés. Idempotente.
 */
@Injectable()
export class ImportRetentionService {
  private readonly logger = new Logger(ImportRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  async run(now: Date = this.clock.now()): Promise<ImportRetentionResult> {
    const lotsAbandonnes = await this.abandonStale(now);
    const purge = await this.purgeFinished(now);
    return { lotsAbandonnes, ...purge };
  }

  /** Lots non confirmés depuis plus de 7 jours : ABANDONNE, avec version incrémentée et audit système. */
  async abandonStale(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - IMPORT_ABANDON_AFTER_DAYS * DAY_MS);
    const stale = await this.prisma.client.importBatch.findMany({ where: { status: { in: ['TELEVERSE', 'CONTROLE'] }, createdAt: { lt: cutoff } }, select: { id: true, organizationId: true, status: true }, orderBy: { createdAt: 'asc' }, take: BATCH_LIMIT });
    let abandoned = 0;
    for (const batch of stale) {
      const done = await this.prisma.client.$transaction(async (tx) => {
        // Condition sur le statut : une confirmation concurrente l'emporte, le lot n'est alors pas abandonné.
        const updated = await tx.importBatch.updateMany({ where: { id: batch.id, status: { in: ['TELEVERSE', 'CONTROLE'] } }, data: { status: 'ABANDONNE', version: { increment: 1 }, updatedAt: now } });
        if (updated.count === 0) return false;
        await this.audit.recordSystem(batch.organizationId, { action: 'import.abandon', objectType: 'ImportBatch', objectId: batch.id, companyId: null, before: { status: batch.status }, after: { status: 'ABANDONNE' }, reason: `lot non confirmé depuis plus de ${IMPORT_ABANDON_AFTER_DAYS} jours` }, tx);
        return true;
      });
      if (done) abandoned += 1;
    }
    return abandoned;
  }

  /**
   * Lots terminés depuis plus de 90 jours (confirmés : committedAt ; abandonnés : updatedAt) : valeurs des
   * lignes remplacées par un objet vide et fichier source supprimé du stockage (pièce jointe marquée supprimée).
   */
  async purgeFinished(now: Date): Promise<Omit<ImportRetentionResult, 'lotsAbandonnes'>> {
    const cutoff = new Date(now.getTime() - IMPORT_DATA_RETENTION_DAYS * DAY_MS);
    // Seuls les lots dont il reste des données (ligne non vidée ou fichier présent) : un lot déjà purgé n'est plus relu.
    const finished = await this.prisma.client.$queryRaw<Array<{ id: string; attachmentId: string }>>`
      SELECT b."id", b."attachmentId"
      FROM "ImportBatch" b
      WHERE ((b."status" = 'CONFIRME' AND b."committedAt" < ${cutoff}) OR (b."status" = 'ABANDONNE' AND b."updatedAt" < ${cutoff}))
        AND (EXISTS (SELECT 1 FROM "ImportRow" r WHERE r."batchId" = b."id" AND r."data" <> '{}'::jsonb)
             OR EXISTS (SELECT 1 FROM "Attachment" a WHERE a."id" = b."attachmentId" AND a."deletedAt" IS NULL))
      ORDER BY b."createdAt" ASC
      LIMIT ${BATCH_LIMIT}`;
    let lotsPurges = 0;
    let lignesPurgees = 0;
    let fichiersSupprimes = 0;
    for (const batch of finished) {
      const rows = await this.prisma.client.importRow.updateMany({ where: { batchId: batch.id, NOT: { data: { equals: {} } } }, data: { data: {} } });
      lignesPurgees += rows.count;
      const attachment = await this.prisma.client.attachment.findFirst({ where: { id: batch.attachmentId, deletedAt: null }, select: { id: true, storageKey: true } });
      if (attachment) {
        try {
          await this.storage.remove(attachment.storageKey);
          await this.prisma.client.attachment.updateMany({ where: { id: attachment.id, deletedAt: null }, data: { deletedAt: now } });
          fichiersSupprimes += 1;
        } catch (error) {
          this.logger.error(`Fichier source du lot ${batch.id} non supprimé : ${describeErrorSafely(error)}`);
        }
      }
      if (rows.count > 0 || attachment) lotsPurges += 1;
    }
    return { lotsPurges, lignesPurgees, fichiersSupprimes };
  }
}
