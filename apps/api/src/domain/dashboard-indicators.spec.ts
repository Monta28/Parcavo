import { describe, expect, it } from 'vitest';
import { isReturnDue, resolveIndicatorPeriod, returnDueBefore, tallyFleet, type FleetVehicleFacts } from './dashboard-indicators.js';

describe('période des indicateurs de flux (D-269)', () => {
  it('par défaut : mois civil local courant, bornes inclusives', () => {
    expect(resolveIndicatorPeriod(undefined, undefined, '2026-09-24')).toEqual({ ok: true, period: { from: '2026-09-01', to: '2026-09-30' }, defaulted: true });
    expect(resolveIndicatorPeriod(undefined, undefined, '2028-02-29')).toMatchObject({ period: { from: '2028-02-01', to: '2028-02-29' } });
  });
  it('période explicite acceptée, y compris sur un seul jour', () => {
    expect(resolveIndicatorPeriod('2026-01-01', '2026-06-30', '2026-09-24')).toEqual({ ok: true, period: { from: '2026-01-01', to: '2026-06-30' }, defaulted: false });
    expect(resolveIndicatorPeriod('2026-09-24', '2026-09-24', '2026-09-24')).toMatchObject({ ok: true });
  });
  it('refuse une borne seule, une date inexistante ou un début après la fin', () => {
    expect(resolveIndicatorPeriod('2026-09-01', undefined, '2026-09-24')).toMatchObject({ ok: false, code: 'PERIODE_INCOMPLETE', field: 'to' });
    expect(resolveIndicatorPeriod(undefined, '2026-09-30', '2026-09-24')).toMatchObject({ ok: false, code: 'PERIODE_INCOMPLETE', field: 'from' });
    expect(resolveIndicatorPeriod('2026-02-30', '2026-03-31', '2026-09-24')).toMatchObject({ ok: false, code: 'PERIODE_INVALIDE', field: 'from' });
    expect(resolveIndicatorPeriod('2026-09-30', '2026-09-01', '2026-09-24')).toMatchObject({ ok: false, code: 'PERIODE_INVALIDE', field: 'to' });
  });
});

describe('retours attendus (D-269)', () => {
  const tz = 'Africa/Tunis';
  const now = new Date('2026-09-24T10:00:00Z'); // 11:00 à Tunis
  it('limite = fin de la journée locale (23:59:59.999 à Tunis)', () => {
    expect(returnDueBefore(now, tz).toISOString()).toBe('2026-09-24T22:59:59.999Z');
    // Après 23:00 UTC, la journée locale est déjà le lendemain.
    expect(returnDueBefore(new Date('2026-09-24T23:30:00Z'), tz).toISOString()).toBe('2026-09-25T22:59:59.999Z');
  });
  it('retour prévu aujourd’hui (même plus tard) ou dépassé : attendu ; demain : non', () => {
    expect(isReturnDue(new Date('2026-09-24T21:00:00Z'), now, tz)).toBe(true);
    expect(isReturnDue(new Date('2026-09-20T08:00:00Z'), now, tz)).toBe(true);
    expect(isReturnDue(new Date('2026-09-24T22:59:59.999Z'), now, tz)).toBe(true);
    expect(isReturnDue(new Date('2026-09-24T23:00:00Z'), now, tz)).toBe(false);
  });
});

describe('décompte du parc : partition exclusive (CDC 3.2, 11.1)', () => {
  const v = (over: Partial<FleetVehicleFacts>): FleetVehicleFacts => ({ lifecycle: 'ACTIF', hasActiveImmobilization: false, hasOpenUsage: false, blockingNonCompliant: false, ...over });
  it('un véhicule immobilisé en utilisation compte une seule fois, comme immobilisé', () => {
    const t = tallyFleet([v({ hasActiveImmobilization: true, hasOpenUsage: true }), v({ hasOpenUsage: true }), v({})]);
    expect(t.byStatus).toEqual({ IMMOBILISE: 1, EN_UTILISATION: 1, DISPONIBLE: 1 });
    expect(t.active).toBe(3);
    expect(t.byStatus.IMMOBILISE + t.byStatus.EN_UTILISATION + t.byStatus.DISPONIBLE).toBe(t.active);
  });
  it('hors service, cédés et archivés ne gonflent jamais le disponible ni le parc actif', () => {
    const t = tallyFleet([v({ lifecycle: 'HORS_SERVICE' }), v({ lifecycle: 'HORS_SERVICE', hasOpenUsage: true }), v({ lifecycle: 'CEDE' }), v({ lifecycle: 'ARCHIVE', blockingNonCompliant: true }), v({})]);
    expect(t).toEqual({ active: 1, outOfService: 2, byStatus: { IMMOBILISE: 0, EN_UTILISATION: 0, DISPONIBLE: 1 }, nonCompliant: { active: 0, byStatus: { IMMOBILISE: 0, EN_UTILISATION: 0, DISPONIBLE: 0 } } });
  });
  it('« dont non conformes » : sous-ensemble de chaque groupe, sans changer la partition', () => {
    const t = tallyFleet([v({ blockingNonCompliant: true }), v({ hasOpenUsage: true, blockingNonCompliant: true }), v({ hasActiveImmobilization: true }), v({})]);
    expect(t.byStatus).toEqual({ IMMOBILISE: 1, EN_UTILISATION: 1, DISPONIBLE: 2 });
    expect(t.nonCompliant).toEqual({ active: 2, byStatus: { IMMOBILISE: 0, EN_UTILISATION: 1, DISPONIBLE: 1 } });
  });
});
