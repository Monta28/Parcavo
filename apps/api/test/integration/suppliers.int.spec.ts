import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/** Répertoire des fournisseurs (CDC 8.1, D-221) : unicité normalisée parmi les actifs, copie, archivés refusés. */
describe('Fournisseurs : unicité, copie vers une autre société, archivés (CDC 8.1 ; D-221)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-24T10:00:00.000Z' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set('2026-09-24T10:00:00.000Z');
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
  });

  async function supplier(agent: Agent, body: Record<string, unknown>) {
    const res = await agent.post('/suppliers', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; name: string; companyId: string; status: string };
  }

  it('unicité par société sur le nom normalisé (casse, accents, espaces), parmi les fournisseurs actifs seulement', async () => {
    const elan = await supplier(chefA, { companyId: f.companies.A, name: 'Garage Élan', category: 'GARAGE' });
    const dup = await chefA.post('/suppliers', { companyId: f.companies.A, name: '  garage   ELAN ', category: 'GARAGE' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('FOURNISSEUR_EXISTANT');
    // Autre société : pas de conflit.
    await supplier(chefB, { companyId: f.companies.B, name: 'GARAGE ELAN', category: 'GARAGE' });
    // Renommage vers un nom déjà pris (normalisé) : 409.
    const other = await supplier(chefA, { companyId: f.companies.A, name: 'Garage du Port', category: 'GARAGE' });
    const rename = await chefA.patch(`/suppliers/${other.id}`, { name: 'garage elan', expectedVersion: other.version });
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe('FOURNISSEUR_EXISTANT');
    // Un archivé ne bloque plus un homonyme actif, même au nom identique.
    const archived = await chefA.post(`/suppliers/${elan.id}/archive`, { expectedVersion: elan.version });
    expect(archived.status).toBe(200);
    const again = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage Élan', category: 'GARAGE' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    // Réactiver l'ancien créerait deux actifs homonymes : 409.
    const restore = await chefA.post(`/suppliers/${elan.id}/restore`, { expectedVersion: archived.body.version });
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('FOURNISSEUR_EXISTANT');
    const row = await t.prisma.client.supplier.findUniqueOrThrow({ where: { id: again.body.id } });
    expect(row.normalizedName).toBe('garage elan');
  });
});
