import { Decimal } from 'decimal.js';

/**
 * Calibrage d'une DISTANCE_GPS (CDC 5.6, D-190 à D-193) — implémentation unique.
 *  kmEstimé = kmManuelRéférence + (distanceGps − distanceGpsRéférence)
 *  écart % = |kmEstimé(t) − kmManuel| / (kmManuel − kmRéférencePrécédente) × 100
 * où t est l'instant du relevé manuel et kmEstimé(t) utilise le dernier échantillon GPS antérieur
 * ou égal à t, datant de 30 min au plus. Une DISTANCE_GPS n'est jamais présentée comme un compteur.
 */
export interface CalibrationReference {
  /** Kilomètres cumulés du relevé manuel accepté servant de référence. */
  manualKm: Decimal;
  /** Distance GPS du fournisseur à l'instant de la référence. */
  gpsDistanceKm: Decimal;
  observedAt: Date;
}

export interface GpsSample {
  observedAt: Date;
  gpsDistanceKm: Decimal;
}

/** Estimation calibrée ; null sans référence ou si la distance GPS a reculé (boîtier changé ou remis à zéro). */
export function estimateFromGps(reference: CalibrationReference | null, gpsDistanceKm: Decimal): Decimal | null {
  if (!reference) return null;
  const delta = gpsDistanceKm.minus(reference.gpsDistanceKm);
  if (delta.isNegative()) return null;
  return reference.manualKm.plus(delta);
}

/** Dernier échantillon GPS ≤ t, à 30 min au plus de t (sinon aucune mesure de dérive). */
export function sampleForInstant(samples: readonly GpsSample[], at: Date, maxGapMinutes = 30): GpsSample | null {
  let best: GpsSample | null = null;
  for (const s of samples) {
    if (s.observedAt.getTime() > at.getTime()) continue;
    if (!best || s.observedAt.getTime() > best.observedAt.getTime()) best = s;
  }
  if (!best || at.getTime() - best.observedAt.getTime() > maxGapMinutes * 60_000) return null;
  return best;
}

export interface DriftResult {
  estimateKm: Decimal;
  manualKm: Decimal;
  distanceSinceReferenceKm: Decimal;
  /** Pourcentage exact (non arrondi) ; affichage à une décimale. */
  percent: Decimal;
  exceeded: boolean;
}

/**
 * Écart entre l'estimation et un relevé manuel accepté. null si pas d'estimation, si la distance
 * parcourue depuis la référence est nulle, négative ou inférieure au minimum (aucune mesure fiable).
 */
export function computeDrift(reference: CalibrationReference | null, sampleAtManual: GpsSample | null, manualKm: Decimal, thresholdPercent: number, minDistanceKm = 50): DriftResult | null {
  if (!reference || !sampleAtManual) return null;
  const estimateKm = estimateFromGps(reference, sampleAtManual.gpsDistanceKm);
  if (!estimateKm) return null;
  const distance = manualKm.minus(reference.manualKm);
  if (distance.lte(0) || distance.lt(minDistanceKm)) return null;
  const percent = estimateKm.minus(manualKm).abs().div(distance).times(100);
  return { estimateKm, manualKm, distanceSinceReferenceKm: distance, percent, exceeded: percent.gt(thresholdPercent) };
}

/** Affichage français à une décimale (4,166… → « 4,2 »). */
export function formatPercent(percent: Decimal): string {
  return percent.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1).replace('.', ',');
}
