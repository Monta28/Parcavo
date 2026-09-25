import { Injectable } from '@nestjs/common';
import { TelemetrySyncService } from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const TELEMETRY_SYNC_TASK = 'telematique-synchro';

/**
 * Synchronisation télématique F11 (CDC 14.1 à 14.6 ; D-296, D-297) : chaque minute, runDue exécute les
 * synchronisations échues des fournisseurs ACTIFS et activés pour au moins une société (intervalle,
 * reprises, coupe-circuit et baux par couple fournisseur/société gérés par le service), puis évalue les
 * sources muettes. Sans fournisseur actif, aucun appel externe n'est fait : l'application fonctionne
 * entièrement avec F11 désactivé.
 */
@Injectable()
export class TelemetrySyncJob implements ScheduledTask {
  readonly name = TELEMETRY_SYNC_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 15 * 60_000;

  constructor(
    private readonly sync: TelemetrySyncService,
    private readonly leases: JobLeaseService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const result = await this.sync.runDue(now, { holder: this.leases.holderId });
    const byStatus: Record<string, number> = {};
    for (const run of result.runs) byStatus[`runs_${run.status}`] = (byStatus[`runs_${run.status}`] ?? 0) + 1;
    return {
      runs: result.runs.length,
      ...byStatus,
      couplesVerrouilles: result.lockedPairs,
      decouvertes: result.discoveries,
      runsInterrompusRepris: result.interrupted,
      sourcesMuettes: result.silence.silentMappings,
      fournisseursInjoignables: result.silence.unreachableProviders,
      alertesResolues: result.silence.resolved,
    };
  }
}
