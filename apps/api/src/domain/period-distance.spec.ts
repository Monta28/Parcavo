import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { costBasis, costPerKm, ownershipSegments, periodDistance, periodDistances, type CompanyTransfer, type PeriodReading } from './period-distance.js';

const period = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T23:59:59.999Z') };

function reading(id: string, observedAt: string, km: string, extra: Partial<PeriodReading> = {}): PeriodReading {
  return { id, observedAt: new Date(observedAt), enteredAt: new Date(observedAt), cumulativeKm: new Decimal(km), isEstimate: false, companyId: 'A', isTransfer: false, segmentSequence: 1, segmentCumulativeKnown: true, ...extra };
}

describe('periodDistance (D-274)', () => {
  it('R1 et R2 sont le premier et le dernier relevé accepté de la période ; distance = différence des cumulés', () => {
    const result = periodDistance(
      [reading('r3', '2026-09-20T08:00:00Z', '11500'), reading('r0', '2026-08-31T08:00:00Z', '9000'), reading('r1', '2026-09-02T08:00:00Z', '10000'), reading('r2', '2026-09-10T08:00:00Z', '10800'), reading('r4', '2026-10-01T08:00:00Z', '12000')],
      period,
    );
    expect(result.available).toBe(true);
    expect(result.start?.id).toBe('r1');
    expect(result.end?.id).toBe('r3');
    expect(result.distanceKm?.toFixed(3)).toBe('1500.000');
    expect(result.readingCount).toBe(3);
    expect(result.estimated).toBe(false);
    // 18 jours observés sur une période de 30 jours.
    expect(result.coverage?.toDecimalPlaces(2).toNumber()).toBeCloseTo(0.6, 2);
  });

  it('N/D (jamais 0) avec moins de deux relevés, ou deux relevés au même instant', () => {
    expect(periodDistance([], period)).toMatchObject({ available: false, reason: 'RELEVES_INSUFFISANTS', distanceKm: null, coverage: null });
    expect(periodDistance([reading('a', '2026-09-05T08:00:00Z', '100')], period)).toMatchObject({ available: false, reason: 'RELEVES_INSUFFISANTS', distanceKm: null });
    expect(periodDistance([reading('a', '2026-09-05T08:00:00Z', '100'), reading('b', '2026-09-05T08:00:00Z', '100')], period).reason).toBe('RELEVES_INSUFFISANTS');
  });

  it('N/D pour un cumul incomplet entre deux compteurs, mais distance exacte au sein d’un même compteur', () => {
    const crossing = periodDistance([reading('a', '2026-09-02T08:00:00Z', '5000', { segmentSequence: 1, segmentCumulativeKnown: false }), reading('b', '2026-09-25T08:00:00Z', '300', { segmentSequence: 2, segmentCumulativeKnown: false })], period);
    expect(crossing).toMatchObject({ available: false, reason: 'CUMUL_INCOMPLET', distanceKm: null });
    const sameSegment = periodDistance([reading('a', '2026-09-02T08:00:00Z', '5000', { segmentCumulativeKnown: false }), reading('b', '2026-09-25T08:00:00Z', '5400', { segmentCumulativeKnown: false })], period);
    expect(sameSegment.available).toBe(true);
    expect(sameSegment.distanceKm?.toFixed(0)).toBe('400');
  });

  it('sociétés différentes : non ventilable sans relevé de transfert, calculable avec', () => {
    const without = periodDistance([reading('a', '2026-09-02T08:00:00Z', '1000', { companyId: 'A' }), reading('b', '2026-09-25T08:00:00Z', '1600', { companyId: 'B' })], period);
    expect(without).toMatchObject({ available: false, reason: 'NON_VENTILABLE', distanceKm: null });
    const withTransfer = periodDistance(
      [reading('a', '2026-09-02T08:00:00Z', '1000', { companyId: 'A' }), reading('t', '2026-09-12T08:00:00Z', '1200', { companyId: 'A', isTransfer: true }), reading('b', '2026-09-25T08:00:00Z', '1600', { companyId: 'B' })],
      period,
    );
    expect(withTransfer.available).toBe(true);
    expect(withTransfer.distanceKm?.toFixed(0)).toBe('600');
  });

  it('une borne estimée (GPS) rend la distance estimée', () => {
    const result = periodDistance([reading('a', '2026-09-02T08:00:00Z', '1000'), reading('g', '2026-09-28T08:00:00Z', '1450.5', { isEstimate: true })], period);
    expect(result).toMatchObject({ available: true, estimated: true });
    expect(result.distanceKm?.toFixed(1)).toBe('450.5');
  });

  it('un cumul décroissant ne produit jamais de distance négative', () => {
    expect(periodDistance([reading('a', '2026-09-02T08:00:00Z', '1000'), reading('b', '2026-09-28T08:00:00Z', '900')], period).reason).toBe('CHRONOLOGIE_INCOHERENTE');
  });
});

