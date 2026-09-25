import { Test } from '@nestjs/testing';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, PrismaService, WORKER_HEARTBEAT_STALE_MS, loadEnv, workerHeartbeatFreshness } from '@parc-auto/api';
import { HEARTBEAT_INTERVAL_MS, HeartbeatService } from './heartbeat.service.js';
import { WorkerModule } from './worker.module.js';

/** Test sur la base PostgreSQL de test réelle (migrations appliquées par le globalSetup). */
describe('Battement du worker (CDC 16.3)', () => {
  const clock = new FixedClock('2026-09-24T10:00:00.000Z');
  let heartbeat: HeartbeatService;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test',
      APP_ORIGIN: 'http://localhost:3000',
      STORAGE_DIR: await mkdtemp(join(tmpdir(), 'parc-auto-worker-')),
      APP_VERSION: 'test-1',
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.register({ env, clock })] }).compile();
    heartbeat = moduleRef.get(HeartbeatService);
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });
  afterAll(async () => {
    await prisma.client.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } });
    await close();
  });

  it('crée puis met à jour la ligne de battement du processus, sans en créer de nouvelle', async () => {
    await heartbeat.beat();
    let row = await prisma.client.workerHeartbeat.findUniqueOrThrow({ where: { workerId: heartbeat.workerId } });
    expect(row.lastBeatAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(row.startedAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(row.appVersion).toBe('test-1');

    clock.advance(30_000);
    await heartbeat.beat();
    row = await prisma.client.workerHeartbeat.findUniqueOrThrow({ where: { workerId: heartbeat.workerId } });
    expect(row.lastBeatAt.toISOString()).toBe('2026-09-24T10:00:30.000Z');
    expect(row.startedAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(await prisma.client.workerHeartbeat.count({ where: { workerId: heartbeat.workerId } })).toBe(1);
  });

  it('période du battement compatible avec le seuil de /health/worker : au moins quatre battements avant « arrêté » (D-315)', async () => {
    expect(HEARTBEAT_INTERVAL_MS * 4).toBeLessThanOrEqual(WORKER_HEARTBEAT_STALE_MS);
    // Le battement enregistré est lu « actif » par la règle de l'API, puis « arrêté » au-delà du seuil.
    const at = await heartbeat.beat();
    const row = await prisma.client.workerHeartbeat.findUniqueOrThrow({ where: { workerId: heartbeat.workerId } });
    expect(row.lastBeatAt.getTime()).toBe(at.getTime());
    expect(workerHeartbeatFreshness(row.lastBeatAt, new Date(at.getTime() + HEARTBEAT_INTERVAL_MS)).status).toBe('actif');
    expect(workerHeartbeatFreshness(row.lastBeatAt, new Date(at.getTime() + WORKER_HEARTBEAT_STALE_MS + 1)).status).toBe('arrete');
  });

  it('arme au démarrage un battement qui maintient le processus actif, puis le libère à l’arrêt', async () => {
    await heartbeat.onApplicationBootstrap();
    expect(heartbeat.isKeepingProcessAlive()).toBe(true);
    heartbeat.onApplicationShutdown();
    expect(heartbeat.isKeepingProcessAlive()).toBe(false);
  });
});
