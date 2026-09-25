import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap.js';
import { HEALTH_CHECK_TIMEOUT_MS } from '../../src/modules/health/health.controller.js';
import { FixedClock } from '../../src/common/clock.js';
import { loadEnv, type AppEnv } from '../../src/infra/env.js';
import { PrismaService } from '../../src/infra/prisma.service.js';
import { resetDatabase } from '../support/test-app.js';

type Server_ = Parameters<typeof request>[0];

const NOW = '2026-09-24T10:00:00.000Z';
const TEST_DB = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';

/**
 * Relais TCP réel vers la base de test : le couper rend PostgreSQL réellement injoignable pour l'API
 * (connexions établies fermées, nouvelles connexions refusées), le rouvrir rétablit le service. Le figer
 * simule une base qui ne répond plus (réseau bloqué) : connexions acceptées, aucun octet transmis, jusqu'au
 * dégel qui reprend les échanges en attente.
 */
class DatabaseRelay {
  private server: Server | null = null;
  private readonly links = new Set<{ client: Socket; upstream: Socket }>();
  private frozen = false;
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async open(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(this.target.port, this.target.host);
      const link = { client, upstream };
      this.links.add(link);
      for (const s of [client, upstream]) {
        s.on('close', () => {
          this.links.delete(link);
          client.destroy();
          upstream.destroy();
        });
        s.on('error', () => undefined);
      }
      if (!this.frozen) this.flow(link);
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    const address = server.address();
    if (address && typeof address === 'object') this.port = address.port;
    this.server = server;
  }

  private flow(link: { client: Socket; upstream: Socket }): void {
    link.client.pipe(link.upstream);
    link.upstream.pipe(link.client);
  }

  /** Plus aucun octet ne circule (connexions établies et nouvelles), sans fermeture ni refus. */
  freeze(): void {
    this.frozen = true;
    for (const { client, upstream } of this.links) {
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.pause();
      upstream.pause();
    }
  }

  thaw(): void {
    this.frozen = false;
    for (const link of this.links) this.flow(link);
  }

  async cut(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const { client, upstream } of this.links) {
      client.destroy();
      upstream.destroy();
    }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Santé : vivant, prêt et battement du worker (CDC 16.3, D-315)', () => {
  const target = new URL(TEST_DB);
  const relay = new DatabaseRelay({ host: target.hostname, port: Number(target.port || 5432) });
  let app: NestExpressApplication;
  let server: Server_;
  let prisma: PrismaService;
  let env: AppEnv;
  let clock: FixedClock;
  let storageDir: string;
  let relayedUrl: string;

