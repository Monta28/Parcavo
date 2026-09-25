import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Compte mixte (CDC 2.3, T01) : chef de parc dans A et seulement conducteur dans B. L'habilitation
 * CONDUCTEUR ne donne aucun accès de gestion à B : listes, fiches, agrégats et rapports l'excluent.
 */
describe('Périmètre d’un compte mixte gestionnaire / conducteur (CDC 2.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let mixed: Agent;
  let vehicleA: string;
  let vehicleB: string;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-24T10:00:00.000Z' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    await t.prisma.client.membership.create({ data: { organizationId: f.organizationId, userId: f.users.chefA, companyId: f.companies.B, role: 'CONDUCTEUR' } });
    mixed = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    vehicleA = await createVehicle(t.prisma, f, 'A', { code: 'MIX-A' });
    vehicleB = await createVehicle(t.prisma, f, 'B', { code: 'MIX-B' });
  });

  it('listes, fiches et filtres : rien de la société où il n’est que conducteur', async () => {
    const list = await mixed.get('/vehicles');
    expect(list.status).toBe(200);
    expect(list.body.items.map((v: { code: string }) => v.code)).toEqual(['MIX-A']);
    expect((await mixed.get(`/vehicles?companyId=${f.companies.B}`)).status).toBe(404);
    expect((await mixed.get(`/vehicles/${vehicleB}`)).status).toBe(404);
    expect((await mixed.get(`/vehicles/${vehicleA}`)).status).toBe(200);
    const drivers = await mixed.get('/drivers');
    expect(drivers.body.items.every((d: { companyId: string }) => d.companyId === f.companies.A)).toBe(true);
  });

  it('agrégats : le tableau de bord ne compte pas la flotte de B', async () => {
    const dashboard = await mixed.get('/dashboard');
    expect(dashboard.status).toBe(200);
    const active = (dashboard.body.indicators as Array<{ key: string; value: number | null }>).find((i) => i.key === 'vehicles.active');
    expect(active?.value).toBe(1);
  });
});
