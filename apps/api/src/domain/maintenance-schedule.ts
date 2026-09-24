import { Decimal } from 'decimal.js';
import type { PlanStatus } from '@parc-auto/db';
import { addCalendarMonths, addDays, compareCivil, diffDays, type CivilDate } from './civil-date.js';
import { kmValue } from './km-display.js';

/**
 * Échéances d'entretien (CDC 6.1, 6.2, 6.4) — implémentation unique.
 *  - prochaineEcheanceKm = kmCumulesDerniereOperation + intervalleKm
 *  - prochaineEcheanceDate = dateDerniereOperation + intervalle (mois calendaires, date inexistante ramenée
 *    au dernier jour du mois cible, ou jours)
 *  - Statuts : A_PREVOIR si 0 < reste ≤ préavis ; A_FAIRE à la valeur exacte ou le jour de l'échéance ;
 *    EN_RETARD au-delà ; le niveau le plus urgent l'emporte ; données manquantes affichées à part.
 *  - Base : l'opération effective la plus récente (date réelle), jamais la dernière saisie : un entretien
 *    ancien ajouté après coup ne fait pas reculer la base.
 */
export interface PlanIntervals {
  intervalKm: Decimal | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  noticeKm: Decimal | null;
  noticeDays: number | null;
}

export type BaseMode = 'DERNIERE_OPERATION' | 'BASE_TECHNIQUE' | 'ECHEANCE_INITIALE' | 'AUCUNE';

export interface OperationPoint {
  /** Identifiant de la tâche réalisée, null pour la base déclarée du plan. */
  taskId: string | null;
  date: CivilDate | null;
  km: Decimal | null;
}

export interface PlanBaseInput {
  mode: BaseMode;
  initialBaseKm: Decimal | null;
  initialBaseDate: CivilDate | null;
  initialNextDueKm: Decimal | null;
  initialNextDueDate: CivilDate | null;
  /**
   * Pour ECHEANCE_INITIALE : date civile de création du plan. Seules les opérations datées à partir de
   * ce jour remplacent l'échéance initiale ; un entretien plus ancien importé après coup reste de
   * l'historique (D-208, T18).
   */
  initialDueSince?: CivilDate | null;
  operations: readonly OperationPoint[];
}

export interface DueResult {
  base: OperationPoint | null;
  nextDueKm: Decimal | null;
  nextDueDate: CivilDate | null;
  /** Vrai si l'échéance vient de l'échéance initiale saisie (aucune opération depuis). */
  fromInitialDue: boolean;
}

const URGENCY: Record<PlanStatus, number> = { EN_RETARD: 4, A_FAIRE: 3, A_PREVOIR: 2, A_JOUR: 1, INCOMPLET: 0 };

/** Opération la plus récente par date effective ; à date égale, la plus grande valeur kilométrique. */
export function mostRecentOperation(points: readonly OperationPoint[]): OperationPoint | null {
  let best: OperationPoint | null = null;
  for (const p of points) {
    if (!p.date && !p.km) continue;
    if (!best) {
      best = p;
      continue;
    }
    const cmp = p.date && best.date ? compareCivil(p.date, best.date) : 0;
    if (cmp > 0) best = p;
    else if (cmp === 0) {
      if (p.km && (!best.km || p.km.gt(best.km))) best = p;
      else if (!p.date && best.date === null && p.km && best.km && p.km.gt(best.km)) best = p;
    }
  }
  return best;
}

export function computeNextDue(intervals: PlanIntervals, input: PlanBaseInput): DueResult {
  const declared: OperationPoint[] =
    input.mode === 'DERNIERE_OPERATION' || input.mode === 'BASE_TECHNIQUE'
      ? input.initialBaseKm || input.initialBaseDate
        ? [{ taskId: null, date: input.initialBaseDate, km: input.initialBaseKm }]
        : []
      : [];
  const operations =
    input.mode === 'ECHEANCE_INITIALE' && input.initialDueSince
      ? input.operations.filter((op) => op.date !== null && compareCivil(op.date, input.initialDueSince as CivilDate) >= 0)
      : input.operations;
  const base = mostRecentOperation([...declared, ...operations]);
  if (!base && input.mode === 'ECHEANCE_INITIALE') {
    return { base: null, nextDueKm: input.initialNextDueKm, nextDueDate: input.initialNextDueDate, fromInitialDue: true };
  }
  if (!base) return { base: null, nextDueKm: null, nextDueDate: null, fromInitialDue: false };
  // Avec une échéance initiale, une opération réalisée prend le relais.
  const nextDueKm = intervals.intervalKm && base.km ? base.km.plus(intervals.intervalKm) : null;
  let nextDueDate: CivilDate | null = null;
  if (base.date) {
    if (intervals.intervalMonths) nextDueDate = addCalendarMonths(base.date, intervals.intervalMonths);
    else if (intervals.intervalDays) nextDueDate = addDays(base.date, intervals.intervalDays);
  }
  return { base, nextDueKm, nextDueDate, fromInitialDue: false };
}

