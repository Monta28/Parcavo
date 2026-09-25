import { Decimal } from 'decimal.js';

/**
 * Événements carburant dérivés des échantillons télématiques (CDC 8.5, D-235 à D-242) —
 * implémentation unique, pure, rejouable (clés de déduplication stables).
 *  - BAISSE_ANORMALE : NIVEAU_SONDE uniquement, moteur coupé et vitesse nulle sur toute la fenêtre ;
 *    sans donnée de contact, aucune détection (« indisponible »).
 *  - REMPLISSAGE_DETECTE : NIVEAU_SONDE, ou NIVEAU_CAN avec des seuils doublés (jauge imprécise).
 *  - CONSOMMATION_CAN : aucun événement.
 * « 10 L ou 5 % » : l'événement se déclenche dès qu'un des seuils disponibles est franchi ; la
 * conversion % ↔ L n'a lieu que si la capacité du réservoir est connue. Aucune dépense n'est déduite.
 */
export type FuelNature = 'NIVEAU_CAN' | 'NIVEAU_SONDE' | 'CONSOMMATION_CAN';

export interface FuelPoint {
  observedAt: Date;
  liters: Decimal | null;
  percent: Decimal | null;
  engineOn: boolean | null;
  speedKmh: Decimal | null;
}

export interface Thresholds {
  liters: number;
  percent: number;
  windowMinutes: number;
}

export interface FuelEpisode {
  type: 'BAISSE_ANORMALE' | 'REMPLISSAGE_DETECTE';
  startAt: Date;
  endAt: Date;
  /** Variation en litres (positive), si calculable. */
  liters: Decimal | null;
  /** Variation en % du réservoir (positive), si calculable. */
  percent: Decimal | null;
}

export interface DetectionResult {
  episodes: FuelEpisode[];
  /** Détection de baisse impossible faute de données de contact/vitesse. */
  dropDetectionUnavailable: boolean;
}

function asLiters(p: FuelPoint, capacity: Decimal | null): Decimal | null {
  if (p.liters) return p.liters;
  if (p.percent && capacity) return p.percent.div(100).times(capacity);
  return null;
}

function asPercent(p: FuelPoint, capacity: Decimal | null): Decimal | null {
  if (p.percent) return p.percent;
  if (p.liters && capacity && capacity.gt(0)) return p.liters.div(capacity).times(100);
  return null;
}

