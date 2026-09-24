import { Decimal } from 'decimal.js';
import { distanceBetween } from './odometer-rules.js';

/**
 * Distance d'une période et coût par kilomètre (CDC 11.3 ; D-274, D-275, D-276) — calcul unique.
 *
 *  - R1 et R2 sont le premier et le dernier relevé accepté observé dans [début, fin] de la période ; la
 *    distance vaut cumulé(R2) − cumulé(R1) et s'affiche avec ses dates observées : aucune interpolation.
 *  - N/D (jamais 0) : moins de deux instants observés ; cumul incomplet (R1 et R2 sur des compteurs
 *    différents alors que le cumul du compteur de R2 n'est pas connu) ; relevés de sociétés différentes
 *    sans relevé de transfert à la frontière (distance non ventilable).
 *  - D-276 : les bornes sont physiques par défaut (compteur affiché ou CAN) ; la distance fondée sur une
 *    borne estimée (distance GPS calibrée) forme une colonne séparée, libellée « estimée », et le coût/km
 *    qui en découle (seulement à défaut de distance physique) est marqué « estimé ».
 *  - 11.3, D-275 : un transfert de société au milieu de la période découpe la période par société
 *    détentrice ; chaque part est bornée par le relevé de transfert (sinon, la distance à cheval n'est pas
 *    ventilable) et ne reçoit que les coûts de sa société.
 *  - Coût/km = coût d'exploitation net des jours [date(R1), date(R2)] / distance, calculé seulement si la
 *    distance est strictement positive et que la période observée couvre au moins la part minimale
 *    (reports.minObservedCoverage) de la période considérée. Jamais de division par zéro.
 */

export interface PeriodReading {
  id: string;
  observedAt: Date;
  enteredAt: Date;
  /** Kilomètres cumulés du relevé accepté. */
  cumulativeKm: Decimal;
  /** Borne estimée (DISTANCE_GPS calibrée) : libellée « estimation GPS ». */
  isEstimate: boolean;
  /** Société du véhicule au moment de l'observation. */
  companyId: string;
  /** Relevé de contexte TRANSFERT (société source, observé à la date d'effet du transfert). */
  isTransfer: boolean;
  segmentSequence: number;
  /** Faux si le cumul du compteur est incomplet (historique antérieur inconnu). */
  segmentCumulativeKnown: boolean;
}

export const PERIOD_DISTANCE_UNAVAILABLE_REASONS = ['RELEVES_INSUFFISANTS', 'CUMUL_INCOMPLET', 'NON_VENTILABLE', 'CHRONOLOGIE_INCOHERENTE'] as const;
export type PeriodDistanceUnavailableReason = (typeof PERIOD_DISTANCE_UNAVAILABLE_REASONS)[number];

export const PERIOD_DISTANCE_REASON_LABELS: Record<PeriodDistanceUnavailableReason, string> = {
  RELEVES_INSUFFISANTS: 'Moins de deux relevés acceptés dans la période : distance non déterminable.',
  CUMUL_INCOMPLET: 'Cumul incomplet : les relevés appartiennent à des compteurs dont le raccord n’est pas connu.',
  NON_VENTILABLE: 'Relevés de sociétés différentes sans relevé de transfert : distance non ventilable.',
  CHRONOLOGIE_INCOHERENTE: 'Kilométrage cumulé décroissant entre les deux bornes : distance non déterminable.',
};

export const COST_PER_KM_UNAVAILABLE_REASONS = ['DISTANCE_INDISPONIBLE', 'DISTANCE_NULLE', 'COUVERTURE_INSUFFISANTE', 'AUCUNE_DEPENSE'] as const;
export type CostPerKmUnavailableReason = (typeof COST_PER_KM_UNAVAILABLE_REASONS)[number];

export const COST_PER_KM_REASON_LABELS: Record<CostPerKmUnavailableReason, string> = {
  DISTANCE_INDISPONIBLE: 'Distance de la période non déterminable.',
  DISTANCE_NULLE: 'Distance nulle sur la période observée : aucun coût/km calculé.',
  COUVERTURE_INSUFFISANTE: 'La période observée entre les deux relevés couvre trop peu de la période demandée.',
  AUCUNE_DEPENSE: 'Aucune dépense validée sur la période observée.',
};

