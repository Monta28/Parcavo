import { describe, expect, it } from 'vitest';
import { OUTBOX_DEFAULT_MAX_ATTEMPTS, outboxFailureOutcome, outboxLockUntil, outboxRetryDelayMinutes } from './outbox-retry.js';

const at = new Date('2026-09-24T10:00:00.000Z');

describe('reprises de l’outbox e-mail (CDC 9.4 ; D-261, D-263)', () => {
  it('délais 1, 2, 4, 8, 16, 32, 60 puis 60 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(outboxRetryDelayMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(outboxRetryDelayMinutes(12)).toBe(60);
    expect(() => outboxRetryDelayMinutes(0)).toThrow();
  });

  it('ECHEC avec prochaine tentative croissante, puis ABANDONNE à la 8e tentative échouée', () => {
    const next: string[] = [];
    for (let attempts = 1; attempts < OUTBOX_DEFAULT_MAX_ATTEMPTS; attempts += 1) {
      const outcome = outboxFailureOutcome(attempts, OUTBOX_DEFAULT_MAX_ATTEMPTS, at);
      expect(outcome.status).toBe('ECHEC');
      if (outcome.status === 'ECHEC') next.push(outcome.nextAttemptAt.toISOString());
    }
    expect(next).toEqual(['2026-09-24T10:01:00.000Z', '2026-09-24T10:02:00.000Z', '2026-09-24T10:04:00.000Z', '2026-09-24T10:08:00.000Z', '2026-09-24T10:16:00.000Z', '2026-09-24T10:32:00.000Z', '2026-09-24T11:00:00.000Z']);
    expect(outboxFailureOutcome(8, 8, at)).toEqual({ status: 'ABANDONNE' });
    expect(outboxFailureOutcome(9, 8, at)).toEqual({ status: 'ABANDONNE' });
  });

  it('verrou d’envoi de 2 minutes', () => {
    expect(outboxLockUntil(at).toISOString()).toBe('2026-09-24T10:02:00.000Z');
  });
});