describe('costPerKm (D-274, D-276)', () => {
  const full = periodDistance([reading('a', '2026-09-01T00:00:00Z', '1000'), reading('b', '2026-09-30T20:00:00Z', '2000')], period);

  it('coût net / distance quand la couverture est suffisante', () => {
    const result = costPerKm({ distance: full, cost: { net: new Decimal('250.500'), count: 3 }, minCoverage: 0.5 });
    expect(result.available).toBe(true);
    expect(result.value?.toFixed(5)).toBe('0.25050');
    expect(result.estimated).toBe(false);
  });

  it('N/D : distance indisponible, nulle, couverture insuffisante ou coûts absents — jamais 0 ni division par zéro', () => {
    const none = periodDistance([reading('a', '2026-09-02T08:00:00Z', '1000')], period);
    expect(costPerKm({ distance: none, cost: { net: new Decimal(100), count: 1 }, minCoverage: 0.5 })).toMatchObject({ available: false, reason: 'DISTANCE_INDISPONIBLE', value: null });
    const zero = periodDistance([reading('a', '2026-09-01T08:00:00Z', '1000'), reading('b', '2026-09-30T08:00:00Z', '1000')], period);
    expect(zero.distanceKm?.toFixed(0)).toBe('0');
    expect(costPerKm({ distance: zero, cost: { net: new Decimal(100), count: 1 }, minCoverage: 0.5 })).toMatchObject({ available: false, reason: 'DISTANCE_NULLE', value: null });
    const short = periodDistance([reading('a', '2026-09-10T08:00:00Z', '1000'), reading('b', '2026-09-12T08:00:00Z', '1200')], period);
    expect(costPerKm({ distance: short, cost: { net: new Decimal(100), count: 1 }, minCoverage: 0.5 })).toMatchObject({ available: false, reason: 'COUVERTURE_INSUFFISANTE' });
    expect(costPerKm({ distance: full, cost: { net: new Decimal(0), count: 0 }, minCoverage: 0.5 })).toMatchObject({ available: false, reason: 'AUCUNE_DEPENSE', value: null });
  });

  it('un coût/km fondé sur une borne estimée est marqué estimé', () => {
    const estimated = periodDistance([reading('a', '2026-09-01T08:00:00Z', '1000'), reading('b', '2026-09-30T08:00:00Z', '1500', { isEstimate: true })], period);
    expect(costPerKm({ distance: estimated, cost: { net: new Decimal(50), count: 1 }, minCoverage: 0.5 })).toMatchObject({ available: true, estimated: true });
  });
});

