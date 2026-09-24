import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { comparePlansForSort, computeNextDue, defaultNotices, validateIntervals, computePlanStatus, mostRecentOperation, truncatedKm, type PlanIntervals, type PlanSortEntry } from './maintenance-schedule.js';

const d = (v: number) => new Decimal(v);
const oil: PlanIntervals = { intervalKm: d(10_000), intervalMonths: 12, intervalDays: null, noticeKm: d(500), noticeDays: 30 };
const kmOnly: PlanIntervals = { ...oil, intervalMonths: null, noticeDays: null };

function status(currentKm: number | null, today = '2026-09-24', nextDueKm: number | null = 90_000, nextDueDate: string | null = null, intervals = kmOnly) {
  return computePlanStatus({ intervals, nextDueKm: nextDueKm === null ? null : d(nextDueKm), nextDueDate, currentKm: currentKm === null ? null : d(currentKm), today, cumulativeKnown: true, kmStale: false });
}

describe('échéances en kilomètres (CDC 6.2, T15)', () => {
  it('T15 — base 80 000, intervalle 10 000, préavis 500 : 89 500 A_PREVOIR, 90 000 A_FAIRE, 90 200 EN_RETARD', () => {
    const due = computeNextDue(kmOnly, { mode: 'DERNIERE_OPERATION', initialBaseKm: d(80_000), initialBaseDate: '2026-01-10', initialNextDueKm: null, initialNextDueDate: null, operations: [] });
    expect(due.nextDueKm?.toString()).toBe('90000');
    expect(status(89_500).status).toBe('A_PREVOIR');
    expect(status(90_000).status).toBe('A_FAIRE');
    expect(status(90_200).status).toBe('EN_RETARD');
    expect(status(89_499).status).toBe('A_JOUR');
  });
  it('T15 — un passage direct de 89 500 à 90 200 déclenche le retard', () => {
    expect(status(90_200).status).toBe('EN_RETARD');
    expect(status(90_200).remainingKm?.toString()).toBe('-200');
  });
  it('compare le kilomètre entier parcouru : 90 000,4 reste A_FAIRE', () => {
    expect(computePlanStatus({ intervals: kmOnly, nextDueKm: d(90_000), nextDueDate: null, currentKm: new Decimal('90000.4'), today: '2026-09-24', cumulativeKnown: true, kmStale: false }).status).toBe('A_FAIRE');
  });
  it('kilométrage inconnu : INCOMPLET avec la donnée manquante affichée à part', () => {
    const r = status(null);
    expect(r.status).toBe('INCOMPLET');
    expect(r.warnings).toContain('KILOMETRAGE_INCONNU');
  });
});

describe('échéances en temps (CDC 6.2, T16)', () => {
  it('T16 — la date atteinte avant le kilométrage : A_FAIRE le jour même, EN_RETARD le lendemain local', () => {
    const due = computeNextDue(oil, { mode: 'DERNIERE_OPERATION', initialBaseKm: d(80_000), initialBaseDate: '2025-09-24', initialNextDueKm: null, initialNextDueDate: null, operations: [] });
    expect(due.nextDueDate).toBe('2026-09-24');
    const base = { intervals: oil, nextDueKm: due.nextDueKm, nextDueDate: due.nextDueDate, currentKm: d(85_000), cumulativeKnown: true, kmStale: false };
    expect(computePlanStatus({ ...base, today: '2026-08-25' }).status).toBe('A_PREVOIR');
    expect(computePlanStatus({ ...base, today: '2026-09-24' })).toMatchObject({ status: 'A_FAIRE', kmStatus: 'A_JOUR', dateStatus: 'A_FAIRE' });
    expect(computePlanStatus({ ...base, today: '2026-09-25' })).toMatchObject({ status: 'EN_RETARD', dateStatus: 'EN_RETARD' });
  });
  it('mois calendaires : 31 janvier + 1 mois = 28 février', () => {
    const due = computeNextDue({ ...oil, intervalMonths: 1 }, { mode: 'DERNIERE_OPERATION', initialBaseKm: null, initialBaseDate: '2026-01-31', initialNextDueKm: null, initialNextDueDate: null, operations: [] });
    expect(due.nextDueDate).toBe('2026-02-28');
  });
  it('le niveau le plus urgent l’emporte entre km et date', () => {
    const r = computePlanStatus({ intervals: oil, nextDueKm: d(90_000), nextDueDate: '2026-12-31', currentKm: d(90_100), today: '2026-09-24', cumulativeKnown: true, kmStale: true });
    expect(r).toMatchObject({ status: 'EN_RETARD', kmStatus: 'EN_RETARD', dateStatus: 'A_JOUR' });
    expect(r.warnings).toContain('KILOMETRAGE_ANCIEN');
  });
});

