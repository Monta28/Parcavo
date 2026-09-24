import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeNextDue, computePlanStatus, validateIntervals, type PlanIntervals } from './maintenance-schedule.js';

// Règles complémentaires de la règle unique d'échéance (CDC 6.1, 6.2, 5.5) : intervalle en jours,
// données manquantes ou anciennes affichées à part du statut.
const d = (v: number) => new Decimal(v);
const days90: PlanIntervals = { intervalKm: null, intervalMonths: null, intervalDays: 90, noticeKm: null, noticeDays: 10 };
const kmOnly: PlanIntervals = { intervalKm: d(10_000), intervalMonths: null, intervalDays: null, noticeKm: d(500), noticeDays: null };

describe('échéance calendaire en jours (CDC 6.2 : dateDerniereOperation + intervalleTemps)', () => {
  it('base + 90 jours, y compris à cheval sur un changement d’année et un 29 février', () => {
    const base = (date: string) => computeNextDue(days90, { mode: 'DERNIERE_OPERATION', initialBaseKm: null, initialBaseDate: date, initialNextDueKm: null, initialNextDueDate: null, operations: [] });
    expect(base('2026-08-02').nextDueDate).toBe('2026-10-31');
    expect(base('2026-11-15').nextDueDate).toBe('2027-02-13');
    expect(base('2027-12-31').nextDueDate).toBe('2028-03-30');
    expect(base('2026-08-02').nextDueKm).toBeNull();
  });

  it('l’opération réalisée la plus récente sert de base : +90 jours depuis sa date', () => {
    const due = computeNextDue(days90, {
      mode: 'DERNIERE_OPERATION',
      initialBaseKm: null,
      initialBaseDate: '2026-01-01',
      initialNextDueKm: null,
      initialNextDueDate: null,
      operations: [
        { taskId: 't1', date: '2026-06-10', km: null },
        { taskId: 't2', date: '2026-03-01', km: null },
      ],
    });
    expect(due.base?.taskId).toBe('t1');
    expect(due.nextDueDate).toBe('2026-09-08');
  });

  it('statut en jours : préavis de 10 jours, A_FAIRE le jour même, EN_RETARD le lendemain', () => {
    const at = (today: string) => computePlanStatus({ intervals: days90, nextDueKm: null, nextDueDate: '2026-10-31', currentKm: null, today, cumulativeKnown: true, kmStale: false });
    expect(at('2026-10-20')).toMatchObject({ status: 'A_JOUR', remainingDays: 11 });
    expect(at('2026-10-21')).toMatchObject({ status: 'A_PREVOIR', remainingDays: 10 });
    expect(at('2026-10-31')).toMatchObject({ status: 'A_FAIRE', remainingDays: 0 });
    expect(at('2026-11-01')).toMatchObject({ status: 'EN_RETARD', remainingDays: -1 });
    // Aucun kilométrage requis pour un plan purement calendaire.
    expect(at('2026-10-20').warnings).toEqual([]);
  });

  it('mois et jours sont exclusifs ; préavis en jours inférieur à l’intervalle', () => {
    expect(validateIntervals({ ...days90, intervalMonths: 3 })).toContain('INTERVALLE_TEMPS');
    expect(validateIntervals({ ...days90, noticeDays: 90 })).toContain('PREAVIS_JOURS_TROP_GRAND');
    expect(validateIntervals(days90)).toEqual([]);
  });
});

describe('données manquantes ou anciennes affichées à part du statut (CDC 6.2, 5.5)', () => {
  const at = (input: Partial<{ currentKm: number | null; cumulativeKnown: boolean; kmStale: boolean }>) =>
    computePlanStatus({ intervals: kmOnly, nextDueKm: d(90_000), nextDueDate: null, currentKm: input.currentKm === null ? null : d(input.currentKm ?? 85_000), today: '2026-09-24', cumulativeKnown: input.cumulativeKnown ?? true, kmStale: input.kmStale ?? false });

  it('cumul incomplet : statut calculé sur le cumul connu, avertissement CUMUL_INCOMPLET à part', () => {
    const r = at({ cumulativeKnown: false });
    expect(r.status).toBe('A_JOUR');
    expect(r.remainingKm?.toString()).toBe('5000');
    expect(r.warnings).toEqual(['CUMUL_INCOMPLET']);
  });

  it('relevé ancien : un plan « à jour » selon un relevé ancien porte KILOMETRAGE_ANCIEN, jamais un « à jour » sans réserve', () => {
    const r = at({ kmStale: true });
    expect(r.status).toBe('A_JOUR');
    expect(r.warnings).toEqual(['KILOMETRAGE_ANCIEN']);
    expect(at({ kmStale: true, cumulativeKnown: false }).warnings).toEqual(['KILOMETRAGE_ANCIEN', 'CUMUL_INCOMPLET']);
  });

  it('absence de relevé : INCOMPLET avec KILOMETRAGE_INCONNU, sans avertissement d’ancienneté inventé', () => {
    const r = at({ currentKm: null, kmStale: true, cumulativeKnown: false });
    expect(r.status).toBe('INCOMPLET');
    expect(r.warnings).toEqual(['KILOMETRAGE_INCONNU']);
  });
});