export interface PeriodDistance {
  available: boolean;
  reason: PeriodDistanceUnavailableReason | null;
  /** R1 : premier relevé accepté de la période (null si aucun). */
  start: PeriodReading | null;
  /** R2 : dernier relevé accepté de la période (null si aucun ou identique à R1). */
  end: PeriodReading | null;
  distanceKm: Decimal | null;
  /** Une borne au moins est une estimation GPS. */
  estimated: boolean;
  /** Part de la période demandée couverte par [R1, R2] (0 à 1), null sans deux bornes. */
  coverage: Decimal | null;
  readingCount: number;
}

export interface PeriodBounds {
  /** Début inclus (instant). */
  from: Date;
  /** Fin incluse (instant). */
  to: Date;
}

function compareReadings(a: PeriodReading, b: PeriodReading): number {
  return a.observedAt.getTime() - b.observedAt.getTime() || a.enteredAt.getTime() - b.enteredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Frontière de société franchie sans relevé de transfert entre deux relevés consécutifs. */
function crossesCompanyWithoutTransfer(ordered: readonly PeriodReading[]): boolean {
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1] as PeriodReading;
    const current = ordered[i] as PeriodReading;
    if (previous.companyId !== current.companyId && !previous.isTransfer && !current.isTransfer) return true;
  }
  return false;
}

export function periodDistance(readings: readonly PeriodReading[], period: PeriodBounds): PeriodDistance {
  const inPeriod = readings.filter((r) => r.observedAt.getTime() >= period.from.getTime() && r.observedAt.getTime() <= period.to.getTime()).sort(compareReadings);
  const count = inPeriod.length;
  const first = inPeriod[0] ?? null;
  const last = inPeriod.at(-1) ?? null;
  const unavailable = (reason: PeriodDistanceUnavailableReason, start: PeriodReading | null, end: PeriodReading | null, coverage: Decimal | null): PeriodDistance => ({
    available: false,
    reason,
    start,
    end,
    distanceKm: null,
    estimated: Boolean(start?.isEstimate) || Boolean(end?.isEstimate),
    coverage,
    readingCount: count,
  });
  if (!first || !last || first.observedAt.getTime() === last.observedAt.getTime()) {
    return unavailable('RELEVES_INSUFFISANTS', first, null, null);
  }
  const periodMs = period.to.getTime() - period.from.getTime();
  const coverage = periodMs > 0 ? Decimal.min(new Decimal(last.observedAt.getTime() - first.observedAt.getTime()).div(periodMs), 1) : null;
  if (first.segmentSequence !== last.segmentSequence && !last.segmentCumulativeKnown) return unavailable('CUMUL_INCOMPLET', first, last, coverage);
  if (crossesCompanyWithoutTransfer(inPeriod)) return unavailable('NON_VENTILABLE', first, last, coverage);
  const distance = distanceBetween(first.cumulativeKm, last.cumulativeKm);
  if (distance === null) return unavailable('CHRONOLOGIE_INCOHERENTE', first, last, coverage);
  return { available: true, reason: null, start: first, end: last, distanceKm: distance, estimated: first.isEstimate || last.isEstimate, coverage, readingCount: count };
}

export interface CostPerKm {
  available: boolean;
  reason: CostPerKmUnavailableReason | null;
  /** Coût net / distance (exact), null si N/D. */
  value: Decimal | null;
  /** Fondé sur une distance estimée : marqué « estimé ». */
  estimated: boolean;
}

export interface CostPerKmInput {
  /** Distance retenue (costBasis) : physique par défaut, estimée à défaut. */
  distance: PeriodDistance;
  /** Coût d'exploitation net des jours [date(R1), date(R2)] de la société concernée et nombre de lignes retenues. */
  cost: { net: Decimal; count: number };
  /** Couverture minimale (reports.minObservedCoverage, 0 à 1). */
  minCoverage: number;
}

