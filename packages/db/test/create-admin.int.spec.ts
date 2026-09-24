import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { verify } from '@node-rs/argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const DB = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
const PACKAGE_DIR = resolve(import.meta.dirname, '..');

/** Exécute la vraie commande `create-admin` (tsx) contre la base de test. */
async function createAdmin(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run('pnpm', ['exec', 'tsx', 'src/cli/create-admin.ts', ...args], { cwd: PACKAGE_DIR, env: { ...process.env, DATABASE_URL: DB, ...env }, timeout: 60_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('Commande de création du premier administrateur (CDC 19.2)', () => {
  const client = new pg.Client({ connectionString: DB });
  const orgCode = `CLI-${randomUUID().slice(0, 8).toUpperCase()}`;
  const email = `premier.admin.${orgCode.toLowerCase()}@test.local`;
  const args = ['--org-code', orgCode, '--org-name', 'Groupe CLI', '--email', email, '--first-name', 'Amel', '--last-name', 'Admin'];

  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it('refuse un mot de passe faible sans rien créer', async () => {
    const r = await createAdmin(args, { ADMIN_PASSWORD: 'court' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Mot de passe refusé');
    const orgs = await client.query('SELECT id FROM "Organization" WHERE code = $1', [orgCode]);
    expect(orgs.rowCount).toBe(0);
  });

  it('crée l’organisation et l’administrateur avec un hachage Argon2id, puis refuse un second passage', async () => {
    const password = 'Premier-Admin-2026';
    const r = await createAdmin(args, { ADMIN_PASSWORD: password });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Administrateur créé pour l'organisation ${orgCode}`);
    expect(r.stdout).not.toContain(password);
    const user = await client.query<{ id: string; passwordHash: string; organizationId: string }>('SELECT u.id, u."passwordHash", u."organizationId" FROM "User" u JOIN "Organization" o ON o.id = u."organizationId" WHERE o.code = $1 AND u.email = $2', [orgCode, email]);
    expect(user.rowCount).toBe(1);
    const row = user.rows[0];
    if (!row) throw new Error('utilisateur absent');
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(row.passwordHash, password)).toBe(true);
    const membership = await client.query('SELECT role, "companyId" FROM "Membership" WHERE "userId" = $1', [row.id]);
    expect(membership.rows).toEqual([{ role: 'ADMIN', companyId: null }]);
    const audit = await client.query<{ after: unknown }>('SELECT after FROM "AuditEvent" WHERE "organizationId" = $1 AND action = $2', [row.organizationId, 'cli.premier_administrateur']);
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain(password);

    const again = await createAdmin([...args.slice(0, 4), '--email', `autre.${email}`, '--first-name', 'B', '--last-name', 'C'], { ADMIN_PASSWORD: password });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('Un administrateur existe déjà');
    const count = await client.query('SELECT count(*)::int AS n FROM "User" WHERE "organizationId" = $1', [row.organizationId]);
    expect(count.rows[0]).toEqual({ n: 1 });
  });

  it('exige ADMIN_PASSWORD hors terminal interactif (jamais en argument)', async () => {
    const r = await createAdmin(['--org-code', `${orgCode}-X`, '--org-name', 'X', '--email', `x.${email}`, '--first-name', 'X', '--last-name', 'Y'], { ADMIN_PASSWORD: '' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('ADMIN_PASSWORD');
  });
});
