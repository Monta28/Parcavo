import { Injectable } from '@nestjs/common';
import { Prisma, type VehicleLifecycle } from '@parc-auto/db';
import { VEHICLE_LIFECYCLE_LABELS } from '@parc-auto/contracts';
import { localDate, toDbDate } from '../../../domain/civil-date.js';
import { summarizeLedger } from '../../../domain/expense-ledger.js';
import {
  COST_PER_KM_REASON_LABELS,
  PERIOD_DISTANCE_REASON_LABELS,
  costBasis,
  costPerKm,
  ownershipSegments,
  periodDistances,
  type CompanyTransfer,
  type OwnershipSegment,
  type PeriodDistance,
  type PeriodReading,
} from '../../../domain/period-distance.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { formatLocalDateTime } from '../export/format.js';
import { COST_PER_KM_NATURE_LABELS, MEASURE_NATURE_LABELS, NOT_AVAILABLE, dec, isEstimateReading } from '../report-support.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow } from '../report-types.js';

const DEFAULT_LIFECYCLES: VehicleLifecycle[] = ['ACTIF', 'HORS_SERVICE'];

interface CandidateVehicle {
  id: string;
  companyId: string;
  code: string;
  registration: string;
  lifecycleStatus: VehicleLifecycle;
  companyHistory: Array<{ effectiveAt: Date; fromCompanyId: string | null; toCompanyId: string; transferReadingId: string | null }>;
}

interface Part {
  vehicle: CandidateVehicle;
  segment: OwnershipSegment;
}

function nature(reading: PeriodReading | null): 'ESTIMATION' | 'MESURE' | null {
  return reading ? (reading.isEstimate ? 'ESTIMATION' : 'MESURE') : null;
}

/**
 * Distances et coût par kilomètre d'une période, par véhicule et société détentrice (CDC 11.3 ; D-274, D-275,
 * D-276). Règles de period-distance.ts : un transfert au milieu de la période découpe la période par société
 * (chaque part bornée par le relevé de transfert, ses seuls relevés et ses seuls coûts) ; R1/R2 physiques par
 * défaut, distance fondée sur une borne GPS dans une colonne estimée séparée ; coût d'exploitation des jours
 * observés [date(R1), date(R2)] par expense-ledger.ts ; coût/km seulement si la distance est positive et la
 * couverture ≥ reports.minObservedCoverage ; jamais 0 pour une donnée absente. Colonnes de coût : costs.read sur
 * la société de la ligne.
 */