export function costPerKm(input: CostPerKmInput): CostPerKm {
  const { distance } = input;
  const unavailable = (reason: CostPerKmUnavailableReason): CostPerKm => ({ available: false, reason, value: null, estimated: distance.estimated });
  if (!distance.available || distance.distanceKm === null) return unavailable('DISTANCE_INDISPONIBLE');
  if (!distance.distanceKm.gt(0)) return unavailable('DISTANCE_NULLE');
  if (distance.coverage === null || distance.coverage.lt(input.minCoverage)) return unavailable('COUVERTURE_INSUFFISANTE');
  if (input.cost.count === 0) return unavailable('AUCUNE_DEPENSE');
  return { available: true, reason: null, value: input.cost.net.div(distance.distanceKm), estimated: distance.estimated };
}

// ---------------------------------------------------------------------------
// Bornes physiques par défaut, colonne estimée séparée (D-276)
// ---------------------------------------------------------------------------

export interface PeriodDistances {
  /** Distance par défaut : bornes physiques seulement (compteur affiché ou CAN). */
  physical: PeriodDistance;
  /**
   * Colonne estimée séparée : bornes prises parmi tous les relevés acceptés, estimations GPS comprises.
   * null quand aucune borne estimée n'intervient (elle serait identique à la distance physique).
   */
  estimated: PeriodDistance | null;
}

export function periodDistances(readings: readonly PeriodReading[], period: PeriodBounds): PeriodDistances {
  const physical = periodDistance(readings.filter((r) => !r.isEstimate), period);
  const all = periodDistance(readings, period);
  return { physical, estimated: all.estimated ? all : null };
}

/** Distance retenue pour le coût/km : physique si elle est disponible, sinon l'estimée (coût/km « estimé »). */
export function costBasis(distances: PeriodDistances): PeriodDistance {
  return distances.physical.available || !distances.estimated ? distances.physical : distances.estimated;
}

// ---------------------------------------------------------------------------
// Ventilation par société détentrice (CDC 11.3, D-275)
// ---------------------------------------------------------------------------

/** Transfert de société (historique du véhicule, hors enregistrement de création). */
export interface CompanyTransfer {
  effectiveAt: Date;
  fromCompanyId: string;
  toCompanyId: string;
  /** Relevé de transfert (société d'origine, observé à effectiveAt) : borne commune aux deux sociétés. */
  hasTransferReading: boolean;
}

export interface OwnershipSegment {
  companyId: string;
  /** Part de la période détenue par la société (bornes incluses). */
  from: Date;
  to: Date;
  /** Transfert entrant pendant la période (début du segment), sinon null. */
  entry: CompanyTransfer | null;
  /** Transfert sortant pendant la période (fin du segment), sinon null. */
  exit: CompanyTransfer | null;
}

/**
 * Parts de la période détenues par chaque société : un transfert au milieu de la période n'attribue ni tous
 * les kilomètres ni tous les coûts au propriétaire courant (11.3). Sans transfert, un seul segment pour la
 * société courante ; une part de durée nulle (transfert exactement à une borne) est omise.
 */
export function ownershipSegments(transfers: readonly CompanyTransfer[], currentCompanyId: string, period: PeriodBounds): OwnershipSegment[] {
  const ordered = [...transfers].sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
  const periodFrom = period.from.getTime();
  const periodTo = period.to.getTime();
  const segments: OwnershipSegment[] = [];
  let owner = ordered[0]?.fromCompanyId ?? currentCompanyId;
  let start = Number.NEGATIVE_INFINITY;
  let entry: CompanyTransfer | null = null;
  const push = (end: number, exit: CompanyTransfer | null) => {
    const from = Math.max(start, periodFrom);
    const to = Math.min(end, periodTo);
    if (to <= from) return;
    segments.push({
      companyId: owner,
      from: new Date(from),
      to: new Date(to),
      entry: entry && entry.effectiveAt.getTime() > periodFrom ? entry : null,
      exit: exit && exit.effectiveAt.getTime() < periodTo ? exit : null,
    });
  };
  for (const transfer of ordered) {
    push(transfer.effectiveAt.getTime(), transfer);
    owner = transfer.toCompanyId;
    start = transfer.effectiveAt.getTime();
    entry = transfer;
  }
  push(Number.POSITIVE_INFINITY, null);
  return segments;
}
