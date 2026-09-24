import { describe, expect, it } from 'vitest';
import { returnDelay } from './return-delay.js';

const d = (iso: string) => new Date(iso);

describe('returnDelay', () => {
  it('retour réel après le retour prévu au-delà de la tolérance : retard en minutes', () => {
    expect(returnDelay({ expectedReturnAt: d('2026-09-24T10:00:00Z'), returnedAt: d('2026-09-24T11:30:00Z'), now: d('2026-09-25T00:00:00Z'), toleranceMinutes: 15 })).toEqual({ late: true, delayMinutes: 90, ongoing: false });
  });

  it('dans la tolérance : pas de retard', () => {
    expect(returnDelay({ expectedReturnAt: d('2026-09-24T10:00:00Z'), returnedAt: d('2026-09-24T10:10:00Z'), now: d('2026-09-25T00:00:00Z'), toleranceMinutes: 15 })).toEqual({ late: false, delayMinutes: null, ongoing: false });
  });

  it('utilisation en cours : retard mesuré à maintenant', () => {
    expect(returnDelay({ expectedReturnAt: d('2026-09-24T08:00:00Z'), returnedAt: null, now: d('2026-09-24T10:00:00Z'), toleranceMinutes: 0 })).toEqual({ late: true, delayMinutes: 120, ongoing: true });
    expect(returnDelay({ expectedReturnAt: d('2026-09-24T12:00:00Z'), returnedAt: null, now: d('2026-09-24T10:00:00Z'), toleranceMinutes: 0 })).toEqual({ late: false, delayMinutes: null, ongoing: false });
  });
});
