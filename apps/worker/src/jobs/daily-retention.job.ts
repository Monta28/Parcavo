import { Injectable, Logger } from '@nestjs/common';
import { DAY_MS, ImportRetentionService, PrismaService, TelemetryPurgeService, describeErrorSafely, scheduledRunKey, slotStart } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import { ScheduledRunsService } from '../scheduler/scheduled-runs.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const DAILY_RETENTION_TASK = 'retention-quotidienne';
export const DAILY_RETENTION_JOB_TYPE = 'planifie.retention-quotidienne';
/** Partitions mensuelles préparées à l'avance, à partir du mois suivant (17.2). */
export const PARTITION_MONTHS_AHEAD = 3;
const PARTITIONED_TABLES = ['TelemetryOdometerSample', 'FuelLevelSample'] as const;

/**
 * Rétention quotidienne (CDC 8.5, 12.1, 17.2 ; D-174, D-279, D-319) — une fois par jour UTC (créneau
 * dédupliqué) : création des partitions mensuelles des trois mois suivants (le mois courant reste dans la
 * partition par défaut s'il y a déjà des lignes), purge des échantillons télématiques au-delà de leur
 * rétention, abandon des lots d'import non confirmés depuis 7 jours et purge des données brutes des lots
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
    private readonly prisma: PrismaService,
    private readonly runs: ScheduledRunsService,
    private readonly leases: JobLeaseService,
    private readonly telemetryPurge: TelemetryPurgeService,
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
    await step('partitions', async () => ({ partitionsCreees: await this.ensurePartitions(now) }));
    await step('echantillons', async () => {
      const r = await this.telemetryPurge.purgeSamples(now);
      return { echantillonsCarburant: r.fuelSamples, echantillonsOdometre: r.odometerSamples, partitionsSupprimees: r.droppedPartitions };
    });
    await step('imports', async () => {
      const r = await this.imports.run(now);
      return { ...r };
    });
    if (errors.length > 0) throw new Error(`Étapes en échec : ${errors.join(' ; ')}`);
    return summary;
  }

  /** Partitions des mois suivants (fonction SQL ensure_month_partitions, idempotente). */
  private async ensurePartitions(now: Date): Promise<number> {
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    let created = 0;
    for (const table of PARTITIONED_TABLES) {
      const rows = await this.prisma.client.$queryRaw<Array<{ created: number }>>`SELECT ensure_month_partitions(${table}, ${nextMonth}::date, ${PARTITION_MONTHS_AHEAD}::integer) AS created`;
      created += Number(rows[0]?.created ?? 0);
    }
    return created;
  }
}
