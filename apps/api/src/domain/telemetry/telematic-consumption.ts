import { Decimal } from 'decimal.js';

/**
 * Consommation télématique affichée en parallèle de la consommation déclarée (CDC 8.5 ; D-234, D-236 ;
 * R-8.5-10) — calcul unique, pur. Mêmes intervalles A → B (pleins complets) et mêmes kilomètres cumulés que
 * la consommation déclarée (8.3) :
 *  - CONSOMMATION_CAN : différence du compteur de litres consommés entre le premier et le dernier échantillon
 *    de [A, B] ;
 *  - NIVEAU_SONDE : niveau après le remplissage A − niveau avant le remplissage B + remplissages détectés
 *    entre les deux (les remplissages A et B sont ceux rapprochés des pleins A et B) ;
 *  - NIVEAU_CAN n'est jamais utilisé (jauge imprécise) ;
 *  - N/D motivé si un trou d'échantillons dépasse 60 min ou si la couverture est inférieure à 90 % de
 *    l'intervalle, et jamais de valeur fabriquée (bilan négatif, volume inconnu, remplissage non détecté,
 *    mesures de deux boîtiers dans la même série après un changement de boîtier : un compteur ou une sonde
 *    d'un autre boîtier n'est pas comparable, comme une distance GPS — CDC 5.6, 14.5).
 * L'écart compare les litres télématiques aux litres déclarés du même intervalle (même distance) ; il n'est
 * calculé que si l'intervalle déclaré est retenu. Aucun résultat n'est enregistré (pas de matérialisation).
 */

/** D-234 : trou maximal entre deux échantillons (bornes de l'intervalle comprises). */
export const TELEMATIC_MAX_GAP_MINUTES = 60;
/** D-234 : part minimale de l'intervalle couverte par les échantillons. */
export const TELEMATIC_MIN_COVERAGE = 0.9;

export type TelematicMeasureKind = 'CONSOMMATION_CAN' | 'NIVEAU_SONDE';
/** Ordre de préférence : le compteur de consommation est une mesure directe ; la sonde un bilan de niveaux. */
export const TELEMATIC_MEASURE_PREFERENCE: readonly TelematicMeasureKind[] = ['CONSOMMATION_CAN', 'NIVEAU_SONDE'];

export const TELEMATIC_CONSUMPTION_REASONS = ['ECHANTILLONS_ABSENTS', 'TROU_ECHANTILLONS', 'COUVERTURE_INSUFFISANTE', 'REMPLISSAGE_NON_DETECTE', 'VOLUME_INCONNU', 'BILAN_INCOHERENT', 'DISTANCE_NON_VALIDE'] as const;
export type TelematicConsumptionReason = (typeof TELEMATIC_CONSUMPTION_REASONS)[number];

export const TELEMATIC_CONSUMPTION_REASON_LABELS: Record<TelematicConsumptionReason, string> = {
  ECHANTILLONS_ABSENTS: 'Aucun échantillon télématique exploitable sur l’intervalle (données non reçues ou purgées).',
  TROU_ECHANTILLONS: `Trou d’échantillons de plus de ${TELEMATIC_MAX_GAP_MINUTES} minutes dans l’intervalle.`,
  COUVERTURE_INSUFFISANTE: `Échantillons couvrant moins de ${TELEMATIC_MIN_COVERAGE * 100} % de l’intervalle.`,
  REMPLISSAGE_NON_DETECTE: 'Remplissage du plein de début ou de fin non détecté par la sonde : niveaux de référence inconnus.',
  VOLUME_INCONNU: 'Niveau exprimé en pourcentage sans capacité de réservoir renseignée.',
  BILAN_INCOHERENT: 'Bilan télématique négatif ou incohérent (compteur remis à zéro, sonde déréglée, ou changement de boîtier dans l’intervalle : mesures de deux boîtiers non comparables).',
  DISTANCE_NON_VALIDE: 'Distance de l’intervalle non validée : aucun ratio comparable.',
};