describe('bornes physiques par défaut, colonne estimée séparée (D-276)', () => {
  it('la distance par défaut ignore les estimations GPS ; la colonne estimée les inclut et est libellée', () => {
    const readings = [reading('g1', '2026-09-01T08:00:00Z', '900', { isEstimate: true }), reading('m1', '2026-09-05T08:00:00Z', '1000'), reading('m2', '2026-09-20T08:00:00Z', '1400'), reading('g2', '2026-09-29T08:00:00Z', '1650', { isEstimate: true })];
    const result = periodDistances(readings, period);
    expect(result.physical).toMatchObject({ available: true, estimated: false, readingCount: 2 });
    expect(result.physical.distanceKm?.toFixed(0)).toBe('400');
    expect(result.estimated).toMatchObject({ available: true, estimated: true, readingCount: 4 });
    expect(result.estimated?.distanceKm?.toFixed(0)).toBe('750');
    expect(costBasis(result)).toBe(result.physical);
  });

  it('sans borne estimée, pas de colonne estimée ; sans distance physique, le coût/km se fonde sur l’estimation (marquée)', () => {
    expect(periodDistances([reading('m1', '2026-09-05T08:00:00Z', '1000'), reading('m2', '2026-09-20T08:00:00Z', '1400')], period).estimated).toBeNull();
    const gpsOnly = periodDistances([reading('m1', '2026-09-01T08:00:00Z', '1000'), reading('g1', '2026-09-30T08:00:00Z', '1600', { isEstimate: true })], period);
    expect(gpsOnly.physical).toMatchObject({ available: false, reason: 'RELEVES_INSUFFISANTS' });
    const basis = costBasis(gpsOnly);
    expect(basis).toBe(gpsOnly.estimated);
    expect(costPerKm({ distance: basis, cost: { net: new Decimal(300), count: 2 }, minCoverage: 0.5 })).toMatchObject({ available: true, estimated: true });
    expect(costPerKm({ distance: basis, cost: { net: new Decimal(300), count: 2 }, minCoverage: 0.5 }).value?.toFixed(3)).toBe('0.500');
  });
});

describe('ownershipSegments (CDC 11.3, D-275)', () => {
  const transfer = (effectiveAt: string, fromCompanyId: string, toCompanyId: string, hasTransferReading = true): CompanyTransfer => ({ effectiveAt: new Date(effectiveAt), fromCompanyId, toCompanyId, hasTransferReading });

  it('sans transfert, un seul segment pour la société courante sur toute la période', () => {
    expect(ownershipSegments([], 'B', period)).toEqual([{ companyId: 'B', from: period.from, to: period.to, entry: null, exit: null }]);
  });

  it('un transfert au milieu de la période découpe la période entre les deux sociétés', () => {
    const t = transfer('2026-09-12T10:00:00Z', 'A', 'B');
    expect(ownershipSegments([t], 'B', period)).toEqual([
      { companyId: 'A', from: period.from, to: t.effectiveAt, entry: null, exit: t },
      { companyId: 'B', from: t.effectiveAt, to: period.to, entry: t, exit: null },
    ]);
  });

  it('transferts hors période : seule la société détentrice pendant la période ; chaîne A → B → C', () => {
    expect(ownershipSegments([transfer('2026-08-01T00:00:00Z', 'A', 'B'), transfer('2026-10-15T00:00:00Z', 'B', 'C')], 'C', period)).toEqual([{ companyId: 'B', from: period.from, to: period.to, entry: null, exit: null }]);
    const chain = ownershipSegments([transfer('2026-09-20T00:00:00Z', 'B', 'C'), transfer('2026-09-10T00:00:00Z', 'A', 'B', false)], 'C', period);
    expect(chain.map((s) => [s.companyId, s.from.toISOString(), s.to.toISOString(), s.entry?.hasTransferReading ?? null, s.exit?.hasTransferReading ?? null])).toEqual([
      ['A', period.from.toISOString(), '2026-09-10T00:00:00.000Z', null, false],
      ['B', '2026-09-10T00:00:00.000Z', '2026-09-20T00:00:00.000Z', false, true],
      ['C', '2026-09-20T00:00:00.000Z', period.to.toISOString(), true, null],
    ]);
  });

  it('chaque part ne compte que ses relevés, bornés par le relevé de transfert commun', () => {
    const t = transfer('2026-09-12T10:00:00Z', 'A', 'B');
    const [partA, partB] = ownershipSegments([t], 'B', period);
    const readings = [
      reading('a1', '2026-09-02T08:00:00Z', '1000', { companyId: 'A' }),
      reading('t', '2026-09-12T10:00:00Z', '1300', { companyId: 'A', isTransfer: true }),
      reading('b1', '2026-09-25T08:00:00Z', '1700', { companyId: 'B' }),
    ];
    const own = (companyId: string) => readings.filter((r) => r.companyId === companyId || (companyId === 'B' && r.isTransfer));
    expect(periodDistance(own('A'), { from: partA!.from, to: partA!.to }).distanceKm?.toFixed(0)).toBe('300');
    expect(periodDistance(own('B'), { from: partB!.from, to: partB!.to }).distanceKm?.toFixed(0)).toBe('400');
  });
});