describe('base des plans (CDC 6.1, 6.4, T17, T18)', () => {
  it('T17 — vidange réalisée à 90 300 : prochaine échéance 100 300', () => {
    const due = computeNextDue(kmOnly, { mode: 'DERNIERE_OPERATION', initialBaseKm: d(80_000), initialBaseDate: '2026-01-10', initialNextDueKm: null, initialNextDueDate: null, operations: [{ taskId: 't1', date: '2026-09-24', km: d(90_300) }] });
    expect(due.nextDueKm?.toString()).toBe('100300');
    expect(due.base?.taskId).toBe('t1');
  });
  it('T18 — une vidange antérieure ajoutée après coup ne fait pas reculer la base', () => {
    const ops = [
      { taskId: 'recente', date: '2026-09-24', km: d(90_300) },
      { taskId: 'ancienne', date: '2026-03-01', km: d(84_000) },
    ];
    expect(mostRecentOperation(ops)?.taskId).toBe('recente');
    expect(computeNextDue(kmOnly, { mode: 'DERNIERE_OPERATION', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: null, initialNextDueDate: null, operations: ops }).nextDueKm?.toString()).toBe('100300');
  });
  it('échéance initiale sans historique, puis relais par la première opération réalisée', () => {
    const initial = computeNextDue(kmOnly, { mode: 'ECHEANCE_INITIALE', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: d(95_000), initialNextDueDate: null, operations: [] });
    expect(initial).toMatchObject({ fromInitialDue: true });
    expect(initial.nextDueKm?.toString()).toBe('95000');
    const after = computeNextDue(kmOnly, { mode: 'ECHEANCE_INITIALE', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: d(95_000), initialNextDueDate: null, operations: [{ taskId: 'x', date: '2026-09-30', km: d(94_000) }] });
    expect(after.nextDueKm?.toString()).toBe('104000');
  });
  it('sans base ni échéance : plan INCOMPLET, aucune fausse vidange à zéro', () => {
    const due = computeNextDue(kmOnly, { mode: 'AUCUNE', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: null, initialNextDueDate: null, operations: [] });
    expect(due).toMatchObject({ base: null, nextDueKm: null, nextDueDate: null });
    const r = computePlanStatus({ intervals: kmOnly, nextDueKm: null, nextDueDate: null, currentKm: d(50_000), today: '2026-09-24', cumulativeKnown: true, kmStale: false });
    expect(r.status).toBe('INCOMPLET');
    expect(r.warnings).toContain('AUCUNE_BASE');
  });
  it('échéance initiale : un entretien antérieur à la création du plan importé après coup ne la remplace pas (D-208)', () => {
    const old = computeNextDue(kmOnly, { mode: 'ECHEANCE_INITIALE', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: d(95_000), initialNextDueDate: null, initialDueSince: '2026-06-01', operations: [{ taskId: 'old', date: '2026-01-15', km: d(75_000) }] });
    expect(old).toMatchObject({ fromInitialDue: true });
    expect(old.nextDueKm?.toString()).toBe('95000');
    const recent = computeNextDue(kmOnly, { mode: 'ECHEANCE_INITIALE', initialBaseKm: null, initialBaseDate: null, initialNextDueKm: d(95_000), initialNextDueDate: null, initialDueSince: '2026-06-01', operations: [{ taskId: 'old', date: '2026-01-15', km: d(75_000) }, { taskId: 'new', date: '2026-06-01', km: d(94_000) }] });
    expect(recent.nextDueKm?.toString()).toBe('104000');
  });
});

