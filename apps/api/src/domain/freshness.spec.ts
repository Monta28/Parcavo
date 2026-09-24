import { describe, expect, it } from 'vitest';
import { computeFreshness, staleBefore } from './freshness.js';

describe('fraîcheur du kilométrage (CDC 5.5, T12)', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  it('sans relevé accepté : INCONNU', () => {
    expect(computeFreshness(null, now, 7)).toEqual({ status: 'INCONNU', ageDays: null, lastObservedAt: null });
  });
  it('relevé de moins de sept jours : A_JOUR ; exactement sept jours : encore A_JOUR ; au-delà : A_ACTUALISER', () => {
    expect(computeFreshness(new Date('2026-09-20T10:00:00Z'), now, 7).status).toBe('A_JOUR');
    expect(computeFreshness(new Date('2026-09-17T10:00:00Z'), now, 7).status).toBe('A_JOUR');
    expect(computeFreshness(new Date('2026-09-17T09:59:59Z'), now, 7)).toMatchObject({ status: 'A_ACTUALISER', ageDays: 7 });
    expect(computeFreshness(new Date('2026-08-01T00:00:00Z'), now, 7)).toMatchObject({ status: 'A_ACTUALISER', ageDays: 54 });
  });
  it('le seuil de liste coïncide avec le statut : strictement avant la limite → A_ACTUALISER', () => {
    const limit = staleBefore(now, 7);
    expect(limit.toISOString()).toBe('2026-09-17T10:00:00.000Z');
    expect(computeFreshness(limit, now, 7).status).toBe('A_JOUR');
    expect(computeFreshness(new Date(limit.getTime() - 1), now, 7).status).toBe('A_ACTUALISER');
    expect(staleBefore(now, 30).toISOString()).toBe('2026-08-25T10:00:00.000Z');
  });
  it('respecte un seuil configuré différent', () => {
    expect(computeFreshness(new Date('2026-09-17T09:59:59Z'), now, 30).status).toBe('A_JOUR');
    expect(computeFreshness(new Date('2026-09-22T09:59:59Z'), now, 1).status).toBe('A_ACTUALISER');
  });
});
