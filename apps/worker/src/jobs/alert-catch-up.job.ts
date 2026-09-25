import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentsService,
  ImmobilizationsService,
  MaintenancePlansService,
  OdometerFreshnessService,
  PrismaService,
  ReservationsService,
  SettingsService,
  UsagesService,
  catchUpPeriodMs,
  describeErrorSafely,
  scheduledRunKey,
  slotStart,
} from '@parc-auto/api';
import { JobLeaseService } from '../scheduler/job-lease.service.js';
import { ScheduledRunsService } from '../scheduler/scheduled-runs.service.js';
import type { ScheduledTask, TaskSummary } from './scheduled-task.js';

export const ALERT_CATCH_UP_TASK = 'alertes-rattrapage';
export const ALERT_CATCH_UP_JOB_TYPE = 'planifie.alertes-rattrapage';

type StepResult = number | { late: number; compromised: number };

/**
 * Rattrapage des alertes (CDC 9.3 ; D-200, D-254, D-257) : toutes les alerts.catchUpIntervalMinutes
 * (15 par défaut, créneaux alignés :00/:15/:30/:45 UTC), par organisation, recalcule les échéances
 * d'entretien, la conformité documentaire, la fraîcheur du kilométrage, les retours dépassés, les
 * réservations non honorées et les immobilisations actives. Chaque créneau s'exécute une seule fois
 * (Job dédupliqué) ; un créneau manqué pendant un arrêt est rattrapé au redémarrage. Les évaluations sont
 * idempotentes (alertes dédupliquées).
 */
@Injectable()
export class AlertCatchUpJob implements ScheduledTask {
  readonly name = ALERT_CATCH_UP_TASK;
  readonly periodMs = 60_000;
  readonly leaseMs = 5 * 60_000;
  private readonly logger = new Logger(AlertCatchUpJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly runs: ScheduledRunsService,
    private readonly leases: JobLeaseService,
    private readonly plans: MaintenancePlansService,
    private readonly documents: DocumentsService,
    private readonly freshness: OdometerFreshnessService,
    private readonly usages: UsagesService,
    private readonly reservations: ReservationsService,
    private readonly immobilizations: ImmobilizationsService,
  ) {}

  async run(now: Date): Promise<TaskSummary> {
    const organizations = await this.prisma.client.organization.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    const outcomes: Array<Record<string, string | number | boolean | null>> = [];
    let executed = 0;
    let skipped = 0;
    let failed = 0;
    for (const org of organizations) {
      const periodMs = catchUpPeriodMs(await this.settings.get(org.id, 'alerts.catchUpIntervalMinutes'));
      const slot = slotStart(now, periodMs);
      const outcome = await this.runs.runOnce({ type: ALERT_CATCH_UP_JOB_TYPE, dedupeKey: scheduledRunKey(ALERT_CATCH_UP_TASK, slot, org.id), organizationId: org.id, holder: this.leases.holderId, staleAfterMs: periodMs }, () => this.catchUp(org.id));
      if (outcome.status === 'DEJA_FAIT') {
        skipped += 1;
        continue;
      }
      if (outcome.status === 'TERMINE') executed += 1;
      else failed += 1;
      outcomes.push({ organizationId: org.id, slot: slot.toISOString(), status: outcome.status, ...(outcome.status === 'TERMINE' ? outcome.result : { error: outcome.error }) });
    }
    return { organizations: organizations.length, executed, skipped, failed, outcomes };
  }

  /** Rattrapage d'une organisation : chaque étape est isolée ; une étape en échec n'empêche pas les autres. */
  async catchUp(organizationId: string): Promise<Record<string, number>> {
    const steps: Array<[string, () => Promise<StepResult>]> = [
      ['plansRecalcules', () => this.plans.recomputeAll(organizationId)],
      ['objetsDocumentairesEvalues', () => this.documents.evaluateAll(organizationId)],
      ['vehiculesFraicheurEvalues', () => this.freshness.evaluateAll(organizationId)],
      ['retours', () => this.usages.evaluateLateReturns(organizationId)],
      ['reservationsNonHonorees', () => this.reservations.expireUnconverted(organizationId)],
      ['immobilisationsEvaluees', () => this.immobilizations.evaluateActive(organizationId)],
    ];
    const summary: Record<string, number> = {};
    const errors: string[] = [];
    for (const [label, step] of steps) {
      try {
        const value = await step();
        if (typeof value === 'number') summary[label] = value;
        else {
          summary['retoursEnRetard'] = value.late;
          summary['reservationsCompromises'] = value.compromised;
        }
      } catch (error) {
        const message = describeErrorSafely(error);
        this.logger.error(`Rattrapage ${label} (organisation ${organizationId}) en échec : ${message}`);
        errors.push(`${label} : ${message}`);
      }
    }
    if (errors.length > 0) throw new Error(`Étapes en échec : ${errors.join(' ; ')}`);
    return summary;
  }
}
