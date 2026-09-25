import { Decimal } from 'decimal.js';
import type { Prisma } from '@parc-auto/db';
import { FUEL_MEASURE_KIND_LABELS } from '@parc-auto/contracts';
import { formatRatio } from '../../domain/consumption.js';
import {
  TELEMATIC_CONSUMPTION_REASON_LABELS,
  type TelematicConsumptionReason,
  type TelematicContext,
  type TelematicIntervalInput,
  type TelematicIntervalResult,
  type TelematicMeasureKind,
  formatDeviation,
  telematicInterval,
  telematicKindOf,
  telematicTotal,
} from '../../domain/telemetry/telematic-consumption.js';

type Db = Pick<Prisma.TransactionClient, 'fuelLevelSample' | 'fuelEvent' | 'telemetryVehicleMapping'>;

/** Intervalle déclaré tel que calculé par computeConsumption (8.3). */
export interface DeclaredInterval {
  energy: string;
  startEntryId: string | null;
  endEntryId: string;
  startAt: Date | null;
  endAt: Date;
  distanceKm: Decimal | null;
  liters: Decimal;
  retained: boolean;
}

export interface TelematicConsumptionView {
  kind: TelematicMeasureKind;
  kindLabel: string;
  available: boolean;
  liters: string | null;
  litersPer100Km: string | null;
  litersPer100KmExact: string | null;
  /** Écart signé en % par rapport à la consommation déclarée (1 décimale), null si non comparable. */
  deviationPercent: string | null;
  reasons: Array<{ code: TelematicConsumptionReason; label: string }>;
}

export interface TelematicTotalView extends TelematicConsumptionView {
  comparedIntervals: number;
  distanceKm: string | null;
  declaredLiters: string | null;
  declaredLitersPer100Km: string | null;
}

export interface TelematicConsumption {
  kind: TelematicMeasureKind | null;
  interval(i: DeclaredInterval): TelematicConsumptionView | null;
  total(energy: string): TelematicTotalView | null;
}

const NONE: TelematicConsumption = { kind: null, interval: () => null, total: () => null };

function reasonViews(codes: readonly TelematicConsumptionReason[]): TelematicConsumptionView['reasons'] {
  return codes.map((code) => ({ code, label: TELEMATIC_CONSUMPTION_REASON_LABELS[code] }));
}

function view(r: TelematicIntervalResult): TelematicConsumptionView {
  return {
    kind: r.kind,
    kindLabel: FUEL_MEASURE_KIND_LABELS[r.kind],
    available: r.available,
    liters: r.liters?.toFixed(3) ?? null,
    litersPer100Km: r.ratio ? formatRatio(r.ratio, 1) : null,
    litersPer100KmExact: r.ratio?.toFixed() ?? null,
    deviationPercent: r.deviationPercent ? formatDeviation(r.deviationPercent) : null,
    reasons: reasonViews(r.reasons),
  };
}

/**
 * Consommation télématique en parallèle de la consommation déclarée (CDC 8.5 ; D-234, D-236 ; R-8.5-10) :
 * charge les échantillons CONSOMMATION_CAN / NIVEAU_SONDE du véhicule sur l'étendue des intervalles, les
 * remplissages détectés par la sonde (événements du périmètre lisible) et les natures déclarées par ses
 * associations, puis applique la règle unique du domaine. Sans nature exploitable (F11 absent ou jauge CAN
 * seule), rien n'est affiché en parallèle : la consommation déclarée reste seule.
 */
export async function loadTelematicConsumption(
  db: Db,
  input: { scope: { organizationId: string; companyId?: string | { in: string[] } }; vehicleId: string; tankCapacityLiters: Decimal | { toString(): string } | null; intervals: readonly DeclaredInterval[] },
): Promise<TelematicConsumption> {
  const all = await loadTelematicConsumptions(db, { scope: input.scope, vehicles: [{ vehicleId: input.vehicleId, tankCapacityLiters: input.tankCapacityLiters, intervals: input.intervals }] });
  return all.get(input.vehicleId) ?? NONE;
}

/**
 * Même calcul que loadTelematicConsumption pour plusieurs véhicules (rapport carburant) : associations,
 * échantillons et remplissages de tous les véhicules lus en trois requêtes (étendue propre à chaque véhicule),
 * puis règle unique du domaine appliquée véhicule par véhicule.
 */