export interface StatusInput {
  intervals: PlanIntervals;
  nextDueKm: Decimal | null;
  nextDueDate: CivilDate | null;
  /** Kilomètres cumulés courants admissibles pour ce plan (null si inconnus). */
  currentKm: Decimal | null;
  /** Date civile locale du jour (fuseau du groupe). */
  today: CivilDate;
  /** Cumul incomplet (historique antérieur inconnu). */
  cumulativeKnown: boolean;
  /** Kilométrage ancien (fraîcheur A_ACTUALISER). */
  kmStale: boolean;
}

export interface StatusResult {
  status: PlanStatus;
  kmStatus: PlanStatus | null;
  dateStatus: PlanStatus | null;
  remainingKm: Decimal | null;
  remainingDays: number | null;
  /** Données manquantes ou anciennes affichées séparément (6.2, 5.5). */
  warnings: Array<'KILOMETRAGE_INCONNU' | 'KILOMETRAGE_ANCIEN' | 'CUMUL_INCOMPLET' | 'BASE_KM_MANQUANTE' | 'BASE_DATE_MANQUANTE' | 'AUCUNE_BASE'>;
}

function kmLevel(remaining: Decimal, notice: Decimal): PlanStatus {
  if (remaining.isNegative()) return 'EN_RETARD';
  if (remaining.isZero()) return 'A_FAIRE';
  if (remaining.lte(notice)) return 'A_PREVOIR';
  return 'A_JOUR';
}

function dateLevel(remainingDays: number, noticeDays: number): PlanStatus {
  if (remainingDays < 0) return 'EN_RETARD';
  if (remainingDays === 0) return 'A_FAIRE';
  if (remainingDays <= noticeDays) return 'A_PREVOIR';
  return 'A_JOUR';
}

export function computePlanStatus(input: StatusInput): StatusResult {
  const warnings: StatusResult['warnings'] = [];
  const usesKm = input.intervals.intervalKm !== null;
  const usesDate = input.intervals.intervalMonths !== null || input.intervals.intervalDays !== null;
  let kmStatus: PlanStatus | null = null;
  let dateStatus: PlanStatus | null = null;
  let remainingKm: Decimal | null = null;
  let remainingDays: number | null = null;

  if (usesKm || input.nextDueKm) {
    if (!input.nextDueKm) warnings.push('BASE_KM_MANQUANTE');
    else if (!input.currentKm) warnings.push('KILOMETRAGE_INCONNU');
    else {
      // Comparaison sur le kilomètre entier parcouru : la valeur exacte de l'échéance donne A_FAIRE.
      remainingKm = input.nextDueKm.minus(input.currentKm.floor());
      kmStatus = kmLevel(remainingKm, input.intervals.noticeKm ?? new Decimal(0));
      if (input.kmStale) warnings.push('KILOMETRAGE_ANCIEN');
      if (!input.cumulativeKnown) warnings.push('CUMUL_INCOMPLET');
    }
  }
  if (usesDate || input.nextDueDate) {
    if (!input.nextDueDate) warnings.push('BASE_DATE_MANQUANTE');
    else {
      remainingDays = diffDays(input.today, input.nextDueDate);
      dateStatus = dateLevel(remainingDays, input.intervals.noticeDays ?? 0);
    }
  }
  const candidates = [kmStatus, dateStatus].filter((s): s is PlanStatus => s !== null);
  if (candidates.length === 0) {
    if (!input.nextDueKm && !input.nextDueDate) warnings.push('AUCUNE_BASE');
    return { status: 'INCOMPLET', kmStatus, dateStatus, remainingKm, remainingDays, warnings };
  }
  const status = candidates.reduce((a, b) => (URGENCY[b] > URGENCY[a] ? b : a));
  return { status, kmStatus, dateStatus, remainingKm, remainingDays, warnings };
}

export type IntervalsError = 'INTERVALLE_REQUIS' | 'INTERVALLE_TEMPS' | 'INTERVALLE_INVALIDE' | 'PREAVIS_INVALIDE' | 'PREAVIS_KM_TROP_GRAND' | 'PREAVIS_JOURS_TROP_GRAND';

/** Durée minimale de l'intervalle en temps, en jours (mois comptés à 28 jours) : borne du préavis (D-197). */
export function minimalIntervalDays(intervals: Pick<PlanIntervals, 'intervalMonths' | 'intervalDays'>): number | null {
  if (intervals.intervalMonths) return intervals.intervalMonths * 28;
  if (intervals.intervalDays) return intervals.intervalDays;
  return null;
}

/**
 * Contrôle d'un jeu d'intervalles (6.1, D-197) : au moins un intervalle ; mois ou jours, exclusifs ;
 * préavis strictement inférieur à l'intervalle. Renvoie la liste des erreurs (vide si valide).
 */
