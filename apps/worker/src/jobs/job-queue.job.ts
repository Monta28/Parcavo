import { Injectable } from '@nestjs/common';
import { Clock, JobsService, ReportExportJobHandler, type JobHandler } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const JOB_QUEUE_TASK = 'file-jobs';
/** Jobs exécutés au plus par réveil (les suivants attendent le réveil suivant, 5 s plus tard). */
export const JOBS_PER_WAKE = 20;
/** Intervalle de la purge des fichiers d'export expirés (conservation 24 h, D-273). */
export const EXPORT_PURGE_INTERVAL_MS = 15 * 60_000;

/**
 * File de jobs PostgreSQL (CDC 11.3, 14.1 ; D-272, D-273) : toutes les 5 s, réserve et exécute les jobs
 * différés (exports de rapports volumineux) par JobsService.runOne, puis purge au plus tous les quarts
 * d'heure les fichiers d'export au-delà de leur durée de conservation.
 */
@Injectable()
export class JobQueueJob implements ScheduledTask {
  readonly name = JOB_QUEUE_TASK;
  readonly periodMs = 5_000;
  readonly leaseMs = 15 * 60_000;
  private readonly handlers: readonly JobHandler[];
  private lastExportPurgeAt: number | null = null;

  constructor(
    private readonly jobs: JobsService,
    private readonly leases: JobLeaseService,
    private readonly clock: Clock,
    private readonly exports: ReportExportJobHandler,
  ) {
    this.handlers = [exports];
  }

  async run(now: Date): Promise<TaskSummary> {
    const summary: Record<string, number> = { termines: 0, reportes: 0, echecs: 0, abandonnes: 0 };
    for (let i = 0; i < JOBS_PER_WAKE; i += 1) {
      const outcome = await this.jobs.runOne(this.handlers, this.leases.holderId);
      if (!outcome) break;
      if (outcome.status === 'TERMINE') summary['termines'] = (summary['termines'] ?? 0) + 1;
      else if (outcome.status === 'EN_ATTENTE') summary['reportes'] = (summary['reportes'] ?? 0) + 1;
      else if (outcome.status === 'ECHEC') summary['echecs'] = (summary['echecs'] ?? 0) + 1;
      else summary['abandonnes'] = (summary['abandonnes'] ?? 0) + 1;
    }
    let exportsPurges = 0;
    const at = now.getTime();
    if (this.lastExportPurgeAt === null || at - this.lastExportPurgeAt >= EXPORT_PURGE_INTERVAL_MS) {
      exportsPurges = await this.exports.purgeExpiredExports();
      this.lastExportPurgeAt = this.clock.now().getTime();
    }
    return { ...summary, exportsPurges };
  }
}
