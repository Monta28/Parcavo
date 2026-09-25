import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrismaClient } from '@parc-auto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import globalSetup, { databaseNameOf } from '../support/global-setup.js';
import { seedFixture } from '../support/factories.js';
import { TEST_DATABASE_NAME, resetDatabase, startTestApp, type TestApp } from '../support/test-app.js';

const REPO = resolve(import.meta.dirname, '../../../..');
/** Domaines réservés aux tests et à la documentation (RFC 2606, RFC 6761) : aucune adresse réelle. */
const FICTITIOUS_EMAIL = /@([a-z0-9-]+\.)*(test|local|invalid|example|example\.(com|org|net|tn))$/i;

/**
 * Base de test et données fictives (CDC 18, R-18-46) : les préparations refusent toute base qui n'est pas
 * une base de test, la réinitialisation refuse une autre base, et les jeux de données des tests
 * (intégration et e2e) n'utilisent que des adresses de domaines réservés, jamais des comptes réels.
 */
describe('Isolation des tests : base de test et données fictives (CDC 18)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('la préparation globale refuse une URL qui ne vise pas une base parc_auto_test', async () => {
    // « parc_auto_test » ailleurs que dans le nom de la base (utilisateur, mot de passe, hôte, paramètre,
    // suffixe) ne suffit jamais : seul le chemin de l'URL désigne la base ouverte par pg et Prisma.
    const refused = [
      'postgresql://parc_auto:x@localhost:5432/parc_auto',
      'postgresql://parc_auto:x@db.parc-auto.invalid:5432/production',
      'postgresql://parc_auto_test:x@db.parc-auto.invalid:5432/parc_auto',
      'postgresql://parc_auto:parc_auto_test@db.parc-auto.invalid:5432/production',
      'postgresql://parc_auto:x@parc_auto_test.parc-auto.invalid:5432/production',
      'postgresql://parc_auto:x@db.parc-auto.invalid:5432/production?application_name=parc_auto_test',
      'postgresql://parc_auto:x@db.parc-auto.invalid:5432/production_parc_auto_test',
      'pas une url parc_auto_test',
    ];
    const e2eSetup = ((await import(pathToFileURL(resolve(REPO, 'tests/e2e/support/global-setup.ts')).href)) as { default: () => Promise<void> }).default;
    const saved = process.env['TEST_DATABASE_URL'];
    try {
      for (const url of refused) {
        process.env['TEST_DATABASE_URL'] = url;
        await expect(globalSetup(), url).rejects.toThrow('TEST_DATABASE_URL doit pointer vers une base nommée parc_auto_test.');
        await expect(e2eSetup(), url).rejects.toThrow('TEST_DATABASE_URL doit cibler la base parc_auto_test.');
      }
    } finally {
      if (saved === undefined) delete process.env['TEST_DATABASE_URL'];
      else process.env['TEST_DATABASE_URL'] = saved;
    }
    expect(databaseNameOf('postgresql://u:p@localhost:5433/parc_auto_test_e2?sslmode=disable')).toBe('parc_auto_test_e2');
    const e2eConfig = await readFile(resolve(REPO, 'tests/e2e/playwright.config.ts'), 'utf8');
    expect(e2eConfig).toMatch(/DATABASE_URL = process\.env\['TEST_DATABASE_URL'\] \?\? 'postgresql:\/\/parc_auto:parc_auto_test@localhost:5433\/parc_auto_test'/);
  });

  it('l’API des tests est branchée sur une base de test, et la réinitialisation refuse toute autre base', async () => {
    const [current] = await t.prisma.client.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(current?.name).toMatch(TEST_DATABASE_NAME);

    const other = new URL(process.env['TEST_DATABASE_URL'] ?? '');
    other.pathname = '/postgres';
    const client = createPrismaClient({ databaseUrl: other.toString(), log: ['error'] });
    try {
      await expect(resetDatabase({ client })).rejects.toThrow('Réinitialisation refusée : la base « postgres » n\'est pas une base de test parc_auto_test….');
    } finally {
      await client.$disconnect();
    }
    // Le jeu de données e2e (qui vide toutes les tables) vérifie de même la base réellement ouverte, y compris
    // lancé seul (`pnpm --filter @parc-auto/e2e seed`), avant toute écriture.
    const { seedE2E } = (await import(pathToFileURL(resolve(REPO, 'tests/e2e/support/seed-e2e.ts')).href)) as { seedE2E: (url: string) => Promise<void> };
    await expect(seedE2E(other.toString())).rejects.toThrow('Seed e2e refusé : la base « postgres » n\'est pas une base de test parc_auto_test….');
  });

  it('les jeux de données des tests sont fictifs : adresses de domaines réservés uniquement (intégration et e2e)', async () => {
    await resetDatabase(t.prisma);
    await seedFixture(t.prisma);
    const users = await t.prisma.client.user.findMany({ select: { email: true } });
    expect(users.length).toBeGreaterThanOrEqual(6);
    for (const { email } of users) expect(email).toMatch(FICTITIOUS_EMAIL);
    const drivers = await t.prisma.client.driver.findMany({ select: { email: true } });
    for (const { email } of drivers) if (email) expect(email).toMatch(FICTITIOUS_EMAIL);

    for (const file of ['tests/e2e/support/seed-e2e.ts', 'apps/api/test/support/factories.ts']) {
      const source = await readFile(resolve(REPO, file), 'utf8');
      const emails = source.match(/[A-Za-z0-9._%+${}-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      expect(emails.length, file).toBeGreaterThan(0);
      for (const email of emails) expect(email, file).toMatch(FICTITIOUS_EMAIL);
    }
  });
});
