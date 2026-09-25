import { describe, expect, it } from 'vitest';
import { ProviderError } from '../telemetry-provider.interface.js';
import { DEFAULT_SYNC_POLICY, betweenRunsDelayMs, callWithRetries, failureTransition, retryDelayMs, scheduleDecision } from './telemetry-resilience.js';

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

describe('Résilience de la synchronisation télématique (D-297)', () => {
  it('reprises dans un run après 1, 4 puis 16 s pour une erreur transitoire, jamais pour une erreur d’authentification', () => {
    const down = new ProviderError('INJOIGNABLE', 'connexion refusée');
    expect([0, 1, 2, 3].map((i) => retryDelayMs(down, i))).toEqual([1000, 4000, 16000, null]);
    expect(retryDelayMs(new ProviderError('AUTHENTIFICATION', '401'), 0)).toBeNull();
    expect(retryDelayMs(new ProviderError('CONFIGURATION', 'x'), 0)).toBeNull();
    expect(retryDelayMs(new Error('bogue'), 0)).toBeNull();
  });

  it('un 429 respecte Retry-After ; au-delà du plafond d’attente, aucune reprise dans le run', () => {
    expect(retryDelayMs(new ProviderError('QUOTA', '429', 30), 0)).toBe(30_000);
    expect(retryDelayMs(new ProviderError('QUOTA', '429', 3600), 0)).toBeNull();
    expect(retryDelayMs(new ProviderError('QUOTA', '429', null), 1)).toBe(4000);
  });

  it('délai entre runs : intervalle × 2^n plafonné à 60 min, jamais sous l’intervalle', () => {
    expect([0, 1, 2, 3, 10].map((n) => betweenRunsDelayMs(15, n) / MIN)).toEqual([15, 30, 60, 60, 60]);
    expect(betweenRunsDelayMs(5, 3) / MIN).toBe(40);
    expect(betweenRunsDelayMs(120, 2) / MIN).toBe(120);
  });

  it('planification : premier run immédiat, puis délai exponentiel ; reprise initiale immédiate si le fournisseur est sain', () => {
    const now = at('2026-09-24T10:00:00Z');
    expect(scheduleDecision({ now, lastRunAt: null, intervalMinutes: 15, consecutiveFailures: 0, circuitOpenUntil: null })).toEqual({ kind: 'RUN', halfOpen: false });
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:50:00Z'), intervalMinutes: 15, consecutiveFailures: 0, circuitOpenUntil: null }).kind).toBe('NOT_DUE');
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:45:00Z'), intervalMinutes: 15, consecutiveFailures: 0, circuitOpenUntil: null }).kind).toBe('RUN');
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:45:00Z'), intervalMinutes: 15, consecutiveFailures: 1, circuitOpenUntil: null }).kind).toBe('NOT_DUE');
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:30:00Z'), intervalMinutes: 15, consecutiveFailures: 1, circuitOpenUntil: null }).kind).toBe('RUN');
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:59:00Z'), intervalMinutes: 15, consecutiveFailures: 0, circuitOpenUntil: null, backfillPending: true }).kind).toBe('RUN');
    expect(scheduleDecision({ now, lastRunAt: at('2026-09-24T09:59:00Z'), intervalMinutes: 15, consecutiveFailures: 2, circuitOpenUntil: null, backfillPending: true }).kind).toBe('NOT_DUE');
  });

  it('coupe-circuit : créneaux ignorés pendant l’ouverture, puis essai unique immédiat', () => {
    const until = at('2026-09-24T11:00:00Z');
    const open = { intervalMinutes: 15, consecutiveFailures: 5, circuitOpenUntil: until };
    expect(scheduleDecision({ ...open, now: at('2026-09-24T10:15:00Z'), lastRunAt: at('2026-09-24T10:00:00Z') })).toEqual({ kind: 'IGNORE', circuitOpenUntil: until });
    expect(scheduleDecision({ ...open, now: at('2026-09-24T10:20:00Z'), lastRunAt: at('2026-09-24T10:15:00Z') }).kind).toBe('NOT_DUE');
    expect(scheduleDecision({ ...open, now: at('2026-09-24T11:00:00Z'), lastRunAt: at('2026-09-24T10:45:00Z') })).toEqual({ kind: 'RUN', halfOpen: true });
    // Essai resté sans appel (aucune association) : pas de nouveau run à chaque passage, seulement à l'intervalle.
    expect(scheduleDecision({ ...open, now: at('2026-09-24T11:01:00Z'), lastRunAt: at('2026-09-24T11:00:00Z') })).toEqual({ kind: 'NOT_DUE', nextAt: at('2026-09-24T11:15:00Z') });
    expect(scheduleDecision({ ...open, now: at('2026-09-24T11:15:00Z'), lastRunAt: at('2026-09-24T11:00:00Z') })).toEqual({ kind: 'RUN', halfOpen: true });
    expect(scheduleDecision({ ...open, circuitOpenUntil: null, now: at('2026-09-24T11:05:00Z'), lastRunAt: at('2026-09-24T11:00:00Z') }).kind).toBe('NOT_DUE');
  });

  it('transition d’échec : ouverture au 5e échec consécutif pour 60 min ; report de quota sans ouverture', () => {
    const now = at('2026-09-24T10:00:00Z');
    expect(failureTransition({ consecutiveFailures: 3, now })).toEqual({ consecutiveFailures: 4, circuitOpenUntil: null, circuitOpened: false });
    expect(failureTransition({ consecutiveFailures: 4, now })).toEqual({ consecutiveFailures: 5, circuitOpenUntil: at('2026-09-24T11:00:00Z'), circuitOpened: true });
    expect(failureTransition({ consecutiveFailures: 5, now }).circuitOpened).toBe(true);
    expect(failureTransition({ consecutiveFailures: 0, now, retryAfterSeconds: 7200 })).toEqual({ consecutiveFailures: 1, circuitOpenUntil: at('2026-09-24T12:00:00Z'), circuitOpened: false });
    expect(failureTransition({ consecutiveFailures: 0, now, retryAfterSeconds: 30 }).circuitOpenUntil).toBeNull();
    expect(DEFAULT_SYNC_POLICY.leaseTtlMs).toBe(5 * MIN);
  });

  it('appel avec reprises : attentes réelles demandées à l’horloge injectée, puis succès ou dernière erreur', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls < 3 ? Promise.reject(new ProviderError('INJOIGNABLE', 'x')) : Promise.resolve('ok');
    };
    await expect(callWithRetries(flaky, { sleep, retries: true })).resolves.toEqual({ value: 'ok', attempts: 3 });
    expect(waits).toEqual([1000, 4000]);

    waits.length = 0;
    const down = () => Promise.reject(new ProviderError('INJOIGNABLE', 'x'));
    await expect(callWithRetries(down, { sleep, retries: true })).rejects.toBeInstanceOf(ProviderError);
    expect(waits).toEqual([1000, 4000, 16000]);

    waits.length = 0;
    await expect(callWithRetries(down, { sleep, retries: false })).rejects.toBeInstanceOf(ProviderError);
    expect(waits).toEqual([]);
  });
});