export interface TelematicSample {
  observedAt: Date;
  kind: 'NIVEAU_CAN' | 'NIVEAU_SONDE' | 'CONSOMMATION_CAN';
  /** Unité (boîtier) qui a produit la mesure : deux boîtiers ne sont jamais combinés dans une même série. */
  unitId?: string | null;
  liters: Decimal | null;
  percent: Decimal | null;
}

/** Remplissage détecté par la sonde (FuelEvent REMPLISSAGE_DETECTE ou ECART_TICKET) et plein rapproché. */
export interface TelematicRefill {
  startAt: Date;
  endAt: Date;
  liters: Decimal;
  fuelEntryId: string | null;
}

export interface TelematicIntervalInput {
  startEntryId: string | null;
  endEntryId: string;
  startAt: Date | null;
  endAt: Date;
  distanceKm: Decimal | null;
  /** Litres déclarés de l'intervalle (achats après A, B inclus). */
  declaredLiters: Decimal;
  declaredRetained: boolean;
}

export interface TelematicIntervalResult {
  kind: TelematicMeasureKind;
  available: boolean;
  liters: Decimal | null;
  ratio: Decimal | null;
  /** Écart en % par rapport à la consommation déclarée du même intervalle (intervalle déclaré retenu). */
  deviationPercent: Decimal | null;
  reasons: TelematicConsumptionReason[];
}

export interface TelematicTotalResult {
  kind: TelematicMeasureKind;
  available: boolean;
  /** Intervalles comparés : déclarés retenus et télématiques disponibles. */
  comparedCount: number;
  liters: Decimal | null;
  declaredLiters: Decimal | null;
  distanceKm: Decimal | null;
  ratio: Decimal | null;
  declaredRatio: Decimal | null;
  deviationPercent: Decimal | null;
  reasons: TelematicConsumptionReason[];
}

export interface TelematicContext {
  samples: readonly TelematicSample[];
  refills: readonly TelematicRefill[];
  /** Natures carburant déclarées par les associations du véhicule (fuelKinds). */
  declaredKinds: readonly string[];
  tankCapacityLiters: Decimal | null;
}

/**
 * Nature télématique exploitable pour le véhicule, ou null (F11 absent : aucun affichage parallèle). Une nature
 * dont des échantillons existent sur la période l'emporte, dans l'ordre de préférence ; à défaut, la nature
 * déclarée par une association (N/D motivé, faute d'échantillons). Une nature déclarée mais jamais reçue ne
 * masque donc pas la mesure effectivement disponible (association déclarant compteur CAN et sonde, fournisseur
 * n'exposant que la sonde).
 */
export function telematicKindOf(context: Pick<TelematicContext, 'samples' | 'declaredKinds'>): TelematicMeasureKind | null {
  for (const kind of TELEMATIC_MEASURE_PREFERENCE) if (context.samples.some((s) => s.kind === kind)) return kind;
  for (const kind of TELEMATIC_MEASURE_PREFERENCE) if (context.declaredKinds.includes(kind)) return kind;
  return null;
}

const MINUTE = 60_000;

function levelOf(sample: TelematicSample, capacity: Decimal | null): Decimal | null {
  if (sample.liters) return sample.liters;
  if (sample.percent && capacity && capacity.gt(0)) return sample.percent.div(100).times(capacity);
  return null;
}

/** Contrôle des trous et de la couverture de [from, to] par une série triée (D-234). */
function coverageReason(series: readonly TelematicSample[], from: Date, to: Date): TelematicConsumptionReason | null {
  const first = series[0];
  const last = series.at(-1);
  if (!first || !last) return 'ECHANTILLONS_ABSENTS';
  const maxGap = TELEMATIC_MAX_GAP_MINUTES * MINUTE;
  const instants = [from.getTime(), ...series.map((s) => s.observedAt.getTime()), to.getTime()];
  for (let i = 1; i < instants.length; i += 1) if ((instants[i] as number) - (instants[i - 1] as number) > maxGap) return 'TROU_ECHANTILLONS';
  const span = to.getTime() - from.getTime();
  if (span > 0 && (last.observedAt.getTime() - first.observedAt.getTime()) / span < TELEMATIC_MIN_COVERAGE) return 'COUVERTURE_INSUFFISANTE';
  return null;
}

