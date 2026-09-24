import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

type App = Parameters<typeof request>[0];
import { createApp } from '../../src/bootstrap.js';
import { FixedClock } from '../../src/common/clock.js';
import { loadEnv, type AppEnv } from '../../src/infra/env.js';
import { PrismaService } from '../../src/infra/prisma.service.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestApp {
  app: NestExpressApplication;
  server: App;
  clock: FixedClock;
  env: AppEnv;
  prisma: PrismaService;
  close(): Promise<void>;
}

export const TEST_ORIGIN = 'http://localhost:3000';

/** Démarre l'API complète contre la base de test, avec une horloge contrôlable. */
export async function startTestApp(options: { now?: string; smtp?: boolean; rateLimit?: boolean } = {}): Promise<TestApp> {
  const storageDir = await mkdtemp(join(tmpdir(), 'parc-auto-storage-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test',
    APP_ORIGIN: TEST_ORIGIN,
    COOKIE_SECURE: 'false',
    STORAGE_DIR: storageDir,
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    TELEMETRY_SIMULATOR_ENABLED: 'true',
    LOG_LEVEL: 'error',
    RATE_LIMIT_ENABLED: options.rateLimit ? 'true' : 'false',
    ...(options.smtp ? { SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_FROM: 'test@parc-auto.local' } : {}),
  });
  const clock = new FixedClock(options.now ?? '2026-09-24T10:00:00.000Z');
  const app = await createApp({ env, clock });
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    server: app.getHttpServer() as App,
    clock,
    env,
    prisma,
    close: async () => {
      await app.close();
    },
  };
}

/** Vide toutes les tables métier (ordre indifférent grâce à TRUNCATE ... CASCADE). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')
      AND tablename NOT LIKE '%\\_default' AND tablename !~ '_[0-9]{6}$'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (list.length > 0) {
    await prisma.client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}

export interface Agent {
  get(path: string): request.Test;
  post(path: string, body?: unknown): request.Test;
  put(path: string, body?: unknown): request.Test;
  patch(path: string, body?: unknown): request.Test;
  delete(path: string): request.Test;
  cookies: string;
  csrf: string;
}

/** Client HTTP authentifié : cookies de session et jeton CSRF renvoyés en en-tête sur les mutations. */
export function agentFor(server: App, cookies: string[], csrf: string): Agent {
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  const withAuth = (t: request.Test, mutating: boolean) => {
    t.set('Cookie', cookieHeader).set('Origin', TEST_ORIGIN);
    if (mutating) t.set('X-CSRF-Token', csrf);
    return t;
  };
  return {
    cookies: cookieHeader,
    csrf,
    get: (path) => withAuth(request(server).get(`/api/v1${path}`), false),
    post: (path, body) => withAuth(request(server).post(`/api/v1${path}`), true).send(body ?? {}),
    put: (path, body) => withAuth(request(server).put(`/api/v1${path}`), true).send(body ?? {}),
    patch: (path, body) => withAuth(request(server).patch(`/api/v1${path}`), true).send(body ?? {}),
    delete: (path) => withAuth(request(server).delete(`/api/v1${path}`), true),
  };
}

export function anonymous(server: App): Agent {
  return agentFor(server, [], '');
}

/** Connexion et construction d'un agent authentifié. */
export async function login(server: App, email: string, password: string): Promise<Agent> {
  const res = await request(server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Connexion échouée pour ${email} : ${res.status} ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const csrf = cookies.find((c) => c.startsWith('pa_csrf='))?.split(';')[0]?.slice('pa_csrf='.length) ?? '';
  return agentFor(server, cookies, csrf);
}