function median(values: Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function crosses(deltaL: Decimal | null, deltaPct: Decimal | null, t: Thresholds): boolean {
  return Boolean((deltaL && deltaL.gte(t.liters)) || (deltaPct && deltaPct.gte(t.percent)));
}

function merge(episodes: FuelEpisode[]): FuelEpisode[] {
  const sorted = [...episodes].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const out: FuelEpisode[] = [];
  for (const e of sorted) {
    const last = out.at(-1);
    if (last && last.type === e.type && e.startAt.getTime() <= last.endAt.getTime()) {
      if (e.endAt > last.endAt) last.endAt = e.endAt;
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

/** Détecte baisses anormales et remplissages dans une série triée par date. */
export function detectFuelEpisodes(points: readonly FuelPoint[], nature: FuelNature, options: { drop: Thresholds; refill: Thresholds; capacityLiters: Decimal | null }): DetectionResult {
  const series = [...points].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  if (nature === 'CONSOMMATION_CAN' || series.length < 2) return { episodes: [], dropDetectionUnavailable: nature === 'NIVEAU_SONDE' && series.length > 0 && series.some((p) => p.engineOn === null || p.speedKmh === null) };
  const cap = options.capacityLiters;
  const refill: Thresholds = nature === 'NIVEAU_CAN' ? { ...options.refill, liters: options.refill.liters * 2, percent: options.refill.percent * 2 } : options.refill;
  const raw: FuelEpisode[] = [];
  let dropUnavailable = false;
  for (let i = 0; i < series.length; i += 1) {
    const a = series[i] as FuelPoint;
    for (let j = i + 1; j < series.length; j += 1) {
      const b = series[j] as FuelPoint;
      const minutes = (b.observedAt.getTime() - a.observedAt.getTime()) / 60_000;
      const la = asLiters(a, cap);
      const lb = asLiters(b, cap);
      const pa = asPercent(a, cap);
      const pb = asPercent(b, cap);
      // Baisse anormale à l'arrêt (sonde uniquement).
      if (nature === 'NIVEAU_SONDE' && minutes <= options.drop.windowMinutes) {
        const window = series.slice(i, j + 1);
        if (window.some((p) => p.engineOn === null || p.speedKmh === null)) {
          dropUnavailable = true;
        } else if (window.every((p) => p.engineOn === false && (p.speedKmh as Decimal).isZero())) {
          const dl = la && lb ? la.minus(lb) : null;
          const dp = pa && pb ? pa.minus(pb) : null;
          if (crosses(dl, dp, options.drop)) raw.push({ type: 'BAISSE_ANORMALE', startAt: a.observedAt, endAt: b.observedAt, liters: null, percent: null });
        }
      }
      // Remplissage : médiane des 3 échantillons avant et après.
      if (minutes <= refill.windowMinutes) {
        const before = series.slice(Math.max(0, i - 2), i + 1);
        const after = series.slice(j, j + 3);
        const mbL = median(before.map((p) => asLiters(p, cap)).filter((x): x is Decimal => x !== null));
        const maL = median(after.map((p) => asLiters(p, cap)).filter((x): x is Decimal => x !== null));
        const mbP = median(before.map((p) => asPercent(p, cap)).filter((x): x is Decimal => x !== null));
        const maP = median(after.map((p) => asPercent(p, cap)).filter((x): x is Decimal => x !== null));
        const dl = mbL && maL ? maL.minus(mbL) : null;
        const dp = mbP && maP ? maP.minus(mbP) : null;
        if (crosses(dl, dp, refill)) raw.push({ type: 'REMPLISSAGE_DETECTE', startAt: a.observedAt, endAt: b.observedAt, liters: null, percent: null });
      }
    }
  }
  const episodes = merge(raw).map((e) => {
    const inside = series.filter((p) => p.observedAt >= e.startAt && p.observedAt <= e.endAt);
    const first = inside[0] as FuelPoint;
    const levelsL = inside.map((p) => asLiters(p, cap)).filter((x): x is Decimal => x !== null);
    const levelsP = inside.map((p) => asPercent(p, cap)).filter((x): x is Decimal => x !== null);
    const startL = asLiters(first, cap);
    const startP = asPercent(first, cap);
    if (e.type === 'BAISSE_ANORMALE') {
      return { ...e, liters: startL && levelsL.length ? startL.minus(Decimal.min(...levelsL)) : null, percent: startP && levelsP.length ? startP.minus(Decimal.min(...levelsP)) : null };
    }
    return { ...e, liters: startL && levelsL.length ? Decimal.max(...levelsL).minus(startL) : null, percent: startP && levelsP.length ? Decimal.max(...levelsP).minus(startP) : null };
  });
  return { episodes, dropDetectionUnavailable: nature === 'NIVEAU_SONDE' && dropUnavailable && !episodes.some((e) => e.type === 'BAISSE_ANORMALE') };
}

/** Clé de déduplication : véhicule, type et début d'épisode aligné sur 5 minutes (rejeu idempotent, T36). */
export function episodeDedupeKey(vehicleId: string, type: FuelEpisode['type'], startAt: Date): string {
  const aligned = new Date(Math.floor(startAt.getTime() / 300_000) * 300_000);
  return `${vehicleId}:${type}:${aligned.toISOString()}`;
}

export interface TicketCandidate {
  id: string;
  filledAt: Date;
  liters: Decimal;
}

export type TicketMatch = { matched: true; ticketId: string; differenceLiters: Decimal } | { matched: false; reason: 'ABSENCE_TICKET' | 'ECART_LITRES'; differenceLiters: Decimal | null; nearestTicketId: string | null };

/**
 * Rapprochement d'un remplissage détecté avec un ticket (D-237, D-238) : même véhicule,
 * |filledAt − détection| ≤ 2 h, litres dans la tolérance max(5 L, 10 % des litres du ticket).
 */
export function matchTicket(fill: { detectedAt: Date; liters: Decimal | null }, tickets: readonly TicketCandidate[], options: { windowHours: number; toleranceLiters: number; tolerancePercent: number } = { windowHours: 2, toleranceLiters: 5, tolerancePercent: 10 }): TicketMatch {
  const inWindow = tickets.filter((t) => Math.abs(t.filledAt.getTime() - fill.detectedAt.getTime()) <= options.windowHours * 3_600_000);
  if (inWindow.length === 0) return { matched: false, reason: 'ABSENCE_TICKET', differenceLiters: null, nearestTicketId: null };
  if (!fill.liters) {
    const nearest = [...inWindow].sort((a, b) => Math.abs(a.filledAt.getTime() - fill.detectedAt.getTime()) - Math.abs(b.filledAt.getTime() - fill.detectedAt.getTime()))[0] as TicketCandidate;
    return { matched: true, ticketId: nearest.id, differenceLiters: new Decimal(0) };
  }
  const scored = inWindow.map((t) => ({ t, diff: t.liters.minus(fill.liters as Decimal).abs() })).sort((a, b) => a.diff.comparedTo(b.diff));
  const best = scored[0] as { t: TicketCandidate; diff: Decimal };
  const tolerance = Decimal.max(new Decimal(options.toleranceLiters), best.t.liters.times(options.tolerancePercent).div(100));
  if (best.diff.lte(tolerance)) return { matched: true, ticketId: best.t.id, differenceLiters: best.diff };
  return { matched: false, reason: 'ECART_LITRES', differenceLiters: best.diff, nearestTicketId: best.t.id };
}
