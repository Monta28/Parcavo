import { describe, expect, it } from 'vitest';
import { WORKER_HEARTBEAT_STALE_MS, workerHeartbeatFreshness } from './worker-heartbeat.js';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('fraîcheur du battement du worker (CDC 16.3, D-315)', () => {
  it('seuil de deux minutes : quatre battements de 30 s manqués', () => {
    expect(WORKER_HEARTBEAT_STALE_MS).toBe(120_000);
  });

  it('actif jusqu’à deux minutes incluses, arrêté au-delà', () => {
    expect(workerHeartbeatFreshness(ago(30_000), NOW)).toEqual({ status: 'actif', ageSeconds: 30 });
    expect(workerHeartbeatFreshness(ago(120_000), NOW)).toEqual({ status: 'actif', ageSeconds: 120 });
    expect(workerHeartbeatFreshness(ago(120_001), NOW)).toEqual({ status: 'arrete', ageSeconds: 120 });
    expect(workerHeartbeatFreshness(ago(3_600_000), NOW)).toEqual({ status: 'arrete', ageSeconds: 3600 });
  });

  it('aucun battement : arrêté, âge inconnu ; battement daté dans le futur : actif, âge 0', () => {
    expect(workerHeartbeatFreshness(null, NOW)).toEqual({ status: 'arrete', ageSeconds: null });
    expect(workerHeartbeatFreshness(new Date(NOW.getTime() + 5_000), NOW)).toEqual({ status: 'actif', ageSeconds: 0 });
  });

  it('seuil paramétrable pour le calcul (même règle)', () => {
    expect(workerHeartbeatFreshness(ago(61_000), NOW, 60_000).status).toBe('arrete');
  });
});
