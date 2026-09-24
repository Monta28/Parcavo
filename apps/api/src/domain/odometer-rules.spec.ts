import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { allowedIncrease, cumulativeKm, distanceBetween, evaluateReading, instantWindow, isOrdinaryFirstSegment, ordinaryFirstSegmentStart, pickCurrent, readingFieldForAnomaly, type EvaluateInput } from './odometer-rules.js';

const d = (v: number | string) => new Decimal(v);
const at = (iso: string) => new Date(iso);
const policy = { maxKmPerDay: d(1500), minAllowanceKm: d(300) };
const segment = { startPhysicalKm: d(0), startCumulativeKm: d(0), startedAt: at('2025-01-01T00:00:00Z') };

function base(overrides: Partial<EvaluateInput>): EvaluateInput {
  return {
    origin: 'MANUAL',
    physicalKm: d(1000),
    observedAt: at('2026-09-24T08:00:00Z'),
    now: at('2026-09-24T10:00:00Z'),
    segment,
    sameInstant: null,
    previous: null,
    next: null,
    policy,
    ...overrides,
  };
}

describe('cumul par segment (CDC 5.4, T14)', () => {
  it('égalité à l’initialisation ordinaire', () => {
    expect(cumulativeKm({ startPhysicalKm: d(45_000), startCumulativeKm: d(45_000) }, d(45_600)).toString()).toBe('45600');
  });
  it('remplacement à 120 000 par un compteur à 0 : lecture 500 = 120 500 cumulés', () => {
    expect(cumulativeKm({ startPhysicalKm: d(0), startCumulativeKm: d(120_000) }, d(500)).toString()).toBe('120500');
  });
});

describe('contrôles de chronologie (CDC 5.2, T09, T10)', () => {
  it('T09 — 89 000 après 89 500 dans le même segment : diminution refusée pour un relevé manuel', () => {
    const r = evaluateReading(base({ physicalKm: d(89_000), previous: { id: 'p', physicalKm: d(89_500), observedAt: at('2026-09-20T08:00:00Z') } }));
    expect(r).toMatchObject({ outcome: 'REJECT', code: 'DIMINUTION' });
  });
  it('T40 — la même diminution venant de la télématique passe en attente avec motif', () => {
    const r = evaluateReading(base({ origin: 'TELEMATICS', physicalKm: d(89_000), previous: { id: 'p', physicalKm: d(89_500), observedAt: at('2026-09-20T08:00:00Z') } }));
    expect(r).toMatchObject({ outcome: 'PENDING', code: 'DIMINUTION' });
  });
  it('T10 — un ancien relevé inséré entre deux voisins valides est accepté s’il respecte la chronologie', () => {
    const r = evaluateReading(
      base({
        physicalKm: d(10_200),
        observedAt: at('2026-09-10T08:00:00Z'),
        previous: { id: 'a', physicalKm: d(10_000), observedAt: at('2026-09-05T08:00:00Z') },
        next: { id: 'b', physicalKm: d(10_500), observedAt: at('2026-09-15T08:00:00Z') },
      }),
    );
    expect(r).toEqual({ outcome: 'ACCEPT' });
  });
  it('T10 — un ancien relevé supérieur au suivant rompt la chronologie', () => {
    const r = evaluateReading(
      base({
        physicalKm: d(10_600),
        observedAt: at('2026-09-10T08:00:00Z'),
        previous: { id: 'a', physicalKm: d(10_000), observedAt: at('2026-09-05T08:00:00Z') },
        next: { id: 'b', physicalKm: d(10_500), observedAt: at('2026-09-15T08:00:00Z') },
      }),
    );
    expect(r).toMatchObject({ outcome: 'REJECT', code: 'CHRONOLOGIE_SUIVANT' });
  });
  it('même instant : même valeur idempotente, valeur différente en conflit', () => {
    const same = { id: 'x', physicalKm: d(1000), observedAt: at('2026-09-24T08:00:00Z') };
    expect(evaluateReading(base({ sameInstant: same }))).toEqual({ outcome: 'IDEMPOTENT', existingId: 'x' });
    expect(evaluateReading(base({ physicalKm: d(1001), sameInstant: same }))).toMatchObject({ outcome: 'CONFLICT', code: 'CONFLIT_MEME_INSTANT' });
    expect(evaluateReading(base({ origin: 'TELEMATICS', physicalKm: d(1001), sameInstant: same }))).toMatchObject({ outcome: 'PENDING' });
  });
  it('refuse une valeur négative, une date future et une valeur sous le début du segment', () => {
    expect(evaluateReading(base({ physicalKm: d(-1) }))).toMatchObject({ outcome: 'REJECT', code: 'VALEUR_NEGATIVE' });
    expect(evaluateReading(base({ observedAt: at('2026-09-24T11:00:00Z') }))).toMatchObject({ outcome: 'REJECT', code: 'DATE_FUTURE' });
    expect(evaluateReading(base({ segment: { ...segment, startPhysicalKm: d(5000) }, physicalKm: d(4000) }))).toMatchObject({ outcome: 'REJECT', code: 'INFERIEUR_DEBUT_SEGMENT' });
    expect(evaluateReading(base({ observedAt: at('2024-12-31T00:00:00Z') }))).toMatchObject({ outcome: 'REJECT', code: 'AVANT_DEBUT_SEGMENT' });
  });
});

