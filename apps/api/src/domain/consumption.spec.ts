import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeConsumption, entryEligibility, formatRatio, telemetrySignalOf, type ConsumptionEntry, type ConsumptionInput } from './consumption.js';

const d = (v: string | number) => new Decimal(v);
const at = (iso: string) => new Date(iso);
let seq = 0;

function fill(overrides: Omit<Partial<ConsumptionEntry>, 'filledAt'> & { filledAt: string; km?: string | null; kmStatus?: 'ACCEPTE' | 'EN_ATTENTE' | 'REJETE'; estimate?: boolean }): ConsumptionEntry {
  seq += 1;
  const { km, kmStatus, estimate, filledAt, ...rest } = overrides;
  return {
    id: `p${String(seq).padStart(3, '0')}`,
    filledAt: at(filledAt),
    createdAt: at(filledAt),
    status: 'VALIDE',
    energy: 'DIESEL',
    isFullTank: true,
    liters: d(40),
    odometer: km === null || km === undefined ? null : { status: kmStatus ?? 'ACCEPTE', cumulativeKm: d(km), isEstimate: estimate ?? false },
    tankCapacityExceeded: false,
    capacityConfirmed: false,
    ...rest,
  };
}

function run(entries: ConsumptionEntry[], extra: Partial<ConsumptionInput> = {}) {
  return computeConsumption({ entries, gaps: [], signals: [], period: { from: null, to: null }, ...extra });
}

/** T25 : A à 10 000 km, partiel intermédiaire 20 L, B à 10 400 km avec 30 L. */
function t25(): { a: ConsumptionEntry; mid: ConsumptionEntry; b: ConsumptionEntry } {
  return {
    a: fill({ filledAt: '2026-09-10T08:00:00Z', km: '10000', liters: d(45) }),
    mid: fill({ filledAt: '2026-09-15T08:00:00Z', km: '10200', liters: d(20), isFullTank: false }),
    b: fill({ filledAt: '2026-09-20T08:00:00Z', km: '10400', liters: d(30) }),
  };
}

describe('T25 — consommation entre deux pleins complets (CDC 8.3, D-227)', () => {
  it('50 L / 400 km × 100 = 12,5 L/100 km ; le carburant acheté en A n’est pas compté', () => {
    const { a, mid, b } = t25();
    const r = run([b, mid, a]);
    const retained = r.intervals.filter((i) => i.retained);
    expect(retained).toHaveLength(1);
    const i = retained[0];
    expect(i?.startEntryId).toBe(a.id);
    expect(i?.endEntryId).toBe(b.id);
    expect(i?.liters.toString()).toBe('50');
    expect(i?.distanceKm?.toString()).toBe('400');
    expect(i?.ratio?.toString()).toBe('12.5');
    expect(i?.entryIds).toEqual([mid.id, b.id]);
    expect(r.available).toBe(true);
    expect(r.totals).toHaveLength(1);
    expect(r.totals[0]).toMatchObject({ energy: 'DIESEL', available: true, retainedCount: 1, excludedCount: 1 });
    expect(r.totals[0]?.ratio && formatRatio(r.totals[0].ratio, 1)).toBe('12.5');
    // Le premier plein complet n'a pas de référence : intervalle exclu et motivé, jamais estimé.
    const first = r.intervals.find((x) => x.endEntryId === a.id);
    expect(first).toMatchObject({ retained: false, startEntryId: null, reasons: ['PAS_DE_PLEIN_DE_REFERENCE'], ratio: null });
  });

  it('historique insuffisant : un seul plein complet → N/D motivé, aucune valeur 0', () => {
    const r = run([fill({ filledAt: '2026-09-10T08:00:00Z', km: '10000' })]);
    expect(r.available).toBe(false);
    expect(r.totals[0]).toMatchObject({ available: false, ratio: null, liters: null, reasons: ['PAS_DE_PLEIN_DE_REFERENCE'] });
    expect(r.reasons).toEqual(['PAS_DE_PLEIN_DE_REFERENCE']);
  });

  it('aucun plein complet dans la période : N/D « historique insuffisant »', () => {
    const r = run([fill({ filledAt: '2026-09-10T08:00:00Z', km: '10000', isFullTank: false })]);
    expect(r).toMatchObject({ available: false, intervals: [], totals: [], reasons: ['HISTORIQUE_INSUFFISANT'] });
  });

  it('distance nulle entre deux pleins complets : N/D (jamais de division par zéro)', () => {
    const r = run([fill({ filledAt: '2026-09-10T08:00:00Z', km: '10000' }), fill({ filledAt: '2026-09-11T08:00:00Z', km: '10000', liters: d(5) })]);
    const last = r.intervals.at(-1);
    expect(last).toMatchObject({ retained: false, reasons: ['DISTANCE_NULLE'], ratio: null });
    expect(last?.distanceKm?.toString()).toBe('0');
    expect(r.available).toBe(false);
  });
});