describe('validateIntervals / defaultNotices (6.1, D-197)', () => {
  const base = { intervalKm: null, intervalMonths: null, intervalDays: null, noticeKm: null, noticeDays: null };
  it('exige au moins un intervalle, mois ou jours exclusifs, préavis inférieur à l’intervalle', () => {
    expect(validateIntervals(base)).toEqual(['INTERVALLE_REQUIS']);
    expect(validateIntervals({ ...base, intervalMonths: 6, intervalDays: 180 })).toContain('INTERVALLE_TEMPS');
    expect(validateIntervals({ ...base, intervalKm: d(10_000), noticeKm: d(10_000) })).toEqual(['PREAVIS_KM_TROP_GRAND']);
    expect(validateIntervals({ ...base, intervalMonths: 1, noticeDays: 28 })).toEqual(['PREAVIS_JOURS_TROP_GRAND']);
    expect(validateIntervals({ ...base, intervalMonths: 1, noticeDays: 27 })).toEqual([]);
    expect(validateIntervals({ ...base, intervalKm: d(10_000), noticeKm: d(500), intervalMonths: 12, noticeDays: 30 })).toEqual([]);
    expect(validateIntervals({ ...base, intervalKm: d(10_000), noticeKm: d(-100) })).toEqual(['PREAVIS_INVALIDE']);
  });
  it('applique les préavis par défaut au seul composant présent, sans dépasser l’intervalle', () => {
    expect(defaultNotices({ intervalKm: d(10_000), intervalMonths: null, intervalDays: null }, { noticeKm: 500, noticeDays: 30 })).toEqual({ noticeKm: d(500), noticeDays: null });
    expect(defaultNotices({ intervalKm: null, intervalMonths: null, intervalDays: 20 }, { noticeKm: 500, noticeDays: 30 })).toEqual({ noticeKm: null, noticeDays: 19 });
    expect(defaultNotices({ intervalKm: d(300), intervalMonths: 12, intervalDays: null }, { noticeKm: 500, noticeDays: 30 })).toEqual({ noticeKm: d(299), noticeDays: 30 });
  });
});

describe('affichage des kilomètres (CDC 13.1)', () => {
  it('tronque vers zéro, sans jamais arrondir', () => {
    expect(truncatedKm(new Decimal('90000.9'))).toBe('90000');
    expect(truncatedKm(new Decimal('90000'))).toBe('90000');
    expect(truncatedKm(new Decimal('-200.7'))).toBe('-200');
    expect(truncatedKm(new Decimal('-0.5'))).toBe('0');
    expect(truncatedKm(null)).toBeNull();
  });
});

describe('tri des plans (10.1)', () => {
  const e = (id: string, status: PlanSortEntry['status'], remainingKm: number | null, remainingDays: number | null): PlanSortEntry => ({ id, status, remainingKm: remainingKm === null ? null : d(remainingKm), remainingDays });
  const ids = (list: PlanSortEntry[]) => list.map((x) => x.id);
  const plans = [e('a', 'A_JOUR', 5000, 200), e('b', 'INCOMPLET', null, null), e('c', 'A_PREVOIR', 300, null), e('d', 'EN_RETARD', -200, null), e('e', 'A_FAIRE', 0, 10), e('f', 'EN_RETARD', null, -3), e('g', 'A_PREVOIR', null, 12)];

  it('urgence desc : EN_RETARD > A_FAIRE > A_PREVOIR > INCOMPLET > A_JOUR, le plus dépassé d’abord à rang égal', () => {
    expect(ids([...plans].sort((x, y) => comparePlansForSort('urgence', 'desc', x, y)))).toEqual(['f', 'd', 'e', 'g', 'c', 'b', 'a']);
  });
  it('urgence asc : ordre inverse des rangs', () => {
    expect(ids([...plans].sort((x, y) => comparePlansForSort('urgence', 'asc', x, y)))).toEqual(['a', 'b', 'g', 'c', 'e', 'f', 'd']);
  });
  it('reste km et reste jours : restes signés, inconnus en fin de liste dans les deux sens', () => {
    expect(ids([...plans].sort((x, y) => comparePlansForSort('resteKm', 'asc', x, y)))).toEqual(['d', 'e', 'c', 'a', 'f', 'g', 'b']);
    expect(ids([...plans].sort((x, y) => comparePlansForSort('resteKm', 'desc', x, y)))).toEqual(['a', 'c', 'e', 'd', 'g', 'f', 'b']);
    expect(ids([...plans].sort((x, y) => comparePlansForSort('resteJours', 'asc', x, y)))).toEqual(['f', 'e', 'g', 'a', 'd', 'c', 'b']);
  });
});
