import { Injectable } from '@nestjs/common';
import { Prisma, type ReadingSource, type ReadingStatus } from '@parc-auto/db';
import { FRESHNESS_LABELS, MEASUREMENT_KIND_LABELS, READING_CONTEXT_LABELS, READING_SOURCE_LABELS, READING_STATUS_LABELS } from '@parc-auto/contracts';
import { computeFreshness, staleBefore } from '../../../domain/freshness.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { CORRECTION_LABELS, MEASURE_NATURE_LABELS, decOrNull, instantRange, isEstimateReading, personName, vehicleRelation } from '../report-support.js';
import { TEXT_ORDER, and, scopeSql, uuidEq, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

/** Ordre de la vue qualité : véhicules sans relevé accepté, puis kilométrage ancien, puis à jour. */
const FRESHNESS_ORDER: Record<string, number> = { INCONNU: 0, A_ACTUALISER: 1, A_JOUR: 2 };

/**
 * Relevés et qualité des données (CDC 11.2, 5.5, 5.6) : relevés de la période avec statut, source, nature
 * (les distances GPS sont marquées « estimation »), corrections ; et, par véhicule, fraîcheur du
 * kilométrage (INCONNU / A_ACTUALISER) avec les relevés en attente, rejetés, corrigés et estimés.
 */
@Injectable()
export class ReadingsReportService implements ReportProvider {
  readonly code = 'releves' as const;
  readonly label = 'Relevés et qualité des données';
  readonly description = 'Relevés kilométriques (en attente, rejetés, corrigés, estimations GPS) et fraîcheur du kilométrage par véhicule.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'releves', label: 'Relevés de la période', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'from', 'to', 'status', 'source'], statuses: READING_STATUS_LABELS },
    { code: 'qualite', label: 'Qualité par véhicule', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'from', 'to', 'freshness'] },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  columns(view: string): ReportColumn[] {
    if (view === 'qualite') {
      return [
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'site', label: 'Site', unit: null, kind: 'text' },
        { key: 'freshness', label: 'Fraîcheur du kilométrage', unit: null, kind: 'enum', labels: FRESHNESS_LABELS },
        { key: 'lastObservedAt', label: 'Dernier relevé accepté', unit: null, kind: 'datetime', missing: 'Aucun' },
        { key: 'ageDays', label: 'Âge du dernier relevé', unit: 'jours', kind: 'integer' },
        { key: 'pendingCount', label: 'Relevés en attente', unit: null, kind: 'integer' },
        { key: 'rejectedCount', label: 'Rejetés (période)', unit: null, kind: 'integer' },
        { key: 'correctedCount', label: 'Corrigés (période)', unit: null, kind: 'integer' },
        { key: 'estimatedCount', label: 'Estimations GPS acceptées (période)', unit: null, kind: 'integer' },
      ];
    }
    return [
      { key: 'observedAt', label: 'Observé le', unit: null, kind: 'datetime' },
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'source', label: 'Source', unit: null, kind: 'enum', labels: READING_SOURCE_LABELS },
      { key: 'context', label: 'Contexte', unit: null, kind: 'enum', labels: READING_CONTEXT_LABELS },
      { key: 'measurementKind', label: 'Mesure', unit: null, kind: 'enum', labels: MEASUREMENT_KIND_LABELS, estimates: ['DISTANCE_GPS'] },
      { key: 'nature', label: 'Nature', unit: null, kind: 'enum', labels: MEASURE_NATURE_LABELS, estimates: ['ESTIMATION'] },
      { key: 'physicalKm', label: 'Compteur affiché', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3 },
      { key: 'cumulativeKm', label: 'Kilométrage cumulé', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3 },
      { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: READING_STATUS_LABELS },
      { key: 'statusReason', label: 'Motif', unit: null, kind: 'text' },
      { key: 'correction', label: 'Correction', unit: null, kind: 'enum', labels: CORRECTION_LABELS },
      { key: 'correctionReason', label: 'Motif de correction', unit: null, kind: 'text' },
      { key: 'enteredAt', label: 'Saisi le', unit: null, kind: 'datetime' },
      { key: 'author', label: 'Saisi par', unit: null, kind: 'text' },
    ];
  }

  notes(view: string): string[] {
    return view === 'qualite'
      ? ['Fraîcheur : aucun relevé accepté = inconnu ; dernière observation acceptée au-delà du seuil de la société = à actualiser.', 'Compteurs de rejets, corrections et estimations limités à la période ; relevés en attente à l’instant de génération.']
      : ['Une distance GPS (odomètre virtuel calibré) est une estimation, jamais un relevé compteur.', 'Un relevé corrigé reste visible avec le statut « Remplacé » ; sa correction figure sur une ligne distincte.'];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    return run.view === 'qualite' ? this.quality(run, window) : this.readings(run, window);
  }

  private async readings(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const where: Prisma.OdometerReadingWhereInput = {
      ...scopeWhere(run.scope),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.status ? { status: f.status as ReadingStatus } : {}),
      ...(f.source ? { source: f.source as ReadingSource } : {}),
      ...vehicleRelation(f),
      observedAt: instantRange(run.period),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.odometerReading.findMany({
        where,
        orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          companyId: true,
          source: true,
          context: true,
          measurementKind: true,
          status: true,
          physicalKm: true,
          cumulativeKm: true,
          isEstimate: true,
          observedAt: true,
          enteredAt: true,
          statusReason: true,
          replacesReadingId: true,
          correctionReason: true,
          createdById: true,
          vehicle: { select: { code: true, registration: true } },
        },
      }),
      this.prisma.client.odometerReading.count({ where }),
    ]);
    const authorIds = [...new Set(items.map((r) => r.createdById).filter((id): id is string => id !== null))];
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds }, organizationId: run.scope.organizationId }, select: { id: true, firstName: true, lastName: true } }) : [];
    return {
      total,
      rows: items.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        values: {
          observedAt: r.observedAt,
          vehicle: r.vehicle.code,
          registration: r.vehicle.registration,
          company: null,
          source: r.source,
          context: r.context,
          measurementKind: r.measurementKind,
          nature: isEstimateReading(r) ? 'ESTIMATION' : 'MESURE',
          physicalKm: decOrNull(r.physicalKm),
          cumulativeKm: decOrNull(r.cumulativeKm),
          status: r.status,
          statusReason: r.statusReason,
          correction: r.status === 'REMPLACE' ? 'CORRIGE' : r.replacesReadingId ? 'CORRECTION' : null,
          correctionReason: r.correctionReason,
          enteredAt: r.enteredAt,
          author: r.source === 'TELEMATICS' ? 'Connecteur télématique' : personName(authors.find((a) => a.id === r.createdById)),
        },
      })),
    };
  }

  /**
   * Qualité par véhicule, paginée en base : fraîcheur (dernier relevé accepté comparé à la limite staleBefore
   * du seuil de chaque société, freshness.ts), tri (INCONNU, A_ACTUALISER, A_JOUR puis code) et page calculés
   * par PostgreSQL ; compteurs et fraîcheur affichée des seuls véhicules de la page (computeFreshness).
   */
  private async quality(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const companyIds = [...run.scope.companyIds];
    const staleAfter = await Promise.all(companyIds.map((companyId) => this.settings.get(run.scope.organizationId, 'odometer.staleAfterDays', companyId)));
    const staleDays = new Map(companyIds.map((companyId, i) => [companyId, staleAfter[i] as number]));
    const limits = staleAfter.map((days) => staleBefore(run.now, days));
    const rank = Prisma.sql`CASE WHEN "last"."observedAt" IS NULL THEN ${FRESHNESS_ORDER['INCONNU']}::int WHEN "last"."observedAt" < "stale"."before" THEN ${FRESHNESS_ORDER['A_ACTUALISER']}::int ELSE ${FRESHNESS_ORDER['A_JOUR']}::int END`;
    const filtered = Prisma.sql`
      FROM "Vehicle" "v"
      JOIN unnest(${companyIds}::uuid[], ${limits}::timestamptz[]) AS "stale"("companyId", "before") ON "stale"."companyId" = "v"."companyId"
      LEFT JOIN LATERAL (SELECT MAX("r"."observedAt") AS "observedAt" FROM "OdometerReading" "r" WHERE "r"."vehicleId" = "v"."id" AND "r"."status" = 'ACCEPTE'::"ReadingStatus") "last" ON TRUE
      WHERE ${and([
        scopeSql('v', run.scope),
        Prisma.sql`"v"."lifecycleStatus" IN ('ACTIF'::"VehicleLifecycle", 'HORS_SERVICE'::"VehicleLifecycle")`,
        uuidEq('v', 'id', f.vehicleId),
        uuidEq('v', 'siteId', f.siteId),
        uuidEq('v', 'categoryId', f.categoryId),
        f.freshness ? Prisma.sql`${rank} = ${FRESHNESS_ORDER[f.freshness] ?? -1}::int` : null,
      ])}`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ id: string; lastObservedAt: Date | null }>>`SELECT "v"."id", "last"."observedAt" AS "lastObservedAt" ${filtered} ORDER BY ${rank}, "v"."code" ${TEXT_ORDER} ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS "total" ${filtered}`,
    ]);
    const ids = page.map((p) => p.id);
    const period = instantRange(run.period);
    const [vehicles, pending, inPeriod] = ids.length
      ? await Promise.all([
          this.prisma.client.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, code: true, registration: true, site: { select: { name: true } } } }),
          this.prisma.client.odometerReading.groupBy({ by: ['vehicleId'], where: { vehicleId: { in: ids }, status: 'EN_ATTENTE' }, _count: { _all: true } }),
          this.prisma.client.odometerReading.groupBy({ by: ['vehicleId', 'status', 'isEstimate', 'measurementKind'], where: { vehicleId: { in: ids }, observedAt: period }, _count: { _all: true } }),
        ])
      : [[], [], []];
    const count = (vehicleId: string, predicate: (g: (typeof inPeriod)[number]) => boolean) => inPeriod.filter((g) => g.vehicleId === vehicleId && predicate(g)).reduce((sum, g) => sum + g._count._all, 0);
    const rows: ReportRow[] = page.flatMap(({ id, lastObservedAt }) => {
      const v = vehicles.find((x) => x.id === id);
      if (!v) return [];
      const freshness = computeFreshness(lastObservedAt, run.now, staleDays.get(v.companyId) ?? 0);
      return [
        {
          id: v.id,
          companyId: v.companyId,
          values: {
            vehicle: v.code,
            registration: v.registration,
            company: null,
            site: v.site?.name ?? null,
            freshness: freshness.status,
            lastObservedAt: freshness.lastObservedAt,
            ageDays: freshness.ageDays,
            pendingCount: pending.find((g) => g.vehicleId === v.id)?._count._all ?? 0,
            rejectedCount: count(v.id, (g) => g.status === 'REJETE'),
            correctedCount: count(v.id, (g) => g.status === 'REMPLACE'),
            estimatedCount: count(v.id, (g) => g.status === 'ACCEPTE' && isEstimateReading(g)),
          },
        },
      ];
    });
    return { rows, total: counted[0]?.total ?? 0 };
  }
}
