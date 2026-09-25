import { Injectable } from '@nestjs/common';
import { AttachmentsService, DAY_MS, IdempotencyService, PrismaService, SessionService, scheduledRunKey, slotStart } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import { ScheduledRunsService } from '../scheduler/scheduled-runs.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const DAILY_PURGE_TASK = 'purge-quotidienne';
export const DAILY_PURGE_JOB_TYPE = 'planifie.purge-quotidienne';
/** Conservation des tentatives de connexion (limitation persistante, 16.1). */
export const LOGIN_ATTEMPT_RETENTION_DAYS = 30;
/** Conservation des traces d'exécutions planifiées terminées. */
export const SCHEDULED_RUN_RETENTION_DAYS = 30;
/** Borne du nombre de lots de fichiers temporaires traités par exécution. */
const MAX_ATTACHMENT_ROUNDS = 50;

/**
 * Purge quotidienne (CDC 15.3, 16.1, 16.2 ; D-286) — une fois par jour UTC (créneau dédupliqué) : clés
 * d'idempotence expirées, sessions expirées ou révoquées depuis plus de 30 jours, tentatives de
 * connexion de plus de 30 jours, pièces jointes temporaires jamais rattachées depuis plus de 24 h
 * (fichier supprimé du stockage, deletedAt renseigné) et traces d'exécutions planifiées anciennes.
 */
@Injectable()
export class DailyPurgeJob implements ScheduledTask {
  readonly name = DAILY_PURGE_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 10 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ScheduledRunsService,
    private readonly leases: JobLeaseService,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionService,
    private readonly attachments: AttachmentsService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const slot = slotStart(now, DAY_MS);
    const outcome = await this.runs.runOnce({ type: DAILY_PURGE_JOB_TYPE, dedupeKey: scheduledRunKey(DAILY_PURGE_TASK, slot), organizationId: null, holder: this.leases.holderId, staleAfterMs: this.leaseMs }, () => this.purge(now));
    return { creneau: slot.toISOString(), statut: outcome.status, ...(outcome.status === 'TERMINE' ? outcome.result : {}), ...(outcome.status === 'ECHEC' ? { erreur: outcome.error } : {}) };
  }

  async purge(now: Date): Promise<Record<string, number>> {
    const idempotence = await this.idempotency.purgeExpired();
    const sessions = await this.sessions.purge();
    const loginCutoff = new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_DAYS * DAY_MS);
    const tentativesConnexion = (await this.prisma.client.loginAttempt.deleteMany({ where: { createdAt: { lt: loginCutoff } } })).count;
    let piecesJointesTemporaires = 0;
    for (let round = 0; round < MAX_ATTACHMENT_ROUNDS; round += 1) {
      const removed = await this.attachments.purgeAbandoned();
      piecesJointesTemporaires += removed;
      if (removed === 0) break;
    }
    const runsCutoff = new Date(now.getTime() - SCHEDULED_RUN_RETENTION_DAYS * DAY_MS);
    const executionsPlanifiees = (await this.prisma.client.job.deleteMany({ where: { type: { startsWith: 'planifie.' }, finishedAt: { lt: runsCutoff } } })).count;
    return { idempotence, sessions, tentativesConnexion, piecesJointesTemporaires, executionsPlanifiees };
  }
}
