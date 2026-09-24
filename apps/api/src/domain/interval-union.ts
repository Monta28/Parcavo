import { Decimal } from 'decimal.js';

/**
 * Durées d'immobilisation dans les rapports (CDC 7.4, 11.2 ; D-271) — calcul unique.
 * Durée par véhicule = union des intervalles, chacun borné à sa fin réelle ou, s'il est en cours, à
 * min(maintenant, fin de période), puis découpée à la période : deux intervalles qui se chevauchent ne
 * sont jamais comptés deux fois. Durées exprimées en jours avec une décimale (demi vers le haut).
 */

export interface OpenInterval {
  start: Date;
  /** null : intervalle en cours. */
  end: Date | null;
}

export interface ClippedInterval {
  start: Date;
  end: Date;
  /** Au moins un intervalle fusionné est encore en cours. */
  ongoing: boolean;
}

export interface IntervalUnion {
  intervals: ClippedInterval[];
  totalMs: number;
  /** Au moins un intervalle retenu est encore en cours (libellé « en cours »). */
  ongoing: boolean;
}

export function unionWithinPeriod(intervals: readonly OpenInterval[], period: { from: Date; to: Date }, now: Date): IntervalUnion {
  const from = period.from.getTime();
  const to = period.to.getTime();
  const clipped: ClippedInterval[] = [];
  for (const interval of intervals) {
    const ongoing = interval.end === null;
    const rawEnd = interval.end ? interval.end.getTime() : Math.min(now.getTime(), to);
    const start = Math.max(interval.start.getTime(), from);
    const end = Math.min(rawEnd, to);
    if (end > start) clipped.push({ start: new Date(start), end: new Date(end), ongoing });
  }
  clipped.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  const merged: ClippedInterval[] = [];
  for (const current of clipped) {
    const last = merged.at(-1);
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) last.end = current.end;
      last.ongoing = last.ongoing || current.ongoing;
    } else {
      merged.push({ ...current });
    }
  }
  const totalMs = merged.reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()), 0);
  return { intervals: merged, totalMs, ongoing: merged.some((i) => i.ongoing) };
}

const DAY_MS = 24 * 3600 * 1000;

/** Millisecondes → jours, une décimale (arrondi demi vers le haut). */
export function durationDays(ms: number): Decimal {
  return new Decimal(ms).div(DAY_MS).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
}