@Injectable()
export class DistanceCostReportService implements ReportProvider {
  readonly code = 'couts-distances' as const;
  readonly label = 'Distances et coût par kilomètre';
  readonly description = 'Distance observée de la période par société détentrice (premier et dernier relevé physique accepté, estimation GPS à part), couverture et coût d’exploitation par kilomètre.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'vehicules', label: 'Par véhicule', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'lifecycleStatus', 'from', 'to'] },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  columns(): ReportColumn[] {
    return [
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société détentrice', unit: null, kind: 'text' },
      { key: 'lifecycleStatus', label: 'Cycle de vie', unit: null, kind: 'enum', labels: VEHICLE_LIFECYCLE_LABELS },
      { key: 'transferNote', label: 'Transfert dans la période', unit: null, kind: 'text' },
      { key: 'readings', label: 'Relevés acceptés (période)', unit: null, kind: 'integer' },
      { key: 'startObservedAt', label: 'Premier relevé physique (R1)', unit: null, kind: 'datetime' },
      { key: 'startKm', label: 'Kilométrage R1', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3 },
      { key: 'endObservedAt', label: 'Dernier relevé physique (R2)', unit: null, kind: 'datetime' },
      { key: 'endKm', label: 'Kilométrage R2', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3 },
      { key: 'distanceKm', label: 'Distance observée (relevés physiques)', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3, missing: NOT_AVAILABLE },
      { key: 'distanceNote', label: 'Motif N/D (distance)', unit: null, kind: 'text' },
      { key: 'estimatedStartObservedAt', label: 'Première borne, estimations comprises', unit: null, kind: 'datetime' },
      { key: 'estimatedStartNature', label: 'Nature de la première borne', unit: null, kind: 'enum', labels: MEASURE_NATURE_LABELS, estimates: ['ESTIMATION'] },
      { key: 'estimatedEndObservedAt', label: 'Dernière borne, estimations comprises', unit: null, kind: 'datetime' },
      { key: 'estimatedEndNature', label: 'Nature de la dernière borne', unit: null, kind: 'enum', labels: MEASURE_NATURE_LABELS, estimates: ['ESTIMATION'] },
      { key: 'estimatedDistanceKm', label: 'Distance estimée (bornes GPS)', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3 },
      { key: 'estimatedDistanceNote', label: 'Motif N/D (distance estimée)', unit: null, kind: 'text' },
      { key: 'coverage', label: 'Couverture de la période (distance retenue)', unit: '%', kind: 'decimal', decimals: 0, exportDecimals: 1 },
      { key: 'operatingCost', label: 'Coût d’exploitation (jours observés)', unit: null, kind: 'money', cost: true, missing: NOT_AVAILABLE },
      { key: 'costPerKm', label: 'Coût par km', unit: null, kind: 'money', perUnit: 'km', cost: true, missing: NOT_AVAILABLE },
      { key: 'costPerKmNature', label: 'Nature du coût/km', unit: null, kind: 'enum', labels: COST_PER_KM_NATURE_LABELS, cost: true, estimates: ['ESTIME'] },
      { key: 'costPerKmNote', label: 'Motif N/D (coût/km)', unit: null, kind: 'text', cost: true },
    ];
  }

  notes(): string[] {
    return [
      'Distance = kilomètres cumulés du dernier relevé physique accepté de la période moins ceux du premier (dates observées affichées) : aucune interpolation.',
      'N/D si moins de deux relevés, si le cumul est incomplet entre deux compteurs, ou si les relevés relèvent de sociétés différentes sans relevé de transfert (non ventilable).',
      'Les distances GPS (odomètre virtuel calibré) ne servent de borne que dans la colonne « Distance estimée » ; un coût/km fondé sur elle, à défaut de distance physique, est marqué « Estimé ».',
      'Un transfert de société dans la période découpe la période : chaque société ne reçoit que ses kilomètres (bornés par le relevé de transfert) et ses propres coûts.',
      'Coût/km = coût d’exploitation net de la société sur les jours observés / distance, seulement si la distance est positive et que la période observée couvre la part minimale paramétrée de la période (ou de la part détenue).',
      'Sans filtre de cycle de vie : véhicules actifs et hors service.',
    ];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const period = run.period;
    if (!period) return { rows: [], total: 0 };
    const scope = run.scope.companyIds;
    const bounds = { from: period.start, to: period.end };
    // Véhicules détenus par une société du périmètre pendant la période : détenteur courant, ou société
    // d'origine d'un transfert postérieur au début de la période.
    const vehicles: CandidateVehicle[] = await this.prisma.client.vehicle.findMany({
      where: {
        organizationId: run.scope.organizationId,
        lifecycleStatus: f.lifecycleStatus ? (f.lifecycleStatus as VehicleLifecycle) : { in: DEFAULT_LIFECYCLES },
        ...(f.vehicleId ? { id: f.vehicleId } : {}),
        ...(f.siteId ? { siteId: f.siteId } : {}),
        ...(f.categoryId ? { categoryId: f.categoryId } : {}),
        OR: [{ companyId: { in: scope } }, { companyHistory: { some: { fromCompanyId: { in: scope }, effectiveAt: { gt: period.start } } } }],
      },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: { id: true, companyId: true, code: true, registration: true, lifecycleStatus: true, companyHistory: { select: { effectiveAt: true, fromCompanyId: true, toCompanyId: true, transferReadingId: true }, orderBy: { effectiveAt: 'asc' } } },
    });
    const parts: Part[] = vehicles.flatMap((vehicle) =>
      ownershipSegments(transfersOf(vehicle), vehicle.companyId, bounds)
        .filter((segment) => scope.includes(segment.companyId))
        .map((segment) => ({ vehicle, segment })),
    );
    const page = parts.slice(window.skip, window.skip + window.take);
    const { bounds: partBounds, counts } = await this.partReadings(page);
    const minCoverage = await this.settings.get(run.scope.organizationId, 'reports.minObservedCoverage');
    const rows: ReportRow[] = [];
    for (const [index, { vehicle, segment }] of page.entries()) {
      // Premières et dernières bornes (physiques, puis toutes natures) de la part : periodDistances n'en
      // retient pas d'autres (même tri, même société, même relevé de transfert entrant).
      const distances = periodDistances(partBounds.get(index) ?? [], { from: segment.from, to: segment.to });
      const basis = costBasis(distances);
      const { physical, estimated } = distances;
      const values: ReportRow['values'] = {
        vehicle: vehicle.code,
        registration: vehicle.registration,
        company: null,
        lifecycleStatus: vehicle.lifecycleStatus,
        transferNote: transferNote(segment, run.timezone),
        readings: counts.get(index) ?? 0,
        startObservedAt: physical.start?.observedAt ?? null,
        startKm: physical.start?.cumulativeKm ?? null,
        endObservedAt: physical.end?.observedAt ?? null,
        endKm: physical.end?.cumulativeKm ?? null,
        distanceKm: physical.distanceKm,
        distanceNote: physical.reason ? PERIOD_DISTANCE_REASON_LABELS[physical.reason] : null,
        estimatedStartObservedAt: estimated?.start?.observedAt ?? null,
        estimatedStartNature: nature(estimated?.start ?? null),
        estimatedEndObservedAt: estimated?.end?.observedAt ?? null,
        estimatedEndNature: nature(estimated?.end ?? null),
        estimatedDistanceKm: estimated?.distanceKm ?? null,
        estimatedDistanceNote: estimated?.reason ? PERIOD_DISTANCE_REASON_LABELS[estimated.reason] : null,
        coverage: basis.coverage ? basis.coverage.times(100) : null,
        operatingCost: null,
        costPerKm: null,
        costPerKmNature: null,
        costPerKmNote: null,
      };
      if (run.scope.costCompanyIds.has(segment.companyId)) Object.assign(values, await this.costs(run, vehicle.id, segment.companyId, basis, minCoverage));
      rows.push({ id: `${vehicle.id}:${segment.companyId}:${segment.from.toISOString()}`, companyId: segment.companyId, values });
    }
    return { rows, total: parts.length };
  }

  /**
   * Bornes candidates de chaque part, lues en base sans charger tous les relevés (télématique) : relevés acceptés
   * de la société détentrice dans sa part, plus le relevé de transfert entrant (société d'origine, observé à
   * l'instant du transfert) ; premier et dernier physiques, premier et dernier toutes natures confondues, dans
   * l'ordre de period-distance.ts (observation, saisie, identifiant). Compte des relevés de la société.
   */
  private async partReadings(parts: readonly Part[]): Promise<{ bounds: Map<number, PeriodReading[]>; counts: Map<number, number> }> {
    const bounds = new Map<number, PeriodReading[]>();
    const counts = new Map<number, number>();
    if (parts.length === 0) return { bounds, counts };
    const vehicleIds = parts.map((p) => p.vehicle.id);
    const companyIds = parts.map((p) => p.segment.companyId);
    const froms = parts.map((p) => p.segment.from.toISOString());
    const tos = parts.map((p) => p.segment.to.toISOString());
    const hasEntry = parts.map((p) => p.segment.entry !== null);
    const entryCompanyIds = parts.map((p) => p.segment.entry?.fromCompanyId ?? p.segment.companyId);
    const entryAts = parts.map((p) => (p.segment.entry?.effectiveAt ?? p.segment.from).toISOString());
    const partsSql = Prisma.sql`unnest(${vehicleIds}::uuid[], ${companyIds}::uuid[], ${froms}::timestamptz[], ${tos}::timestamptz[], ${hasEntry}::boolean[], ${entryCompanyIds}::uuid[], ${entryAts}::timestamptz[]) WITH ORDINALITY AS p("vehicleId", "companyId", "from", "to", "hasEntry", "entryCompanyId", "entryAt", "idx")`;
    const base = Prisma.sql`r."vehicleId" = p."vehicleId" AND r."status" = 'ACCEPTE' AND r."cumulativeKm" IS NOT NULL AND r."observedAt" >= p."from" AND r."observedAt" <= p."to"
      AND (r."companyId" = p."companyId" OR (p."hasEntry" AND r."context" = 'TRANSFERT' AND r."companyId" = p."entryCompanyId" AND r."observedAt" = p."entryAt"))`;
    // Traduction SQL de isEstimateReading (report-support.ts) : borne physique = ni estimée ni distance GPS.
    const physical = Prisma.sql`NOT (r."isEstimate" OR r."measurementKind" = 'DISTANCE_GPS')`;
    const columns = Prisma.sql`r."id", r."companyId", r."observedAt", r."enteredAt", r."cumulativeKm", r."isEstimate", r."measurementKind"::text AS "measurementKind", r."context"::text AS "context", r."segmentId"`;
    const [rows, totals] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ idx: bigint; id: string; companyId: string; observedAt: Date; enteredAt: Date; cumulativeKm: Prisma.Decimal; isEstimate: boolean; measurementKind: string; context: string; sequence: number; cumulativeKnown: boolean }>>`
        SELECT p."idx", x."id", x."companyId", x."observedAt", x."enteredAt", x."cumulativeKm", x."isEstimate", x."measurementKind", x."context", s."sequence", s."cumulativeKnown"
        FROM ${partsSql}
        CROSS JOIN LATERAL (
          (SELECT ${columns} FROM "OdometerReading" r WHERE ${base} AND ${physical} ORDER BY r."observedAt" ASC, r."enteredAt" ASC, r."id" ASC LIMIT 1)
          UNION ALL
          (SELECT ${columns} FROM "OdometerReading" r WHERE ${base} AND ${physical} ORDER BY r."observedAt" DESC, r."enteredAt" DESC, r."id" DESC LIMIT 1)
          UNION ALL
          (SELECT ${columns} FROM "OdometerReading" r WHERE ${base} ORDER BY r."observedAt" ASC, r."enteredAt" ASC, r."id" ASC LIMIT 1)
          UNION ALL
          (SELECT ${columns} FROM "OdometerReading" r WHERE ${base} ORDER BY r."observedAt" DESC, r."enteredAt" DESC, r."id" DESC LIMIT 1)
        ) x
        JOIN "OdometerSegment" s ON s."id" = x."segmentId"`,
      this.prisma.client.$queryRaw<Array<{ idx: bigint; count: number }>>`
        SELECT p."idx", (SELECT count(*)::int FROM "OdometerReading" r WHERE ${base} AND r."companyId" = p."companyId") AS "count"
        FROM ${partsSql}`,
    ]);
    for (const row of rows) {
      const index = Number(row.idx) - 1;
      const list = bounds.get(index) ?? [];
      if (!list.some((r) => r.id === row.id)) {
        list.push({
          id: row.id,
          observedAt: row.observedAt,
          enteredAt: row.enteredAt,
          cumulativeKm: dec(row.cumulativeKm),
          isEstimate: isEstimateReading(row),
          companyId: row.companyId,
          isTransfer: row.context === 'TRANSFERT',
          segmentSequence: row.sequence,
          segmentCumulativeKnown: row.cumulativeKnown,
        });
      }
      bounds.set(index, list);
    }
    for (const row of totals) counts.set(Number(row.idx) - 1, row.count);
    return { bounds, counts };
  }

  /** Coût d'exploitation de la société sur les jours observés de la distance retenue, et coût/km. */
  private async costs(run: ReportRun, vehicleId: string, companyId: string, basis: PeriodDistance, minCoverage: number): Promise<ReportRow['values']> {
    if (!basis.start || !basis.end) return { costPerKmNote: COST_PER_KM_REASON_LABELS.DISTANCE_INDISPONIBLE };
    const occurredOn = { gte: toDbDate(localDate(basis.start.observedAt, run.timezone)) as Date, lte: toDbDate(localDate(basis.end.observedAt, run.timezone)) as Date };
    const expenses = await this.prisma.client.expense.findMany({
      where: { organizationId: run.scope.organizationId, companyId, vehicleId, occurredOn },
      select: { category: true, kind: true, status: true, amount: true, vehicleId: true, excludedFromOperatingCost: true },
    });
    const ledger = summarizeLedger(expenses.map((e) => ({ category: e.category, kind: e.kind, status: e.status, amount: e.amount.toString(), vehicleId: e.vehicleId, excludedFromOperatingCost: e.excludedFromOperatingCost })));
    const ratio = costPerKm({ distance: basis, cost: { net: ledger.operating.net, count: ledger.operating.count }, minCoverage });
    return {
      operatingCost: ledger.operating.count > 0 ? ledger.operating.net : null,
      costPerKm: ratio.value,
      costPerKmNature: ratio.available ? (ratio.estimated ? 'ESTIME' : 'CALCULE') : null,
      costPerKmNote: ratio.reason ? COST_PER_KM_REASON_LABELS[ratio.reason] : null,
    };
  }
}

