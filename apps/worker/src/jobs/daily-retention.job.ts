import { Injectable, Logger } from '@nestjs/common';
import { DAY_MS, ImportRetentionService, describeErrorSafely, scheduledRunKey, slotStart } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import { ScheduledRunsService } from '../scheduler/scheduled-runs.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const DAILY_RETENTION_TASK = 'retention-quotidienne';
export const DAILY_RETENTION_JOB_TYPE = 'planifie.retention-quotidienne';

/**
 * Rétention quotidienne (CDC 8.5, 12.1, 17.2 ; D-174, D-279, D-319) — une fois par jour UTC (créneau
 * dédupliqué) : abandon des lots d'import non confirmés depuis 7 jours et purge des données brutes des lots
 * terminés depuis 90 jours. Chaque étape est isolée ; une étape en échec fait échouer le créneau, repris
 * au créneau suivant, sans empêcher les autres étapes.
 */
@Injectable()
export class DailyRetentionJob implements ScheduledTask {
  readonly name = DAILY_RETENTION_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 30 * 60_000;
  private readonly logger = new Logger(DailyRetentionJob.name);

  constructor(
    private readonly runs: ScheduledRunsService,
    private readonly leases: JobLeaseService,
    private readonly imports: ImportRetentionService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const slot = slotStart(now, DAY_MS);
    const outcome = await this.runs.runOnce({ type: DAILY_RETENTION_JOB_TYPE, dedupeKey: scheduledRunKey(DAILY_RETENTION_TASK, slot), organizationId: null, holder: this.leases.holderId, staleAfterMs: this.leaseMs }, () => this.retain(now));
    return { creneau: slot.toISOString(), statut: outcome.status, ...(outcome.status === 'TERMINE' ? outcome.result : {}), ...(outcome.status === 'ECHEC' ? { erreur: outcome.error } : {}) };
  }

  async retain(now: Date): Promise<Record<string, number>> {
    const summary: Record<string, number> = {};
    const errors: string[] = [];
    const step = async (label: string, work: () => Promise<Record<string, number>>): Promise<void> => {
      try {
        Object.assign(summary, await work());
      } catch (error) {
        const message = describeErrorSafely(error);
        this.logger.error(`Rétention ${label} en échec : ${message}`);
        errors.push(`${label} : ${message}`);
      }
    };
    await step('imports', async () => {
      const r = await this.imports.run(now);
      return { ...r };
    });
    if (errors.length > 0) throw new Error(`Étapes en échec : ${errors.join(' ; ')}`);
    return summary;
  }
}