export async function loadTelematicConsumptions(
  db: Db,
  input: {
    scope: { organizationId: string; companyId?: string | { in: string[] } };
    vehicles: ReadonlyArray<{ vehicleId: string; tankCapacityLiters: Decimal | { toString(): string } | null; intervals: readonly DeclaredInterval[] }>;
  },
): Promise<Map<string, TelematicConsumption>> {
  const out = new Map<string, TelematicConsumption>();
  if (input.vehicles.length === 0) return out;
  // Étendue [premier début, dernière fin] des intervalles bornés de chaque véhicule.
  const ranges: Array<{ vehicleId: string; from: Date; to: Date }> = [];
  for (const v of input.vehicles) {
    const bounded = v.intervals.filter((i): i is DeclaredInterval & { startAt: Date } => i.startAt !== null);
    if (bounded.length === 0) continue;
    ranges.push({ vehicleId: v.vehicleId, from: new Date(Math.min(...bounded.map((i) => i.startAt.getTime()))), to: new Date(Math.max(...bounded.map((i) => i.endAt.getTime()))) });
  }
  const [mappings, sampleRows, eventRows] = await Promise.all([
    db.telemetryVehicleMapping.findMany({ where: { ...input.scope, vehicleId: { in: input.vehicles.map((v) => v.vehicleId) }, status: { in: ['CONFIRME', 'CLOTURE'] } }, select: { vehicleId: true, fuelKinds: true } }),
    ranges.length > 0
      ? db.fuelLevelSample.findMany({
          where: { kind: { in: ['CONSOMMATION_CAN', 'NIVEAU_SONDE'] }, OR: ranges.map((r) => ({ vehicleId: r.vehicleId, observedAt: { gte: r.from, lte: r.to } })) },
          select: { vehicleId: true, observedAt: true, kind: true, unitId: true, liters: true, percent: true },
          // Ordre chronologique, puis unité et nature (unicité des échantillons) : ordre déterministe à instant égal.
          orderBy: [{ observedAt: 'asc' }, { unitId: 'asc' }, { kind: 'asc' }],
        })
      : Promise.resolve([]),
    ranges.length > 0
      ? db.fuelEvent.findMany({
          where: { ...input.scope, measureKind: 'NIVEAU_SONDE', type: { in: ['REMPLISSAGE_DETECTE', 'ECART_TICKET'] }, litersDelta: { not: null }, OR: ranges.map((r) => ({ vehicleId: r.vehicleId, windowEnd: { gte: r.from }, windowStart: { lte: r.to } })) },
          select: { vehicleId: true, windowStart: true, windowEnd: true, litersDelta: true, fuelEntryId: true },
        })
      : Promise.resolve([]),
  ]);
  for (const v of input.vehicles) {
    const declaredKinds = [...new Set(mappings.filter((m) => m.vehicleId === v.vehicleId).flatMap((m) => m.fuelKinds))];
    const samples: TelematicContext['samples'] = sampleRows
      .filter((s) => s.vehicleId === v.vehicleId)
      .map((s) => ({ observedAt: s.observedAt, kind: s.kind, unitId: s.unitId, liters: s.liters ? new Decimal(s.liters.toString()) : null, percent: s.percent ? new Decimal(s.percent.toString()) : null }));
    const refills: TelematicContext['refills'] = eventRows
      .filter((e) => e.vehicleId === v.vehicleId)
      .map((e) => ({ startAt: e.windowStart, endAt: e.windowEnd, liters: new Decimal((e.litersDelta as { toString(): string }).toString()), fuelEntryId: e.fuelEntryId }));
    out.set(v.vehicleId, telematicConsumptionOf(v, { samples, refills, declaredKinds }));
  }
  return out;
}

/** Règle unique du domaine appliquée aux intervalles déclarés d'un véhicule et à ses mesures chargées. */
function telematicConsumptionOf(
  vehicle: { tankCapacityLiters: Decimal | { toString(): string } | null; intervals: readonly DeclaredInterval[] },
  loaded: { samples: TelematicContext['samples']; refills: TelematicContext['refills']; declaredKinds: TelematicContext['declaredKinds'] },
): TelematicConsumption {
  const kind = telematicKindOf({ samples: loaded.samples, declaredKinds: loaded.declaredKinds });
  if (!kind) return NONE;
  const context: TelematicContext = { samples: loaded.samples, refills: loaded.refills, declaredKinds: loaded.declaredKinds, tankCapacityLiters: vehicle.tankCapacityLiters ? new Decimal(vehicle.tankCapacityLiters.toString()) : null };
  const results = new Map<DeclaredInterval, { input: TelematicIntervalInput; result: TelematicIntervalResult }>();
  for (const i of vehicle.intervals) {
    const interval: TelematicIntervalInput = { startEntryId: i.startEntryId, endEntryId: i.endEntryId, startAt: i.startAt, endAt: i.endAt, distanceKm: i.distanceKm, declaredLiters: i.liters, declaredRetained: i.retained };
    results.set(i, { input: interval, result: telematicInterval(interval, kind, context) });
  }
  return {
    kind,
    interval: (i) => {
      const r = results.get(i);
      return r ? view(r.result) : null;
    },
    total: (energy) => {
      const own = vehicle.intervals.filter((i) => i.energy === energy).map((i) => results.get(i)).filter((r): r is { input: TelematicIntervalInput; result: TelematicIntervalResult } => r !== undefined);
      if (own.length === 0) return null;
      const t = telematicTotal(kind, own);
      return {
        kind,
        kindLabel: FUEL_MEASURE_KIND_LABELS[kind],
        available: t.available,
        comparedIntervals: t.comparedCount,
        liters: t.liters?.toFixed(3) ?? null,
        distanceKm: t.distanceKm?.toFixed(3) ?? null,
        declaredLiters: t.declaredLiters?.toFixed(3) ?? null,
        litersPer100Km: t.ratio ? formatRatio(t.ratio, 1) : null,
        litersPer100KmExact: t.ratio?.toFixed() ?? null,
        declaredLitersPer100Km: t.declaredRatio ? formatRatio(t.declaredRatio, 1) : null,
        deviationPercent: t.deviationPercent ? formatDeviation(t.deviationPercent) : null,
        reasons: reasonViews(t.reasons),
      };
    },
  };
}
