import { describe, expect, it } from 'vitest';
import { CAUSE_DURATIONS_NOTE, durationHours, immobilizationDurations } from './immobilization-duration.js';

const d = (iso: string) => new Date(iso);
const HOUR = 3600 * 1000;
const now = d('2026-09-24T10:00:00Z');

describe('durées d’immobilisation (D-219)', () => {
  it('total = union des causes : une superposition n’est comptée qu’une fois ; durée propre par cause', () => {
    const r = immobilizationDurations(
      [
        { id: 'a', startedAt: d('2026-09-20T10:00:00Z'), endedAt: d('2026-09-22T10:00:00Z') },
        { id: 'b', startedAt: d('2026-09-21T10:00:00Z'), endedAt: d('2026-09-23T16:00:00Z') },
      ],
      now,
    );
    expect(r.total.hours.toFixed(1)).toBe('78.0');
    expect(r.total.days.toFixed(1)).toBe('3.3');
    expect(r.total.ongoing).toBe(false);
    expect(r.causes.map((c) => [c.id, c.hours.toFixed(1), c.days.toFixed(1)])).toEqual([
      ['a', '48.0', '2.0'],
      ['b', '54.0', '2.3'],
    ]);
    expect(r.causesOverlap).toBe(true);
  });

  it('cause en cours comptée jusqu’à maintenant ; un trou entre causes n’est pas compté', () => {
    const r = immobilizationDurations(
      [
        { id: 'retro', startedAt: d('2026-09-23T00:00:00Z'), endedAt: d('2026-09-23T06:00:00Z') },
        { id: 'open', startedAt: d('2026-09-24T07:00:00Z'), endedAt: null },
      ],
      now,
    );
    expect(r.total.ms).toBe(9 * HOUR);
    expect(r.total.ongoing).toBe(true);
    expect(r.causes.find((c) => c.id === 'open')).toMatchObject({ ongoing: true, ms: 3 * HOUR });
    expect(r.causesOverlap).toBe(false);
  });

  it('sans cause : intervalle de l’immobilisation ; arrondi à une décimale, demi vers le haut', () => {
    const r = immobilizationDurations([], now, { start: d('2026-09-24T08:30:00Z'), end: null });
    expect(r.total.hours.toFixed(1)).toBe('1.5');
    expect(durationHours(0.25 * HOUR).toFixed(1)).toBe('0.3');
    expect(durationHours(0.24 * HOUR).toFixed(1)).toBe('0.2');
    expect(CAUSE_DURATIONS_NOTE).toContain('La somme des causes peut dépasser le total');
  });
});