export function validateIntervals(intervals: PlanIntervals): IntervalsError[] {
  const errors: IntervalsError[] = [];
  if (!intervals.intervalKm && !intervals.intervalMonths && !intervals.intervalDays) errors.push('INTERVALLE_REQUIS');
  if (intervals.intervalMonths && intervals.intervalDays) errors.push('INTERVALLE_TEMPS');
  if (intervals.intervalKm && !intervals.intervalKm.gt(0)) errors.push('INTERVALLE_INVALIDE');
  if ((intervals.noticeKm && intervals.noticeKm.lt(0)) || (intervals.noticeDays !== null && intervals.noticeDays < 0)) errors.push('PREAVIS_INVALIDE');
  if (intervals.intervalKm && intervals.noticeKm && intervals.noticeKm.gte(intervals.intervalKm)) errors.push('PREAVIS_KM_TROP_GRAND');
  const minDays = minimalIntervalDays(intervals);
  if (minDays !== null && intervals.noticeDays !== null && intervals.noticeDays >= minDays) errors.push('PREAVIS_JOURS_TROP_GRAND');
  return errors;
}

/**
 * Préavis par défaut applicables (paramètres maintenance.noticeKm / noticeDays) au seul composant
 * présent ; un défaut qui dépasserait l'intervalle est ramené juste en dessous (D-197).
 */
export function defaultNotices(intervals: Pick<PlanIntervals, 'intervalKm' | 'intervalMonths' | 'intervalDays'>, defaults: { noticeKm: number; noticeDays: number }): { noticeKm: Decimal | null; noticeDays: number | null } {
  const noticeKm = intervals.intervalKm ? Decimal.min(new Decimal(defaults.noticeKm), intervals.intervalKm.minus(1).floor().clamp(0, Infinity)) : null;
  const minDays = minimalIntervalDays(intervals);
  const noticeDays = minDays !== null ? Math.max(0, Math.min(defaults.noticeDays, minDays - 1)) : null;
  return { noticeKm, noticeDays };
}

export function isUrgent(status: PlanStatus): boolean {
  return status === 'A_FAIRE' || status === 'EN_RETARD';
}

/**
 * Kilomètres affichés (CDC 13.1) : partie entière TRONQUÉE, jamais arrondie (90 000,9 → « 90000 » ;
 * −200,7 → « −200 »). Sert aux vues et messages des plans ; les calculs gardent la valeur exacte.
 * Délègue à la règle unique d'affichage des kilomètres (domain/km-display.ts).
 */
export function truncatedKm(value: Decimal | null): string | null {
  return kmValue(value);
}

/** Rang d'urgence d'un statut pour le tri des listes : EN_RETARD > A_FAIRE > A_PREVOIR > INCOMPLET > A_JOUR. */
export const PLAN_SORT_URGENCY: Record<PlanStatus, number> = { EN_RETARD: 4, A_FAIRE: 3, A_PREVOIR: 2, INCOMPLET: 1, A_JOUR: 0 };

/** Tris calculés d'une liste de plans (les tris sur colonnes stockées sont faits en base). */
export type ComputedPlanSort = 'urgence' | 'resteKm' | 'resteJours';

export interface PlanSortEntry {
  id: string;
  status: PlanStatus;
  remainingKm: Decimal | null;
  remainingDays: number | null;
}

type SortOrder = 'asc' | 'desc';

function compareNullable<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number, direction: 1 | -1): number {
  // Données manquantes toujours en fin de liste, quel que soit le sens.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * compare(a, b);
}

const compareDecimal = (x: Decimal, y: Decimal) => x.comparedTo(y);
const compareNumber = (x: number, y: number) => x - y;

/**
 * Comparateur des tris calculés (10.1). « urgence » : rang de statut (desc = le plus urgent d'abord),
 * puis, à rang égal, le reste en jours puis en km le plus faible d'abord (sens inversé en asc).
 * « resteKm » / « resteJours » : reste signé (négatif = dépassé), départage par l'autre reste.
 * Restes inconnus en fin de liste ; identifiant en dernier recours (pagination stable).
 */
export function comparePlansForSort(sort: ComputedPlanSort, order: SortOrder, a: PlanSortEntry, b: PlanSortEntry): number {
  const dir: 1 | -1 = order === 'asc' ? 1 : -1;
  const steps: number[] = [];
  if (sort === 'urgence') {
    steps.push(dir * (PLAN_SORT_URGENCY[a.status] - PLAN_SORT_URGENCY[b.status]));
    const inverse: 1 | -1 = dir === 1 ? -1 : 1;
    steps.push(compareNullable(a.remainingDays, b.remainingDays, compareNumber, inverse));
    steps.push(compareNullable(a.remainingKm, b.remainingKm, compareDecimal, inverse));
  } else if (sort === 'resteKm') {
    steps.push(compareNullable(a.remainingKm, b.remainingKm, compareDecimal, dir));
    steps.push(compareNullable(a.remainingDays, b.remainingDays, compareNumber, dir));
  } else {
    steps.push(compareNullable(a.remainingDays, b.remainingDays, compareNumber, dir));
    steps.push(compareNullable(a.remainingKm, b.remainingKm, compareDecimal, dir));
  }
  for (const s of steps) if (s !== 0) return s;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
