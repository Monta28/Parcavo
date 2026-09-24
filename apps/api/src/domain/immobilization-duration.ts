import { Decimal } from 'decimal.js';
import { durationDays, unionWithinPeriod, type OpenInterval } from './interval-union.js';

/**
 * Durées d'une immobilisation (CDC 7.4, D-219) — calcul unique, réutilisable par les rapports.
 * Total = union des intervalles des causes (une période où plusieurs causes se superposent n'est
 * comptée qu'une fois) ; une cause en cours compte jusqu'à maintenant. Ventilation : durée propre de
 * chaque cause, dont la somme peut dépasser le total. Unités : heures et jours, une décimale (demi
 * vers le haut, comme `durationDays`).
 */

export const CAUSE_DURATIONS_NOTE = 'La somme des causes peut dépasser le total : une période où plusieurs causes se superposent n’est comptée qu’une fois dans le total.';

const HOUR_MS = 3600 * 1000;

/** Millisecondes → heures, une décimale (arrondi demi vers le haut). */
export function durationHours(ms: number): Decimal {
  return new Decimal(ms).div(HOUR_MS).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
}

export interface CauseInterval {
  id: string;
  startedAt: Date;
  /** null : cause en cours. */
  endedAt: Date | null;
}

export interface DurationValue {
  ms: number;
  hours: Decimal;
  days: Decimal;
  /** Compté jusqu'à maintenant (au moins un intervalle en cours). */
  ongoing: boolean;
}

export interface ImmobilizationDurations {
  total: DurationValue;
  causes: Array<{ id: string } & DurationValue>;
  /** Vrai si la somme des durées propres dépasse le total (causes superposées). */
  causesOverlap: boolean;
}

function value(ms: number, ongoing: boolean): DurationValue {
  return { ms, hours: durationHours(ms), days: durationDays(ms), ongoing };
}

/**
 * Intervalles d'immobilisation retenus pour toute durée (fiche et rapports) : ceux des causes, ou à
 * défaut de cause celui de l'immobilisation elle-même. Règle unique (D-219, D-271).
 */
export function immobilizationIntervals(causes: ReadonlyArray<{ startedAt: Date; endedAt: Date | null }>, fallback?: OpenInterval): OpenInterval[] {
  return causes.length > 0 ? causes.map((c) => ({ start: c.startedAt, end: c.endedAt })) : fallback ? [fallback] : [];
}

/**
 * Durées d'une immobilisation à partir de ses causes. `fallback` (intervalle de l'immobilisation)
 * n'est utilisé que si aucune cause n'est fournie.
 */
export function immobilizationDurations(causes: readonly CauseInterval[], now: Date, fallback?: OpenInterval): ImmobilizationDurations {
  const intervals = immobilizationIntervals(causes, fallback);
  const period = { from: new Date(Math.min(...intervals.map((i) => i.start.getTime()), now.getTime())), to: new Date(Math.max(...intervals.map((i) => (i.end ?? now).getTime()), now.getTime())) };
  const union = unionWithinPeriod(intervals, period, now);
  const own = causes.map((c) => {
    const end = c.endedAt ?? now;
    return { id: c.id, ...value(Math.max(0, end.getTime() - c.startedAt.getTime()), c.endedAt === null) };
  });
  const sum = own.reduce((acc, c) => acc + c.ms, 0);
  return { total: value(union.totalMs, union.ongoing), causes: own, causesOverlap: sum > union.totalMs };
}