describe('seuil de plausibilité (CDC 5.2, 5.6)', () => {
  it('la tolérance minimale s’applique aux relevés rapprochés, le taux journalier au-delà', () => {
    expect(allowedIncrease(policy, at('2026-09-24T08:00:00Z'), at('2026-09-24T09:00:00Z')).toString()).toBe('300');
    expect(allowedIncrease(policy, at('2026-09-20T08:00:00Z'), at('2026-09-24T08:00:00Z')).toString()).toBe('6000');
  });
  it('une hausse au-delà du seuil est proposée à validation sans devenir courante', () => {
    const r = evaluateReading(base({ physicalKm: d(90_200), observedAt: at('2026-09-24T08:00:00Z'), previous: { id: 'p', physicalKm: d(80_000), observedAt: at('2026-09-23T08:00:00Z') } }));
    expect(r).toMatchObject({ outcome: 'PENDING', code: 'HAUSSE_IMPLAUSIBLE' });
  });
  it('une hausse compatible est acceptée', () => {
    const r = evaluateReading(base({ physicalKm: d(81_000), observedAt: at('2026-09-24T08:00:00Z'), previous: { id: 'p', physicalKm: d(80_000), observedAt: at('2026-09-23T08:00:00Z') } }));
    expect(r).toEqual({ outcome: 'ACCEPT' });
  });
});

describe('compteur courant et distances (CDC 5.3, 11.3)', () => {
  it('retient le dernier relevé selon la date d’observation, pas la date de saisie', () => {
    const old = { id: 'old', observedAt: at('2026-09-01T08:00:00Z'), enteredAt: at('2026-09-24T09:00:00Z') };
    const recent = { id: 'recent', observedAt: at('2026-09-20T08:00:00Z'), enteredAt: at('2026-09-20T08:05:00Z') };
    expect(pickCurrent([recent, old])?.id).toBe('recent');
    expect(pickCurrent([])).toBeNull();
  });
  it('distance null si une borne manque ou si elle serait négative', () => {
    expect(distanceBetween(d(10_000), d(10_400))?.toString()).toBe('400');
    expect(distanceBetween(null, d(10_400))).toBeNull();
    expect(distanceBetween(d(10_400), d(10_000))).toBeNull();
  });
});

describe('même instant (D-149)', () => {
  it('minute pour MANUAL et IMPORT, seconde pour TELEMATICS', () => {
    const at = new Date('2026-09-24T08:15:42.345Z');
    expect(instantWindow('MANUAL', at)).toEqual({ gte: new Date('2026-09-24T08:15:00.000Z'), lt: new Date('2026-09-24T08:16:00.000Z') });
    expect(instantWindow('IMPORT', at)).toEqual({ gte: new Date('2026-09-24T08:15:00.000Z'), lt: new Date('2026-09-24T08:16:00.000Z') });
    expect(instantWindow('TELEMATICS', at)).toEqual({ gte: new Date('2026-09-24T08:15:42.000Z'), lt: new Date('2026-09-24T08:15:43.000Z') });
  });
});

describe('champ concerné par une anomalie (erreurs de champ)', () => {
  it('rattache les anomalies de date à la date d’observation et les autres à la valeur du compteur', () => {
    expect(readingFieldForAnomaly('DATE_FUTURE')).toBe('observedAt');
    expect(readingFieldForAnomaly('AVANT_DEBUT_SEGMENT')).toBe('observedAt');
    for (const code of ['VALEUR_NEGATIVE', 'DIMINUTION', 'CHRONOLOGIE_SUIVANT', 'HAUSSE_IMPLAUSIBLE', 'CONFLIT_MEME_INSTANT', 'INFERIEUR_DEBUT_SEGMENT']) {
      expect(readingFieldForAnomaly(code)).toBe('physicalKm');
    }
  });
});

