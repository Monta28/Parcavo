import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeDrift, estimateFromGps, formatPercent, sampleForInstant } from './gps-calibration.js';

const d = (v: number) => new Decimal(v);
const at = (iso: string) => new Date(iso);

describe('Calibrage GPS (CDC 5.6 — T38, T39)', () => {
  const reference = { manualKm: d(80_000), gpsDistanceKm: d(12_000), observedAt: at('2026-09-20T08:00:00Z') };

  it('T38 — référence manuelle 80 000 à distanceGps 12 000 ; distanceGps 12 450 → 80 450 estimé', () => {
    expect(estimateFromGps(reference, d(12_450))?.toString()).toBe('80450');
  });

  it('sans référence, ou si la distance GPS recule (changement de boîtier), aucune estimation n’est fabriquée', () => {
    expect(estimateFromGps(null, d(12_450))).toBeNull();
    expect(estimateFromGps(reference, d(11_999))).toBeNull();
  });

  it('T39 — estimation 81 000 depuis 80 000, restitution manuelle 80 960 : écart 4,2 %, au-delà de 3 %', () => {
    const sample = { observedAt: at('2026-09-24T17:55:00Z'), gpsDistanceKm: d(13_000) };
    const drift = computeDrift(reference, sample, d(80_960), 3);
    expect(drift?.estimateKm.toString()).toBe('81000');
    expect(formatPercent(drift?.percent as Decimal)).toBe('4,2');
    expect(drift?.exceeded).toBe(true);
    const small = computeDrift(reference, { observedAt: sample.observedAt, gpsDistanceKm: d(12_980) }, d(80_960), 3);
    expect(formatPercent(small?.percent as Decimal)).toBe('2,1');
    expect(small?.exceeded).toBe(false);
  });

  it('pas de mesure de dérive si l’échantillon est trop éloigné ou la distance trop courte', () => {
    const samples = [{ observedAt: at('2026-09-24T17:00:00Z'), gpsDistanceKm: d(13_000) }];
    expect(sampleForInstant(samples, at('2026-09-24T18:00:00Z'))).toBeNull();
    expect(sampleForInstant(samples, at('2026-09-24T17:20:00Z'))).not.toBeNull();
    expect(sampleForInstant([{ observedAt: at('2026-09-24T18:10:00Z'), gpsDistanceKm: d(1) }], at('2026-09-24T18:00:00Z'))).toBeNull();
    expect(computeDrift(reference, { observedAt: at('2026-09-20T09:00:00Z'), gpsDistanceKm: d(12_030) }, d(80_020), 3)).toBeNull();
  });
});
