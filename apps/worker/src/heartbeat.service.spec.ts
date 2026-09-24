import { Test } from '@nestjs/testing';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, PrismaService, loadEnv } from '@parc-auto/api';
import { HeartbeatService } from './heartbeat.service.js';
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
});