describe('segment 1 d’initialisation ordinaire (D-167)', () => {
  const ordinary = { sequence: 1, cumulativeKnown: true, startPhysicalKm: d(45_200), startCumulativeKm: d(45_200) };
  it('ordinaire : segment 1, cumul connu égal au physique, sans relevé d’initialisation explicite', () => {
    expect(isOrdinaryFirstSegment(ordinary, false)).toBe(true);
    expect(isOrdinaryFirstSegment(ordinary, true)).toBe(false);
    expect(isOrdinaryFirstSegment({ ...ordinary, sequence: 2 }, false)).toBe(false);
    expect(isOrdinaryFirstSegment({ ...ordinary, cumulativeKnown: false }, false)).toBe(false);
    expect(isOrdinaryFirstSegment({ ...ordinary, startCumulativeKm: d(150_000) }, false)).toBe(false);
  });
  it('seuls les voisins contraignent un relevé d’un segment ordinaire (début = premier relevé accepté)', () => {
    const seg = { ...segment, startPhysicalKm: d(452_000), startCumulativeKm: d(452_000), startedAt: at('2026-09-20T08:00:00Z') };
    // Correction du premier relevé (faute de frappe) ou soumission rejetée qui avait fixé le début.
    expect(evaluateReading(base({ segment: { ...seg, ordinary: true }, physicalKm: d(45_200), observedAt: at('2026-09-20T08:00:00Z') }))).toEqual({ outcome: 'ACCEPT' });
    expect(evaluateReading(base({ segment: { ...seg, ordinary: true }, physicalKm: d(45_000), observedAt: at('2026-09-18T08:00:00Z') }))).toEqual({ outcome: 'ACCEPT' });
    const next = { id: 'n', physicalKm: d(45_100), observedAt: at('2026-09-22T08:00:00Z') };
    expect(evaluateReading(base({ segment: { ...seg, ordinary: true }, physicalKm: d(45_200), observedAt: at('2026-09-18T08:00:00Z'), next }))).toMatchObject({ outcome: 'REJECT', code: 'CHRONOLOGIE_SUIVANT' });
    // Segment déclaré (initialisation explicite) : son début reste une contrainte.
    expect(evaluateReading(base({ segment: seg, physicalKm: d(45_200), observedAt: at('2026-09-20T08:00:00Z') }))).toMatchObject({ outcome: 'REJECT', code: 'INFERIEUR_DEBUT_SEGMENT' });
    expect(evaluateReading(base({ segment: seg, physicalKm: d(460_000), observedAt: at('2026-09-18T08:00:00Z') }))).toMatchObject({ outcome: 'REJECT', code: 'AVANT_DEBUT_SEGMENT' });
  });
  it('le début suit le premier relevé accepté et la période couverte ne recule jamais', () => {
    const current = { startedAt: at('2026-09-20T08:00:00Z'), startPhysicalKm: d(452_000) };
    expect(ordinaryFirstSegmentStart(current, null)).toBeNull();
    expect(ordinaryFirstSegmentStart(current, { observedAt: at('2026-09-20T08:00:00Z'), physicalKm: d(452_000) })).toBeNull();
    expect(ordinaryFirstSegmentStart(current, { observedAt: at('2026-09-20T08:00:00Z'), physicalKm: d(45_200) })).toEqual({ startedAt: at('2026-09-20T08:00:00Z'), startPhysicalKm: d(45_200) });
    expect(ordinaryFirstSegmentStart(current, { observedAt: at('2026-09-18T08:00:00Z'), physicalKm: d(45_000) })).toEqual({ startedAt: at('2026-09-18T08:00:00Z'), startPhysicalKm: d(45_000) });
    // Premier relevé accepté postérieur au début (soumission provisoire rejetée) : la date de début est conservée.
    expect(ordinaryFirstSegmentStart(current, { observedAt: at('2026-09-24T09:00:00Z'), physicalKm: d(50_000) })).toEqual({ startedAt: at('2026-09-20T08:00:00Z'), startPhysicalKm: d(50_000) });
  });
});
