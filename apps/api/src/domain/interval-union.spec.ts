import { describe, expect, it } from 'vitest';
import { durationDays, unionWithinPeriod } from './interval-union.js';

const d = (iso: string) => new Date(iso);
const period = { from: d('2026-09-01T00:00:00Z'), to: d('2026-09-30T23:59:59.999Z') };
const DAY = 24 * 3600 * 1000;

describe('unionWithinPeriod (D-271)', () => {
  it('ne compte jamais deux fois des intervalles qui se chevauchent', () => {
    const result = unionWithinPeriod(
      [
        { start: d('2026-09-02T00:00:00Z'), end: d('2026-09-06T00:00:00Z') },
        { start: d('2026-09-04T00:00:00Z'), end: d('2026-09-08T00:00:00Z') },
        { start: d('2026-09-20T00:00:00Z'), end: d('2026-09-21T00:00:00Z') },
      ],
      period,
      d('2026-09-24T10:00:00Z'),
    );
    expect(result.intervals).toHaveLength(2);
    expect(result.totalMs).toBe(7 * DAY);
    expect(result.ongoing).toBe(false);
  });

  it('découpe à la période et borne un intervalle en cours à maintenant', () => {
    const result = unionWithinPeriod(
      [
        { start: d('2026-08-25T00:00:00Z'), end: d('2026-09-03T00:00:00Z') },
        { start: d('2026-09-22T10:00:00Z'), end: null },
      ],
      period,
      d('2026-09-24T10:00:00Z'),
    );
    expect(result.totalMs).toBe(2 * DAY + 2 * DAY);
    expect(result.ongoing).toBe(true);
    expect(durationDays(result.totalMs).toFixed(1)).toBe('4.0');
  });

  it('borne un intervalle en cours à la fin de période quand la période est close', () => {
    const past = { from: d('2026-08-01T00:00:00Z'), to: d('2026-08-31T00:00:00Z') };
    const result = unionWithinPeriod([{ start: d('2026-08-30T00:00:00Z'), end: null }], past, d('2026-09-24T10:00:00Z'));
    expect(result.totalMs).toBe(DAY);
    expect(result.ongoing).toBe(true);
  });

  it('ignore les intervalles hors période et fusionne les intervalles contigus', () => {
    const result = unionWithinPeriod(
      [
        { start: d('2026-10-02T00:00:00Z'), end: d('2026-10-03T00:00:00Z') },
        { start: d('2026-09-10T00:00:00Z'), end: d('2026-09-11T00:00:00Z') },
        { start: d('2026-09-11T00:00:00Z'), end: d('2026-09-12T12:00:00Z') },
      ],
      period,
      d('2026-09-24T10:00:00Z'),
    );
    expect(result.intervals).toHaveLength(1);
    expect(durationDays(result.totalMs).toFixed(1)).toBe('2.5');
  });

  it('arrondit les jours à une décimale, demi vers le haut', () => {
    expect(durationDays(DAY * 1.25).toFixed(1)).toBe('1.3');
    expect(durationDays(0).toFixed(1)).toBe('0.0');
  });
});
