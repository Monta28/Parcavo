import { Injectable } from '@nestjs/common';
import { TelemetrySyncService } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const TELEMETRY_WEBHOOK_TASK = 'telematique-webhooks';

/**
 * Ingestion des lots poussés par webhook (CDC 14.4 ; D-298 ; R-14.4-02, R-14.4-X01) : toutes les 10 s,
 * runWebhooks réserve les lots déposés par l'API dans la file persistante et les ingère par la même
 * exécution que la synchronisation (un run WEBHOOK par société activée, ingestion unique et idempotente).
 * Sans fournisseur WEBHOOK actif ni lot en attente, aucune écriture n'est faite : l'application fonctionne
 * entièrement avec F11 désactivé.
 */
@Injectable()
export class TelemetryWebhookJob implements ScheduledTask {
  readonly name = TELEMETRY_WEBHOOK_TASK;
  readonly periodMs = 10_000;
  readonly leaseMs = 15 * 60_000;

  constructor(
    private readonly sync: TelemetrySyncService,
    private readonly leases: JobLeaseService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const result = await this.sync.runWebhooks(now, { holder: this.leases.holderId });
    return {
      lotsTraites: result.processed,
      lotsIgnores: result.ignored,
      lotsRelances: result.retried,
      lotsEnEchec: result.failed,
      lotsReportes: result.deferred,
      lotsRepris: result.recovered,
      lotsPurges: result.purged,
      secretsExpiresSupprimes: result.secretsPurged,
      runs: result.runs.length,
    };
  }
}