  beforeAll(async () => {
    await relay.open();
    const relayed = new URL(TEST_DB);
    relayed.hostname = '127.0.0.1';
    relayed.port = String(relay.port);
    relayedUrl = relayed.toString();
    storageDir = await mkdtemp(join(tmpdir(), 'parc-auto-health-'));
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: relayedUrl,
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECURE: 'false',
      STORAGE_DIR: storageDir,
      SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      LOG_LEVEL: 'error',
      RATE_LIMIT_ENABLED: 'false',
      APP_VERSION: 'version-de-test-9.9.9',
    });
    clock = new FixedClock(NOW);
    app = await createApp({ env, clock });
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
    await relay.cut();
    await rm(storageDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    clock.set(NOW);
    await resetDatabase(prisma);
  });
  afterEach(async () => {
    env.storageDir = storageDir;
  });

  const get = (path: string) => request(server).get(`/api/v1/health/${path}`);

  async function beat(workerId: string, secondsAgo: number): Promise<void> {
    const at = new Date(new Date(NOW).getTime() - secondsAgo * 1000);
    await prisma.client.workerHeartbeat.create({ data: { workerId, hostname: 'hote-worker-secret', startedAt: at, lastBeatAt: at, appVersion: 'version-de-test-9.9.9' } });
  }

  /** Aucune réponse de santé ne révèle URL de base, mot de passe, chemin de stockage, hôte ou version. */
  function expectNoSecret(body: unknown): void {
    const text = JSON.stringify(body);
    for (const forbidden of [relayedUrl, TEST_DB, target.password, target.username, storageDir, 'hote-worker-secret', 'version-de-test-9.9.9', 'parc_auto_test']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  }

  it('vivant sans authentification ni dépendance ; prêt : base et stockage contrôlés, worker en information', async () => {
    const live = await get('live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'vivant' });

    const ready = await get('ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      status: 'pret',
      checkedAt: NOW,
      checks: {
        database: { ok: true, detail: 'connexion établie' },
        storage: { ok: true, detail: 'répertoire accessible en lecture et en écriture' },
        worker: { ok: false, detail: 'aucun battement enregistré' },
      },
    });
    expectNoSecret(ready.body);
  });

  it('battement du worker : actif jusqu’à deux minutes (200), arrêté au-delà (503) ; prêt reste 200 et le signale', async () => {
    const none = await get('worker');
    expect(none.status).toBe(503);
    expect(none.body).toEqual({ status: 'arrete', lastBeatAt: null, ageSeconds: null, staleAfterSeconds: 120, detail: 'aucun battement enregistré', checkedAt: NOW });

    await beat('ancien', 600);
    await beat('courant', 30);
    const fresh = await get('worker');
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ status: 'actif', lastBeatAt: '2026-09-24T09:59:30.000Z', ageSeconds: 30, staleAfterSeconds: 120 });
    expectNoSecret(fresh.body);
    const readyFresh = await get('ready');
    expect(readyFresh.status).toBe(200);
    expect(readyFresh.body.checks.worker).toEqual({ ok: true, detail: 'dernier battement 2026-09-24T09:59:30.000Z' });

    // Deux minutes après le dernier battement : encore actif (borne incluse).
    clock.set('2026-09-24T10:01:30.000Z');
    expect((await get('worker')).body).toMatchObject({ status: 'actif', ageSeconds: 120 });

    // Au-delà : le worker est arrêté ; la supervision extérieure l'apprend par /health/worker (503).
    clock.set('2026-09-24T10:01:31.000Z');
    const stale = await get('worker');
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({ status: 'arrete', lastBeatAt: '2026-09-24T09:59:30.000Z', ageSeconds: 121 });
    const readyStale = await get('ready');
    expect(readyStale.status).toBe(200);
    expect(readyStale.body.status).toBe('pret');
    expect(readyStale.body.checks.worker).toEqual({ ok: false, detail: 'aucun battement depuis 2026-09-24T09:59:30.000Z (plus de 2 minutes)' });
    expectNoSecret(readyStale.body);
  });

  it('stockage absent ou qui n’est pas un répertoire : prêt → 503 « degrade », sans chemin dans la réponse', async () => {
    env.storageDir = join(storageDir, 'absent');
    const missing = await get('ready');
    expect(missing.status).toBe(503);
    expect(missing.body.status).toBe('degrade');
    expect(missing.body.checks.storage).toEqual({ ok: false, detail: 'répertoire de stockage inaccessible' });
    expect(missing.body.checks.database.ok).toBe(true);
    expectNoSecret(missing.body);

    const file = join(storageDir, 'fichier');
    await writeFile(file, 'pas un répertoire');
    env.storageDir = file;
    expect((await get('ready')).status).toBe(503);

    env.storageDir = storageDir;
    expect((await get('ready')).status).toBe(200);
    expect((await get('live')).status).toBe(200);
  });

  it('base injoignable : prêt → 503, battement illisible → 503 « inconnu », vivant reste 200 ; retour à 200 après rétablissement', async () => {
    await beat('courant', 10);
    expect((await get('ready')).status).toBe(200);

    await relay.cut();
    try {
      const ready = await get('ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({
        status: 'degrade',
        checks: {
          database: { ok: false, detail: 'base de données injoignable' },
          storage: { ok: true },
          worker: { ok: false, detail: 'battement du worker illisible' },
        },
      });
      expectNoSecret(ready.body);
      const worker = await get('worker');
      expect(worker.status).toBe(503);
      expect(worker.body).toMatchObject({ status: 'inconnu', lastBeatAt: null, detail: 'battement du worker illisible' });
      expectNoSecret(worker.body);
      const live = await get('live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'vivant' });
    } finally {
      await relay.open();
    }

    // Le pool se reconnecte : le service redevient prêt sans redémarrage.
    let status = 0;
    for (let i = 0; i < 20 && status !== 200; i += 1) {
      status = (await get('ready')).status;
      if (status !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(200);
    expect((await get('worker')).status).toBe(200);
  });

  it('base qui ne répond plus (réseau figé) : prêt et worker répondent 503 dans le délai borné, vivant reste 200 ; reprise ensuite', async () => {
    await beat('courant', 10);
    expect((await get('ready')).status).toBe(200);

    relay.freeze();
    try {
      const started = Date.now();
      const [ready, worker, live] = await Promise.all([get('ready').timeout(10_000), get('worker').timeout(10_000), get('live').timeout(10_000)]);
      const elapsed = Date.now() - started;
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({
        status: 'degrade',
        checks: {
          database: { ok: false, detail: `base de données sans réponse (plus de ${HEALTH_CHECK_TIMEOUT_MS / 1000} s)` },
          storage: { ok: true },
          worker: { ok: false, detail: `battement du worker illisible (plus de ${HEALTH_CHECK_TIMEOUT_MS / 1000} s)` },
        },
      });
      expectNoSecret(ready.body);
      expect(worker.status).toBe(503);
      expect(worker.body).toMatchObject({ status: 'inconnu', lastBeatAt: null, detail: `battement du worker illisible (plus de ${HEALTH_CHECK_TIMEOUT_MS / 1000} s)` });
      expect(live.status).toBe(200);
      // Réponse bornée par le délai des contrôles (exécutés en parallèle), jamais suspendue avec la base.
      expect(elapsed).toBeGreaterThanOrEqual(HEALTH_CHECK_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 2_000);
    } finally {
      relay.thaw();
    }

    let status = 0;
    for (let i = 0; i < 20 && status !== 200; i += 1) {
      status = (await get('ready')).status;
      if (status !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(200);
    expect((await get('worker')).status).toBe(200);
  });
});
