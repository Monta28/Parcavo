import { execFile, spawn } from 'node:child_process';
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

/**
 * Exécute la commande dans un vrai pseudo-terminal (`script` d'util-linux) sans ADMIN_PASSWORD : attend
 * l'invite, tape `keys`, puis renvoie tout ce que le terminal a affiché.
 */
function createAdminInTerminal(args: string[], keys: string): Promise<{ code: number | null; screen: string }> {
  const command = ['pnpm', 'exec', 'tsx', 'src/cli/create-admin.ts', ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return new Promise((resolvePromise, reject) => {
    const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: PACKAGE_DIR, env: { ...process.env, DATABASE_URL: DB, ADMIN_PASSWORD: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '';
    let typed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Délai dépassé ; écran : ${screen}`));
    }, 60_000);
    const collect = (chunk: Buffer) => {
      screen += chunk.toString('utf8');
      if (!typed && screen.includes('Mot de passe du premier administrateur : ')) {
        typed = true;
        // Frappe après l'affichage de l'invite : le terminal est alors en mode brut (aucun écho du pilote tty).
        setTimeout(() => child.stdin.write(keys), 200);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, screen });
    });
  });
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

  it('saisie au terminal masquée : le mot de passe tapé n’est jamais affiché, et c’est bien lui qui est haché', async () => {
    const code = `${orgCode}-TTY`;
    const ttyEmail = `tty.${email}`;
    const password = 'Saisie-Masquee-2026';
    const r = await createAdminInTerminal(['--org-code', code, '--org-name', 'Groupe TTY', '--email', ttyEmail, '--first-name', 'T', '--last-name', 'Y'], `${password}\r`);
    expect(r.code, r.screen).toBe(0);
    expect(r.screen).toContain(`Administrateur créé pour l'organisation ${code}`);
    expect(r.screen).not.toContain(password);
    expect(r.screen).not.toContain('Saisie');
    const user = await client.query<{ passwordHash: string }>('SELECT u."passwordHash" FROM "User" u JOIN "Organization" o ON o.id = u."organizationId" WHERE o.code = $1 AND u.email = $2', [code, ttyEmail]);
    expect(user.rowCount).toBe(1);
    expect(await verify(user.rows[0]?.passwordHash ?? '', password)).toBe(true);
  });

  it('saisie interrompue (Ctrl+C) : rien n’est créé', async () => {
    const code = `${orgCode}-INT`;
    const r = await createAdminInTerminal(['--org-code', code, '--org-name', 'Groupe INT', '--email', `int.${email}`, '--first-name', 'I', '--last-name', 'N'], 'Commence-2026\u0003');
    expect(r.code).not.toBe(0);
    expect(r.screen).toContain('Saisie interrompue : aucun administrateur créé.');
    expect(r.screen).not.toContain('Commence-2026');
    expect((await client.query('SELECT id FROM "Organization" WHERE code = $1', [code])).rowCount).toBe(0);
  });

  it('deux exécutions simultanées sur une organisation sans administrateur : un seul premier administrateur', async () => {
    const code = `${orgCode}-RACE`;
    await client.query('INSERT INTO "Organization" (id, code, name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now())', [code, 'Groupe sans administrateur']);
    const runs = await Promise.all(
      ['un', 'deux', 'trois'].map((n) => createAdmin(['--org-code', code, '--org-name', 'X', '--email', `${n}.race.${email}`, '--first-name', 'R', '--last-name', n], { ADMIN_PASSWORD: 'Course-Admin-2026' })),
    );
    expect(runs.filter((r) => r.code === 0)).toHaveLength(1);
    for (const r of runs.filter((x) => x.code !== 0)) expect(r.stderr).toMatch(/Une autre création d’administrateur s’est exécutée en même temps|Un administrateur existe déjà/);
    const admins = await client.query('SELECT m.id FROM "Membership" m JOIN "Organization" o ON o.id = m."organizationId" WHERE o.code = $1 AND m.role = $2', [code, 'ADMIN']);
    expect(admins.rowCount).toBe(1);
  });
});
