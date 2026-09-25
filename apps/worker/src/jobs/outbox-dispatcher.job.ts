import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { NotificationOutbox, OutboxStatus } from '@parc-auto/db';
import { APP_ENV, Clock, EMAIL_CHANNEL_NOT_CONFIGURED, NotificationsService, PrismaService, describeErrorSafely, outboxFailureOutcome, outboxLockUntil, redactDeliveryError, type AppEnv } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';
import { createSmtpSender, type MailSender } from './smtp-transport.js';

export const OUTBOX_TASK = 'outbox-envoi';

/** Lignes réservées par lot ; au plus MAX_ROUNDS lots par exécution (une exécution par minute). */
const BATCH_SIZE = 20;
const MAX_ROUNDS = 10;

export type DeliveryOutcome = 'ENVOYE' | 'ECHEC' | 'ABANDONNE' | 'ANNULE' | 'VERROU_PERDU';

export interface DispatchSummary extends TaskSummary {
  canalConfigure: boolean;
  message: string;
  reprises: number;
  abandonneesAuRedemarrage: number;
  reservees: number;
  envoyees: number;
  echecs: number;
  abandonnees: number;
  annulees: number;
  verrousPerdus: number;
}

/**
 * Distributeur de l'outbox e-mail (CDC 9.4 ; D-261, D-263) — chaque minute :
 *  - sans SMTP configuré, rien n'est fait ni prétendu (les lignes éventuelles restent intactes) ;
 *  - reprise : une ligne EN_COURS dont le verrou a expiré (worker arrêté pendant l'envoi) repasse
 *    EN_ATTENTE (ou ABANDONNE si toutes ses tentatives sont consommées) ;
 *  - réservation concurrente sûre : SELECT … FOR UPDATE SKIP LOCKED + verrou lockedUntil de 2 min ;
 *  - revérification du destinataire juste avant l'envoi (NotificationsService.authorizeDelivery) : refus
 *    → ANNULE avec le motif (« droits révoqués »…) ;
 *  - envoi SMTP réel ; succès → ENVOYE (date, identifiant du message) ; échec → ECHEC avec prochaine
 *    tentative (1, 2, 4, 8, 16, 32, 60 min) puis ABANDONNE, erreur expurgée de tout secret.
 * Si le fournisseur accepte un message et que la confirmation est perdue (arrêt entre l'envoi et
 * l'écriture du statut), la ligne est reprise : double livraison exceptionnelle documentée (9.4).
 */
@Injectable()
export class OutboxDispatcherJob implements ScheduledTask, OnModuleDestroy {
  readonly name = OUTBOX_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 2 * 60_000;
  private readonly logger = new Logger(OutboxDispatcherJob.name);
  private sender: MailSender | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly leases: JobLeaseService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  channelConfigured(): boolean {
    return this.env.smtp !== null;
  }

