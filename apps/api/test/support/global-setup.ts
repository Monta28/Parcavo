import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

/**
 * Préparation globale des tests d'intégration : base PostgreSQL de test réelle (Docker),
 * migrations appliquées avec `prisma migrate deploy`. Jamais la base de production.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
  if (!/parc_auto_test/.test(url)) {
    throw new Error('TEST_DATABASE_URL doit pointer vers une base nommée parc_auto_test.');
  }
  const repoRoot = resolve(import.meta.dirname, '../../../..');
  if (!(await reachable(url))) {
    execSync('docker compose up -d --wait postgres-test', { cwd: repoRoot, stdio: 'inherit' });
    for (let i = 0; i < 60 && !(await reachable(url)); i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!(await reachable(url))) throw new Error(`Base de test injoignable : ${url.replace(/:[^:@/]+@/, ':***@')}`);
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(repoRoot, 'packages/db'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
  process.env['TEST_DATABASE_URL'] = url;
}

async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
