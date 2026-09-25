import { Injectable } from '@nestjs/common';
import type { PlanStatus, Prisma } from '@parc-auto/db';
import { PLAN_STATUS_LABELS } from '@parc-auto/contracts';
import { fromDbDate } from '../../../domain/civil-date.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import type { PlansQueryDto } from '../../maintenance/dto/maintenance.dto.js';
import { MaintenancePlansService } from '../../maintenance/maintenance-plans.service.js';
import { COST_STATUS_LABELS, INTERVENTION_KIND_LABELS, KM_SOURCE_LABELS, PLAN_WARNING_LABELS, civilRange, decOrNull, vehicleRelation } from '../report-support.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

/**
 * Entretiens réalisés et à venir (CDC 11.2, 6.2, 6.4). Réalisés : interventions TERMINEE datées dans la
 * période (société historique). À venir : plans actifs, statut et échéances évalués par le service de
 * plans (maintenance-schedule.ts) — restes en km et en jours issus de la même règle, sans formule recopiée.
 */
@Injectable()
export class MaintenanceReportService implements ReportProvider {
  readonly code = 'entretiens' as const;
  readonly label = 'Entretiens réalisés et à venir';
  readonly description = 'Interventions terminées sur la période ; plans d’entretien avec statut, échéances et restes.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'realises', label: 'Réalisés', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'supplierId', 'maintenanceTypeId', 'from', 'to'] },
    { code: 'a-venir', label: 'À venir', period: false, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'maintenanceTypeId', 'status'], statuses: PLAN_STATUS_LABELS },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MaintenancePlansService,
  ) {}

  columns(view: string): ReportColumn[] {
    if (view === 'a-venir') {
      return [
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'maintenanceType', label: 'Opération', unit: null, kind: 'text' },
        { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: PLAN_STATUS_LABELS },
        { key: 'nextDueDate', label: 'Échéance (date)', unit: null, kind: 'date' },
        { key: 'nextDueKm', label: 'Échéance (km)', unit: 'km', kind: 'decimal', decimals: 0 },
        { key: 'remainingDays', label: 'Reste (jours)', unit: 'jours', kind: 'integer' },
        { key: 'remainingKm', label: 'Reste (km)', unit: 'km', kind: 'decimal', decimals: 0 },
        { key: 'currentKm', label: 'Kilométrage retenu', unit: 'km', kind: 'decimal', decimals: 0, missing: 'Inconnu' },
        { key: 'currentKmSource', label: 'Nature du kilométrage', unit: null, kind: 'enum', labels: KM_SOURCE_LABELS, estimates: ['ESTIME_GPS'] },
        { key: 'warnings', label: 'Données manquantes ou anciennes', unit: null, kind: 'text' },
      ];
    }
    return [
      { key: 'performedOn', label: 'Réalisé le', unit: null, kind: 'date' },
      { key: 'reference', label: 'Référence', unit: null, kind: 'text' },
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'kind', label: 'Nature', unit: null, kind: 'enum', labels: INTERVENTION_KIND_LABELS },
      { key: 'operations', label: 'Opérations', unit: null, kind: 'text' },
      { key: 'performedKm', label: 'Kilométrage de réalisation', unit: 'km', kind: 'decimal', decimals: 0 },
      { key: 'supplier', label: 'Prestataire', unit: null, kind: 'text' },
      { key: 'historical', label: 'Saisie historique', unit: null, kind: 'boolean' },
      { key: 'totalAmount', label: 'Montant', unit: null, kind: 'money', cost: true },
      { key: 'costStatus', label: 'État du coût', unit: null, kind: 'enum', labels: COST_STATUS_LABELS, cost: true },
    ];
  }

  notes(view: string): string[] {
    return view === 'a-venir'
      ? ['Statut et restes évalués à la génération avec la règle des plans : le niveau le plus urgent (km ou date) l’emporte ; les données manquantes sont signalées à part.']
      : ['Interventions terminées dont la date effective de réalisation tombe dans la période, rattachées à leur société historique.'];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    return run.view === 'a-venir' ? this.upcoming(run, window) : this.completed(run, window);
  }

  private async completed(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const where: Prisma.InterventionWhereInput = {
      ...scopeWhere(run.scope),
      status: 'TERMINEE',
      performedOn: civilRange(run.period),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      ...(f.maintenanceTypeId ? { tasks: { some: { maintenanceTypeId: f.maintenanceTypeId } } } : {}),
      ...vehicleRelation(f),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.intervention.findMany({
        where,
        orderBy: [{ performedOn: 'desc' }, { reference: 'desc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          companyId: true,
          reference: true,
          kind: true,
          performedOn: true,
          performedKm: true,
          isHistorical: true,
          totalAmount: true,
          costStatus: true,
          vehicle: { select: { code: true, registration: true } },
          supplier: { select: { name: true } },
          tasks: { select: { label: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
      this.prisma.client.intervention.count({ where }),
    ]);
    return {
      total,
      rows: items.map((i) => ({
        id: i.id,
        companyId: i.companyId,
        values: {
          performedOn: fromDbDate(i.performedOn),
          reference: i.reference,
          vehicle: i.vehicle.code,
          registration: i.vehicle.registration,
          company: null,
          kind: i.kind,
          operations: i.tasks.map((t) => t.label).join(' ; ') || null,
          performedKm: decOrNull(i.performedKm),
          supplier: i.supplier?.name ?? null,
          historical: i.isHistorical,
          totalAmount: i.costStatus === 'SAISI' ? decOrNull(i.totalAmount) : null,
          costStatus: i.costStatus,
        },
      })),
    };
  }

  private async upcoming(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    // Statut matérialisé remis à jour au jour local avant de filtrer (transitions de date, D-200) : même
    // chemin que la liste des plans (GET /maintenance-plans), société par société du périmètre.
    for (const companyId of run.scope.companyIds) {
      const refresh: PlansQueryDto = { companyId, page: 1, pageSize: 1, sort: 'vehicule', order: 'asc', ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}) };
      await this.plans.list(run.ctx, refresh);
    }
    const where: Prisma.VehicleMaintenancePlanWhereInput = {
      ...scopeWhere(run.scope),
      active: true,
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.maintenanceTypeId ? { maintenanceTypeId: f.maintenanceTypeId } : {}),
      ...(f.status ? { computedStatus: f.status as PlanStatus } : {}),
      ...vehicleRelation(f),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.vehicleMaintenancePlan.findMany({
        where,
        orderBy: [{ nextDueDate: { sort: 'asc', nulls: 'last' } }, { nextDueKm: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        include: { maintenanceType: { select: { label: true } }, vehicle: { select: { code: true, companyId: true, registration: true } } },
      }),
      this.prisma.client.vehicleMaintenancePlan.count({ where }),
    ]);
    const rows = [];
    for (const p of items) {
      const view = await this.plans.view(p);
      rows.push({
        id: p.id,
        companyId: p.companyId,
        values: {
          vehicle: p.vehicle.code,
          registration: p.vehicle.registration,
          company: null,
          maintenanceType: view.maintenanceTypeLabel,
          status: view.status,
          nextDueDate: view.nextDueDate,
          nextDueKm: decOrNull(view.nextDueKm),
          remainingDays: view.remainingDays,
          remainingKm: decOrNull(view.remainingKm),
          currentKm: decOrNull(view.currentKm),
          currentKmSource: view.currentKmSource,
          warnings: view.warnings.map((w) => PLAN_WARNING_LABELS[w] ?? w).join(' ; ') || null,
        },
      });
    }
    return { rows, total };
  }
}