  async run(now: Date): Promise<DispatchSummary> {
    const summary: DispatchSummary = { canalConfigure: this.channelConfigured(), message: this.channelConfigured() ? 'Canal e-mail configuré' : EMAIL_CHANNEL_NOT_CONFIGURED, reprises: 0, abandonneesAuRedemarrage: 0, reservees: 0, envoyees: 0, echecs: 0, abandonnees: 0, annulees: 0, verrousPerdus: 0 };
    if (!this.channelConfigured()) return summary;
    const recovered = await this.recoverExpiredLocks(now);
    summary.reprises = recovered.requeued;
    summary.abandonneesAuRedemarrage = recovered.abandoned;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const ids = await this.claim(this.clock.now(), BATCH_SIZE);
      if (ids.length === 0) break;
      summary.reservees += ids.length;
      for (const id of ids) {
        const outcome = await this.deliver(id);
        if (outcome === 'ENVOYE') summary.envoyees += 1;
        else if (outcome === 'ECHEC') summary.echecs += 1;
        else if (outcome === 'ABANDONNE') summary.abandonnees += 1;
        else if (outcome === 'ANNULE') summary.annulees += 1;
        else summary.verrousPerdus += 1;
      }
    }
    return summary;
  }

  /**
   * Reprise après arrêt : lignes EN_COURS dont le verrou a expiré. Elles redeviennent EN_ATTENTE,
   * éligibles immédiatement, sauf si leur dernière tentative autorisée était en cours (ABANDONNE).
   */
  async recoverExpiredLocks(now: Date): Promise<{ requeued: number; abandoned: number }> {
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string; status: OutboxStatus }>>`
      UPDATE "NotificationOutbox"
      SET "status" = CASE WHEN "attempts" >= "maxAttempts" THEN 'ABANDONNE'::"OutboxStatus" ELSE 'EN_ATTENTE'::"OutboxStatus" END,
          "lastError" = CASE WHEN "attempts" >= "maxAttempts" THEN 'Dernière tentative interrompue (arrêt du worker) : nombre maximal de tentatives atteint.' ELSE "lastError" END,
          "nextAttemptAt" = CASE WHEN "attempts" >= "maxAttempts" THEN "nextAttemptAt" ELSE ${now} END,
          "lockedBy" = NULL,
          "lockedUntil" = NULL,
          "updatedAt" = ${now}
      WHERE "status" = 'EN_COURS' AND "lockedUntil" < ${now}
      RETURNING "id", "status"`;
    return { requeued: rows.filter((r) => r.status === 'EN_ATTENTE').length, abandoned: rows.filter((r) => r.status === 'ABANDONNE').length };
  }

  /**
   * Réserve jusqu'à `limit` lignes échues (EN_ATTENTE ou ECHEC dont la prochaine tentative est passée) en
   * une instruction : deux workers ne réservent jamais la même ligne.
   */
  async claim(now: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      UPDATE "NotificationOutbox"
      SET "status" = 'EN_COURS', "lockedBy" = ${this.leases.holderId}, "lockedUntil" = ${outboxLockUntil(now)}, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "NotificationOutbox"
        WHERE "status" IN ('EN_ATTENTE', 'ECHEC') AND "nextAttemptAt" <= ${now}
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    return rows.map((r) => r.id);
  }

  /** Revérification puis envoi d'une ligne réservée par ce worker ; statut exact écrit sous condition de verrou. */
  async deliver(id: string): Promise<DeliveryOutcome> {
    const holder = this.leases.holderId;
    const row = await this.prisma.client.notificationOutbox.findUnique({ where: { id } });
    if (!row || row.status !== 'EN_COURS' || row.lockedBy !== holder) return 'VERROU_PERDU';
    const decision = await this.notifications.authorizeDelivery(id);
    if (!decision.allowed) {
      await this.finish(row, { status: 'ANNULE', lastError: decision.reason });
      return 'ANNULE';
    }
    // Tentative comptée et verrou prolongé de 2 min juste avant l'envoi : une ligne réservée dans un lot
    // n'arrive jamais à l'envoi avec un verrou déjà expiré (reprise concurrente, double livraison).
    const startedAt = this.clock.now();
    const started = await this.prisma.client.notificationOutbox.updateMany({ where: { id, status: 'EN_COURS', lockedBy: holder }, data: { attempts: { increment: 1 }, lockedUntil: outboxLockUntil(startedAt), updatedAt: startedAt } });
    if (started.count === 0) return 'VERROU_PERDU';
    const attempts = row.attempts + 1;
    try {
      const info = await this.smtp().send({ to: row.recipientEmail, subject: row.subject, text: row.bodyText, outboxId: row.id });
      await this.finish(row, { status: 'ENVOYE', sentAt: this.clock.now(), providerMessageId: info.messageId, lastError: null });
      return 'ENVOYE';
    } catch (error) {
      const failedAt = this.clock.now();
      const lastError = redactDeliveryError(describeErrorSafely(error, this.smtpSecrets())) ?? 'Échec d’envoi sans détail.';
      const outcome = outboxFailureOutcome(attempts, row.maxAttempts, failedAt);
      this.logger.warn(`Envoi de la ligne ${row.id} en échec (tentative ${attempts}/${row.maxAttempts}) : ${lastError}`);
      if (outcome.status === 'ECHEC') await this.finish(row, { status: 'ECHEC', nextAttemptAt: outcome.nextAttemptAt, lastError });
      else await this.finish(row, { status: 'ABANDONNE', lastError });
      return outcome.status;
    }
  }

  onModuleDestroy(): void {
    this.sender?.close();
    this.sender = null;
  }

  private async finish(row: NotificationOutbox, data: { status: OutboxStatus; lastError: string | null; nextAttemptAt?: Date; sentAt?: Date; providerMessageId?: string | null }): Promise<void> {
    await this.prisma.client.notificationOutbox.updateMany({ where: { id: row.id, status: 'EN_COURS', lockedBy: this.leases.holderId }, data: { ...data, lockedBy: null, lockedUntil: null, updatedAt: this.clock.now() } });
  }

  private smtp(): MailSender {
    if (!this.env.smtp) throw new Error('Canal e-mail non configuré.');
    this.sender ??= createSmtpSender(this.env.smtp);
    return this.sender;
  }

  private smtpSecrets(): string[] {
    return [this.env.smtp?.pass, this.env.smtp?.user].filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
}
