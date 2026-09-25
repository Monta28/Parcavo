import { Injectable } from '@nestjs/common';
import { type DistanceStatus, Prisma, type UsageStatus } from '@parc-auto/db';
import { ASSIGNMENT_STATUS_LABELS, DISTANCE_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { assignmentStatus, currentAssignmentWhere, upcomingAssignmentWhere } from '../../../domain/responsible-assignment.js';
import { returnDelay } from '../../../domain/return-delay.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { NOT_AVAILABLE, decOrNull, personName, vehicleRelation } from '../report-support.js';
import { and, enumEq, inPageOrder, scopeSql, uuidEq, vehicleRelationSql, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

const usageSelect = {
  id: true,
  companyId: true,
  purpose: true,
  status: true,
  checkedOutAt: true,
  expectedReturnAt: true,
  returnedAt: true,
  distanceStatus: true,
  distanceKm: true,
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
  checkoutReading: { select: { isEstimate: true, measurementKind: true } },
  returnReading: { select: { isEstimate: true, measurementKind: true } },
} satisfies Prisma.VehicleUsageSelect;

type UsageRow = Prisma.VehicleUsageGetPayload<{ select: typeof usageSelect }>;

/**
 * Affectations habituelles et utilisations (CDC 11.2, 4.1, 4.3, 4.4) sur une période : objets dont
 * l'intervalle recoupe la période. Distance : valeur validée des relevés de remise et de restitution, ou
 * N/D avec son statut (jamais 0). Retard : returnDelay (tolérance usage.lateReturnToleranceMinutes).
 */
@Injectable()
export class UsageReportService implements ReportProvider {
  readonly code = 'utilisations' as const;
  readonly label = 'Affectations et utilisations';
  readonly description = 'Utilisations (départ, retour prévu et réel, distance validée, retard) et affectations habituelles sur la période.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'utilisations', label: 'Utilisations', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'driverId', 'categoryId', 'from', 'to', 'status', 'distanceStatus', 'lateOnly'], statuses: USAGE_STATUS_LABELS },
    { code: 'affectations', label: 'Affectations habituelles', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'driverId', 'categoryId', 'from', 'to', 'status'], statuses: ASSIGNMENT_STATUS_LABELS },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  columns(view: string): ReportColumn[] {
    if (view === 'affectations') {
      return [
        { key: 'startsAt', label: 'Début', unit: null, kind: 'datetime' },
        { key: 'endsAt', label: 'Fin', unit: null, kind: 'datetime', missing: 'En cours' },
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'driver', label: 'Responsable habituel', unit: null, kind: 'text' },
        { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: ASSIGNMENT_STATUS_LABELS },
        { key: 'endReason', label: 'Motif de fin', unit: null, kind: 'text' },
      ];
    }
    return [
      { key: 'checkedOutAt', label: 'Départ', unit: null, kind: 'datetime' },
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'driver', label: 'Conducteur', unit: null, kind: 'text' },
      { key: 'purpose', label: 'Motif', unit: null, kind: 'text' },
      { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: USAGE_STATUS_LABELS },
      { key: 'expectedReturnAt', label: 'Retour prévu', unit: null, kind: 'datetime' },
      { key: 'returnedAt', label: 'Retour réel', unit: null, kind: 'datetime', missing: 'En cours' },
      { key: 'distanceKm', label: 'Distance validée', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3, missing: NOT_AVAILABLE },
      { key: 'distanceStatus', label: 'Statut de la distance', unit: null, kind: 'enum', labels: DISTANCE_STATUS_LABELS },
      { key: 'late', label: 'En retard', unit: null, kind: 'boolean' },
      { key: 'delayMinutes', label: 'Retard', unit: 'minutes', kind: 'integer' },
    ];
  }

  notes(view: string): string[] {
    return view === 'affectations'
      ? ['Affectations dont la période recoupe l’intervalle demandé ; état (à venir, en cours, terminée) évalué à la génération.']
      : [
          'Utilisations dont la période (départ → retour réel, ou en cours) recoupe l’intervalle demandé.',
          'Distance : différence des kilomètres cumulés validés entre remise et restitution ; sinon N/D avec son statut.',
          'Retard : retour réel (ou maintenant) au-delà du retour prévu augmenté de la tolérance de la société.',
        ];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    return run.view === 'affectations' ? this.assignments(run, window) : this.usages(run, window);
  }

  private async usages(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const period = run.period;
    const where: Prisma.VehicleUsageWhereInput = {
      ...scopeWhere(run.scope),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.driverId ? { driverId: f.driverId } : {}),
      ...(f.status ? { status: f.status as UsageStatus } : {}),
      ...(f.distanceStatus ? { distanceStatus: f.distanceStatus as DistanceStatus } : {}),
      ...vehicleRelation(f),
      ...(period ? { checkedOutAt: { lte: period.end }, OR: [{ returnedAt: null }, { returnedAt: { gte: period.start } }] } : {}),
    };
    const orderBy: Prisma.VehicleUsageOrderByWithRelationInput[] = [{ checkedOutAt: 'desc' }, { id: 'asc' }];
    const tolerance = await this.toleranceResolver(run);
    const lateOf = async (u: UsageRow) => returnDelay({ expectedReturnAt: u.expectedReturnAt, returnedAt: u.returnedAt, now: run.now, toleranceMinutes: await tolerance(u.companyId) });
    if (f.lateOnly === 'true') return this.lateUsages(run, window, lateOf);
    const [items, total] = await Promise.all([this.prisma.client.vehicleUsage.findMany({ where, orderBy, select: usageSelect, skip: window.skip, take: window.take }), this.prisma.client.vehicleUsage.count({ where })]);
    const rows = [];
    for (const u of items) rows.push(this.usageRow(u, await lateOf(u)));
    return { rows, total };
  }

  /**
   * Utilisations en retard, paginées en base. Le retard (returnDelay : retour réel ou maintenant au-delà du
   * retour prévu augmenté de la tolérance de la société, bornée à 0) est traduit en SQL avec la tolérance de
   * chaque société du périmètre ; les valeurs affichées de la page sont recalculées par returnDelay.
   */
  private async lateUsages(run: ReportRun, window: ReportWindow, lateOf: (u: UsageRow) => Promise<ReturnType<typeof returnDelay>>): Promise<ReportResult> {
    const f = run.filters;
    const period = run.period;
    const companyIds = [...run.scope.companyIds];
    const tolerances = await Promise.all(companyIds.map((companyId) => this.settings.get(run.scope.organizationId, 'usage.lateReturnToleranceMinutes', companyId)));
    const filtered = Prisma.sql`
      FROM "VehicleUsage" "u"
      JOIN "Vehicle" "v" ON "v"."id" = "u"."vehicleId"
      JOIN unnest(${companyIds}::uuid[], ${tolerances}::int[]) AS "tol"("companyId", "minutes") ON "tol"."companyId" = "u"."companyId"
      WHERE ${and([
        scopeSql('u', run.scope),
        uuidEq('u', 'vehicleId', f.vehicleId),
        uuidEq('u', 'driverId', f.driverId),
        enumEq('u', 'status', 'UsageStatus', f.status),
        enumEq('u', 'distanceStatus', 'DistanceStatus', f.distanceStatus),
        ...vehicleRelationSql('v', f),
        period ? Prisma.sql`"u"."checkedOutAt" <= ${period.end}::timestamptz AND ("u"."returnedAt" IS NULL OR "u"."returnedAt" >= ${period.start}::timestamptz)` : null,
        Prisma.sql`COALESCE("u"."returnedAt", ${run.now}::timestamptz) - "u"."expectedReturnAt" > make_interval(mins => GREATEST("tol"."minutes", 0))`,
      ])}`;
    const [ids, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ id: string }>>`SELECT "u"."id" ${filtered} ORDER BY "u"."checkedOutAt" DESC, "u"."id" ASC ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS "total" ${filtered}`,
    ]);
    const keys = ids.map((r) => r.id);
    const items = keys.length ? inPageOrder(keys, await this.prisma.client.vehicleUsage.findMany({ where: { id: { in: keys } }, select: usageSelect }), (u) => u.id) : [];
    const rows = [];
    for (const u of items) rows.push(this.usageRow(u, await lateOf(u)));
    return { rows, total: counted[0]?.total ?? 0 };
  }

  private usageRow(u: UsageRow, delay: ReturnType<typeof returnDelay>) {
    return {
      id: u.id,
      companyId: u.companyId,
      values: {
        checkedOutAt: u.checkedOutAt,
        vehicle: u.vehicle.code,
        registration: u.vehicle.registration,
        company: null,
        driver: personName(u.driver),
        purpose: u.purpose,
        status: u.status,
        expectedReturnAt: u.expectedReturnAt,
        returnedAt: u.returnedAt,
        distanceKm: u.distanceStatus === 'VALIDEE' ? decOrNull(u.distanceKm) : null,
        distanceStatus: u.distanceStatus,
        late: delay.late,
        delayMinutes: delay.delayMinutes,
      },
    };
  }

  private async assignments(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const period = run.period;
    // État calculé par la règle unique (responsible-assignment.ts) et ses traductions SQL ; TERMINEE = ni en cours ni à venir.
    const statusWhere: Prisma.VehicleResponsibleAssignmentWhereInput =
      f.status === 'EN_COURS'
        ? currentAssignmentWhere(run.now)
        : f.status === 'A_VENIR'
          ? upcomingAssignmentWhere(run.now)
          : f.status === 'TERMINEE'
            ? { NOT: [currentAssignmentWhere(run.now), upcomingAssignmentWhere(run.now)] }
            : {};
    const where: Prisma.VehicleResponsibleAssignmentWhereInput = {
      ...scopeWhere(run.scope),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.driverId ? { driverId: f.driverId } : {}),
      ...vehicleRelation(f),
      AND: [statusWhere, ...(period ? [{ startsAt: { lte: period.end } }, { OR: [{ endsAt: null }, { endsAt: { gte: period.start } }] }] : [])],
    };
    const [items, total] = await Promise.all([
      this.prisma.client.vehicleResponsibleAssignment.findMany({
        where,
        orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        select: { id: true, companyId: true, startsAt: true, endsAt: true, endReason: true, vehicle: { select: { code: true, registration: true } }, driver: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.client.vehicleResponsibleAssignment.count({ where }),
    ]);
    return {
      total,
      rows: items.map((a) => ({
        id: a.id,
        companyId: a.companyId,
        values: {
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          vehicle: a.vehicle.code,
          registration: a.vehicle.registration,
          company: null,
          driver: personName(a.driver),
          status: assignmentStatus(a, run.now),
          endReason: a.endReason,
        },
      })),
    };
  }

  /** Tolérance de retard par société (paramètre surchargeable), lue une fois par exécution. */
  private async toleranceResolver(run: ReportRun): Promise<(companyId: string) => Promise<number>> {
    const cache = new Map<string, number>();
    return async (companyId: string) => {
      const cached = cache.get(companyId);
      if (cached !== undefined) return cached;
      const value = await this.settings.get(run.scope.organizationId, 'usage.lateReturnToleranceMinutes', companyId);
      cache.set(companyId, value);
      return value;
    };
  }
}