/** Transferts de l'historique (l'enregistrement de création, sans société d'origine, n'en est pas un). */
function transfersOf(vehicle: CandidateVehicle): CompanyTransfer[] {
  return vehicle.companyHistory
    .filter((h): h is typeof h & { fromCompanyId: string } => h.fromCompanyId !== null)
    .map((h) => ({ effectiveAt: h.effectiveAt, fromCompanyId: h.fromCompanyId, toCompanyId: h.toCompanyId, hasTransferReading: h.transferReadingId !== null }));
}

/** Transfert entrant ou sortant pendant la période, avec ou sans relevé de transfert (D-275). */
function transferNote(segment: OwnershipSegment, timezone: string): string | null {
  const notes: string[] = [];
  if (segment.entry) {
    const at = formatLocalDateTime(segment.entry.effectiveAt, timezone);
    notes.push(segment.entry.hasTransferReading ? `Depuis le transfert du ${at} (relevé de transfert en première borne).` : `Depuis le transfert du ${at}, sans relevé de transfert : la distance à cheval sur le transfert n’est pas ventilable.`);
  }
  if (segment.exit) {
    const at = formatLocalDateTime(segment.exit.effectiveAt, timezone);
    notes.push(segment.exit.hasTransferReading ? `Jusqu’au transfert du ${at} (relevé de transfert en dernière borne).` : `Jusqu’au transfert du ${at}, sans relevé de transfert : la distance à cheval sur le transfert n’est pas ventilable.`);
  }
  return notes.length > 0 ? notes.join(' ') : null;
}