describe('motifs N/D d’un intervalle (D-227, D-228)', () => {
  it('plein intermédiaire encore SOUMIS', () => {
    const { a, mid, b } = t25();
    const r = run([a, { ...mid, status: 'SOUMIS' }, b]);
    expect(r.intervals.at(-1)).toMatchObject({ retained: false, reasons: ['PLEIN_INTERMEDIAIRE_SOUMIS'] });
  });

  it('un plein complet SOUMIS n’est pas une borne : il rend l’intervalle N/D ; une fois validé, deux intervalles', () => {
    const { a, b } = t25();
    const pending = fill({ filledAt: '2026-09-15T08:00:00Z', km: '10200', liters: d(20), status: 'SOUMIS' });
    expect(run([a, pending, b]).intervals.at(-1)?.reasons).toEqual(['PLEIN_INTERMEDIAIRE_SOUMIS']);
    const validated = run([a, { ...pending, status: 'VALIDE' }, b]);
    expect(validated.intervals.filter((i) => i.retained).map((i) => i.ratio?.toString())).toEqual(['10', '15']);
  });

  it('borne B ou A à compteur non validé (relevé en attente ou absent)', () => {
    const { a, mid, b } = t25();
    expect(run([a, mid, { ...b, odometer: { status: 'EN_ATTENTE', cumulativeKm: d(10400), isEstimate: false } }]).intervals.at(-1)?.reasons).toEqual(['COMPTEUR_NON_VALIDE']);
    expect(run([{ ...a, odometer: null }, mid, b]).intervals.at(-1)?.reasons).toEqual(['COMPTEUR_NON_VALIDE']);
  });

  it('plein intermédiaire à compteur non validé : ses litres ne sont pas retirés, l’intervalle est N/D', () => {
    const { a, mid, b } = t25();
    const r = run([a, { ...mid, odometer: { status: 'REJETE', cumulativeKm: d(10200), isEstimate: false } }, b]);
    const last = r.intervals.at(-1);
    expect(last).toMatchObject({ retained: false, reasons: ['COMPTEUR_NON_VALIDE'] });
    expect(last?.liters.toString()).toBe('50');
  });

  it('borne estimée', () => {
    const { a, mid, b } = t25();
    expect(run([a, mid, { ...b, odometer: { status: 'ACCEPTE', cumulativeKm: d(10400), isEstimate: true } }]).intervals.at(-1)?.reasons).toEqual(['BORNE_ESTIMEE']);
  });

  it('capacité dépassée non confirmée, puis confirmée par le chef', () => {
    const { a, mid, b } = t25();
    expect(run([a, mid, { ...b, tankCapacityExceeded: true }]).intervals.at(-1)?.reasons).toEqual(['CAPACITE_NON_CONFIRMEE']);
    expect(run([a, { ...mid, tankCapacityExceeded: true }, b]).intervals.at(-1)?.reasons).toEqual(['CAPACITE_NON_CONFIRMEE']);
    expect(run([a, mid, { ...b, tankCapacityExceeded: true, capacityConfirmed: true }]).intervals.at(-1)?.retained).toBe(true);
  });

  it('période déclarée « achats incomplets » qui recoupe ]A, B]', () => {
    const { a, mid, b } = t25();
    const overlapping = run([a, mid, b], { gaps: [{ startsAt: at('2026-09-18T00:00:00Z'), endsAt: at('2026-09-19T00:00:00Z') }] });
    expect(overlapping.intervals.at(-1)?.reasons).toEqual(['PERIODE_ACHATS_INCOMPLETS']);
    const before = run([a, mid, b], { gaps: [{ startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-09-10T08:00:00Z') }] });
    expect(before.intervals.at(-1)?.retained).toBe(true);
  });

  it('achat d’une autre énergie dans l’intervalle ; chaque énergie a sa propre consommation', () => {
    const { a, mid, b } = t25();
    const gpl = fill({ filledAt: '2026-09-16T08:00:00Z', km: '10250', liters: d(25), energy: 'GPL' });
    const r = run([a, mid, gpl, b]);
    expect(r.intervals.find((i) => i.endEntryId === b.id)?.reasons).toEqual(['ENERGIE_DIFFERENTE']);
    // Le plein GPL forme sa propre chaîne (sans référence) : les litres ne sont jamais mélangés.
    expect(r.totals.map((t) => t.energy)).toEqual(['DIESEL', 'GPL']);
    expect(r.intervals.find((i) => i.endEntryId === gpl.id)?.reasons).toEqual(['PAS_DE_PLEIN_DE_REFERENCE']);
  });

  it('signaux télématiques : remplissage sans ticket, écart ticket non qualifié', () => {
    const { a, mid, b } = t25();
    const r = run([a, mid, b], { signals: [{ at: at('2026-09-17T08:00:00Z'), kind: 'REMPLISSAGE_SANS_TICKET' }, { at: at('2026-09-20T08:00:00Z'), kind: 'ECART_TICKET_NON_QUALIFIE' }] });
    expect(r.intervals.at(-1)?.reasons).toEqual(['REMPLISSAGE_SANS_TICKET', 'ECART_TICKET_NON_QUALIFIE']);
    // Un signal antérieur à A (ou égal à A) ne concerne pas l'intervalle ]A, B].
    expect(run([a, mid, b], { signals: [{ at: at('2026-09-10T08:00:00Z'), kind: 'REMPLISSAGE_SANS_TICKET' }] }).intervals.at(-1)?.retained).toBe(true);
  });

  it('plusieurs motifs sont tous restitués', () => {
    const { a, mid, b } = t25();
    const r = run([a, { ...mid, status: 'SOUMIS' }, { ...b, odometer: null }]);
    expect(r.intervals.at(-1)?.reasons).toEqual(['PLEIN_INTERMEDIAIRE_SOUMIS', 'COMPTEUR_NON_VALIDE']);
  });
});

describe('période et agrégation (D-227)', () => {
  it('somme des litres / somme des km des intervalles retenus dont B tombe dans la période', () => {
    const p1 = fill({ filledAt: '2026-08-30T08:00:00Z', km: '9500' });
    const p2 = fill({ filledAt: '2026-09-05T08:00:00Z', km: '10000', liters: d(40) });
    const p3 = fill({ filledAt: '2026-09-12T08:00:00Z', km: '10300', liters: d(24) });
    const p4 = fill({ filledAt: '2026-09-20T08:00:00Z', km: '10300', liters: d(1) });
    const r = run([p1, p2, p3, p4], { period: { from: at('2026-09-01T00:00:00Z'), to: at('2026-09-30T23:59:59Z') } });
    // p1 est hors période (pas d'intervalle listé) mais sert de référence à p2.
    expect(r.intervals.map((i) => i.endEntryId)).toEqual([p2.id, p3.id, p4.id]);
    expect(r.intervals.map((i) => i.retained)).toEqual([true, true, false]);
    const total = r.totals[0];
    expect(total?.liters?.toString()).toBe('64');
    expect(total?.distanceKm?.toString()).toBe('800');
    expect(total?.ratio?.toString()).toBe('8');
    expect(total).toMatchObject({ retainedCount: 2, excludedCount: 1 });
  });

  it('ratio exact conservé, arrondi à 1 décimale pour l’affichage et 2 pour l’export', () => {
    const r = run([fill({ filledAt: '2026-09-01T08:00:00Z', km: '10000' }), fill({ filledAt: '2026-09-10T08:00:00Z', km: '10300', liters: d(50) })]);
    const ratio = r.totals[0]?.ratio as Decimal;
    expect(ratio.toString()).toBe('16.666666666666666667');
    expect(formatRatio(ratio, 1)).toBe('16.7');
    expect(formatRatio(ratio, 2)).toBe('16.67');
  });

  it('ordre des pleins : date du plein puis date de saisie', () => {
    const a = fill({ filledAt: '2026-09-10T08:00:00Z', km: '10000' });
    const partial = { ...fill({ filledAt: '2026-09-20T08:00:00Z', km: '10400', liters: d(10), isFullTank: false }), createdAt: at('2026-09-20T07:00:00Z') };
    const b = { ...fill({ filledAt: '2026-09-20T08:00:00Z', km: '10400', liters: d(30) }), createdAt: at('2026-09-20T09:00:00Z') };
    const r = run([b, a, partial]);
    expect(r.intervals.at(-1)?.liters.toString()).toBe('40');
  });
});

describe('admissibilité d’un plein (D-222) et signaux F11', () => {
  it('plein validé sans relevé accepté : COMPTEUR_NON_VALIDE (coût compté, consommation exclue)', () => {
    expect(entryEligibility({ status: 'VALIDE', odometer: null, tankCapacityExceeded: false, capacityConfirmed: false })).toBe('COMPTEUR_NON_VALIDE');
    expect(entryEligibility({ status: 'SOUMIS', odometer: { status: 'ACCEPTE', cumulativeKm: d(1), isEstimate: false }, tankCapacityExceeded: false, capacityConfirmed: false })).toBe('NON_VALIDE');
    expect(entryEligibility({ status: 'VALIDE', odometer: { status: 'ACCEPTE', cumulativeKm: d(1), isEstimate: false }, tankCapacityExceeded: false, capacityConfirmed: false })).toBe('ADMISSIBLE');
  });
  it('événements carburant retenus comme signaux d’incomplétude', () => {
    const base = { detectedAt: at('2026-09-12T10:00:00Z'), fuelEntryId: null, status: 'A_QUALIFIER' as const, qualification: null };
    expect(telemetrySignalOf({ ...base, type: 'REMPLISSAGE_DETECTE' })?.kind).toBe('REMPLISSAGE_SANS_TICKET');
    expect(telemetrySignalOf({ ...base, type: 'REMPLISSAGE_DETECTE', fuelEntryId: 'p1' })).toBeNull();
    expect(telemetrySignalOf({ ...base, type: 'REMPLISSAGE_DETECTE', status: 'QUALIFIE', qualification: 'ERREUR_CAPTEUR' })).toBeNull();
    expect(telemetrySignalOf({ ...base, type: 'REMPLISSAGE_DETECTE', status: 'QUALIFIE', qualification: 'ANOMALIE_CONFIRMEE' })?.kind).toBe('REMPLISSAGE_SANS_TICKET');
    expect(telemetrySignalOf({ ...base, type: 'ECART_TICKET' })?.kind).toBe('ECART_TICKET_NON_QUALIFIE');
    expect(telemetrySignalOf({ ...base, type: 'ECART_TICKET', status: 'QUALIFIE', qualification: 'JUSTIFIE' })).toBeNull();
    expect(telemetrySignalOf({ ...base, type: 'BAISSE_ANORMALE' })).toBeNull();
  });
});