/** Vrai si la série mêle les mesures de plusieurs boîtiers (changement de boîtier dans l'intervalle). */
function mixesUnits(series: readonly TelematicSample[]): boolean {
  return new Set(series.map((s) => s.unitId ?? null)).size > 1;
}

function within(samples: readonly TelematicSample[], kind: TelematicMeasureKind, from: Date, to: Date): TelematicSample[] {
  return samples.filter((s) => s.kind === kind && s.observedAt.getTime() >= from.getTime() && s.observedAt.getTime() <= to.getTime()).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

function unavailable(kind: TelematicMeasureKind, reason: TelematicConsumptionReason): TelematicIntervalResult {
  return { kind, available: false, liters: null, ratio: null, deviationPercent: null, reasons: [reason] };
}

/** Écart relatif en % : (télématique − déclaré) / déclaré × 100. */
export function deviationPercent(telematicLiters: Decimal, declaredLiters: Decimal): Decimal | null {
  if (declaredLiters.lte(0)) return null;
  return telematicLiters.minus(declaredLiters).div(declaredLiters).times(100);
}

/** Litres consommés selon la télématique sur l'intervalle A → B, ou N/D motivé. */
export function telematicIntervalLiters(interval: TelematicIntervalInput, kind: TelematicMeasureKind, context: TelematicContext): { liters: Decimal } | { reason: TelematicConsumptionReason } {
  if (!interval.startAt) return { reason: 'ECHANTILLONS_ABSENTS' };
  if (kind === 'CONSOMMATION_CAN') {
    const series = within(context.samples, kind, interval.startAt, interval.endAt).filter((s) => s.liters !== null);
    const reason = coverageReason(series, interval.startAt, interval.endAt);
    if (reason) return { reason };
    // Compteurs de deux boîtiers : leur différence ne mesure rien (valeur fabriquée), N/D motivé.
    if (mixesUnits(series)) return { reason: 'BILAN_INCOHERENT' };
    const liters = (series.at(-1)?.liters as Decimal).minus(series[0]?.liters as Decimal);
    return liters.lt(0) ? { reason: 'BILAN_INCOHERENT' } : { liters };
  }
  // NIVEAU_SONDE : du niveau le plus haut atteint au remplissage A au niveau le plus bas avant le remplissage B.
  const refillA = interval.startEntryId ? context.refills.find((r) => r.fuelEntryId === interval.startEntryId) : undefined;
  const refillB = context.refills.find((r) => r.fuelEntryId === interval.endEntryId);
  if (!refillA || !refillB) return { reason: 'REMPLISSAGE_NON_DETECTE' };
  const levels = context.samples.filter((s) => s.kind === kind).map((s) => ({ at: s.observedAt, level: levelOf(s, context.tankCapacityLiters) }));
  if (levels.some((l) => l.level === null)) return { reason: 'VOLUME_INCONNU' };
  const known = levels as Array<{ at: Date; level: Decimal }>;
  const peak = extreme(known, refillA.startAt, refillA.endAt, 'max');
  const trough = extreme(known, refillB.startAt, refillB.endAt, 'min');
  if (!peak || !trough) return { reason: 'ECHANTILLONS_ABSENTS' };
  if (peak.at.getTime() >= trough.at.getTime()) return { reason: 'REMPLISSAGE_NON_DETECTE' };
  const series = within(context.samples, kind, peak.at, trough.at);
  const reason = coverageReason(series, peak.at, trough.at);
  if (reason) return { reason };
  // Niveaux de deux sondes (pic d'un boîtier, creux d'un autre) : bilan non comparable, N/D motivé.
  if (mixesUnits(series)) return { reason: 'BILAN_INCOHERENT' };
  const between = context.refills.filter((r) => r !== refillA && r !== refillB && r.startAt.getTime() >= peak.at.getTime() && r.endAt.getTime() <= trough.at.getTime());
  const liters = between.reduce((sum, r) => sum.plus(refillVolume(known, r)), peak.level.minus(trough.level));
  return liters.lte(0) ? { reason: 'BILAN_INCOHERENT' } : { liters };
}

/** Niveau extrême d'une fenêtre (le plus récent à égalité) : pic après un remplissage, creux avant. */
function extreme(levels: ReadonlyArray<{ at: Date; level: Decimal }>, from: Date, to: Date, mode: 'max' | 'min'): { at: Date; level: Decimal } | null {
  const inside = levels.filter((l) => l.at.getTime() >= from.getTime() && l.at.getTime() <= to.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
  let best: { at: Date; level: Decimal } | null = null;
  for (const l of inside) if (!best || (mode === 'max' ? l.level.gte(best.level) : l.level.lte(best.level))) best = l;
  return best;
}

/**
 * Volume d'un remplissage intermédiaire mesuré par la sonde : pic de la fenêtre − creux qui le précède ; à
 * défaut d'échantillons stockés dans la fenêtre, les litres de l'événement détecté.
 */
function refillVolume(levels: ReadonlyArray<{ at: Date; level: Decimal }>, refill: TelematicRefill): Decimal {
  const peak = extreme(levels, refill.startAt, refill.endAt, 'max');
  if (!peak) return refill.liters;
  const trough = extreme(levels, refill.startAt, peak.at, 'min');
  return trough ? peak.level.minus(trough.level) : refill.liters;
}

/** Résultat télématique d'un intervalle : litres, L/100 km sur la distance déclarée, écart avec le déclaré. */
export function telematicInterval(interval: TelematicIntervalInput, kind: TelematicMeasureKind, context: TelematicContext): TelematicIntervalResult {
  const measured = telematicIntervalLiters(interval, kind, context);
  if ('reason' in measured) return unavailable(kind, measured.reason);
  if (!interval.distanceKm || interval.distanceKm.lte(0)) return { ...unavailable(kind, 'DISTANCE_NON_VALIDE'), liters: measured.liters };
  const ratio = measured.liters.div(interval.distanceKm).times(100);
  return {
    kind,
    available: true,
    liters: measured.liters,
    ratio,
    deviationPercent: interval.declaredRetained ? deviationPercent(measured.liters, interval.declaredLiters) : null,
    reasons: [],
  };
}

/** Synthèse sur les intervalles comparables (déclaré retenu et télématique disponible), mêmes bornes. */
export function telematicTotal(kind: TelematicMeasureKind, intervals: ReadonlyArray<{ input: TelematicIntervalInput; result: TelematicIntervalResult }>): TelematicTotalResult {
  const compared = intervals.filter((i) => i.input.declaredRetained && i.result.available && i.result.liters && i.input.distanceKm);
  if (compared.length === 0) {
    const reasons = new Set(intervals.flatMap((i) => i.result.reasons));
    return { kind, available: false, comparedCount: 0, liters: null, declaredLiters: null, distanceKm: null, ratio: null, declaredRatio: null, deviationPercent: null, reasons: TELEMATIC_CONSUMPTION_REASONS.filter((r) => reasons.has(r)) };
  }
  const liters = compared.reduce((sum, i) => sum.plus(i.result.liters as Decimal), new Decimal(0));
  const declaredLiters = compared.reduce((sum, i) => sum.plus(i.input.declaredLiters), new Decimal(0));
  const distanceKm = compared.reduce((sum, i) => sum.plus(i.input.distanceKm as Decimal), new Decimal(0));
  return {
    kind,
    available: true,
    comparedCount: compared.length,
    liters,
    declaredLiters,
    distanceKm,
    ratio: liters.div(distanceKm).times(100),
    declaredRatio: declaredLiters.div(distanceKm).times(100),
    deviationPercent: deviationPercent(liters, declaredLiters),
    reasons: [],
  };
}

/** Écart affiché : signé, 1 décimale (« +4.2 », « -3.0 »), arrondi demi vers le haut. */
export function formatDeviation(value: Decimal): string {
  const rounded = value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  if (rounded.isZero()) return '0.0';
  return `${rounded.gt(0) ? '+' : ''}${rounded.toFixed(1)}`;
}
