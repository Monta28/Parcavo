import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Cloisonnement des sociétés (CDC 2.3 — T01, T02, T03)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let vehicleA: string;
  let vehicleB: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    vehicleA = await createVehicle(t.prisma, f, 'A', { code: 'VA-1', registration: '100 TU 1' });
    vehicleB = await createVehicle(t.prisma, f, 'B', { code: 'VB-1', registration: '200 TU 2' });
  });

  it('T01 — le chef de A ne voit ni la fiche, ni la recherche, ni le conducteur, ni les compteurs de B', async () => {
    expect((await chefA.get(`/vehicles/${vehicleB}`)).status).toBe(404);
    expect((await chefA.get(`/vehicles/${vehicleB}/synthesis`)).status).toBe(404);
    expect((await chefA.get(`/vehicles/${vehicleB}/location-reports`)).status).toBe(404);
    expect((await chefA.get(`/drivers/${f.drivers.b1}`)).status).toBe(404);
    expect((await chefA.get(`/companies/${f.companies.B}`)).status).toBe(404);
    const search = await chefA.get('/vehicles?q=200');
    expect(search.status).toBe(200);
    expect(search.body.total).toBe(0);
    const filtered = await chefA.get(`/vehicles?companyId=${f.companies.B}`);
    expect(filtered.status).toBe(404);
    const all = await chefA.get('/vehicles');
    expect(all.body.total).toBe(1);
    expect(all.body.items[0].id).toBe(vehicleA);
    const drivers = await chefA.get('/drivers');
    expect(drivers.body.items.every((d: { companyId: string }) => d.companyId === f.companies.A)).toBe(true);
    const companies = await chefA.get('/companies');
    expect(companies.body.items.map((c: { code: string }) => c.code)).toEqual(['A']);
  });

  it('T01 — les mutations hors périmètre sont refusées sans révéler l’objet', async () => {
    expect((await chefA.patch(`/vehicles/${vehicleB}`, { make: 'X', expectedVersion: 1 })).status).toBe(404);
    expect((await chefA.post(`/vehicles/${vehicleB}/location-reports`, { placeLabel: 'Ailleurs', observedAt: '2026-09-24T09:00:00Z' })).status).toBe(404);
    const createInB = await chefA.post('/vehicles', { companyId: f.companies.B, code: 'VB-9', registration: '999 TU 9', make: 'Renault', model: 'Clio', categoryId: f.categoryId });
    expect(createInB.status).toBe(404);
    const siteInB = await chefA.post('/sites', { companyId: f.companies.B, name: 'Dépôt' });
    expect(siteInB.status).toBe(404);
  });

  it('T02 — l’administrateur consolide toutes les sociétés puis filtre sur A avec des totaux justifiables', async () => {
    const all = await admin.get('/vehicles');
    expect(all.body.total).toBe(2);
    const onlyA = await admin.get(`/vehicles?companyId=${f.companies.A}`);
    expect(onlyA.body.total).toBe(1);
    expect(onlyA.body.items[0].companyId).toBe(f.companies.A);
    const companies = await admin.get('/companies');
    expect(companies.body.items.map((c: { code: string }) => c.code)).toEqual(['A', 'B', 'C']);
    expect((await admin.get(`/vehicles/${vehicleB}`)).status).toBe(200);
  });

  it('T03 — un conducteur ne consulte ni les autres conducteurs ni un véhicule qu’il n’utilise pas', async () => {
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.get(`/drivers/${f.drivers.a2}`)).status).toBe(404);
    expect((await conducteur.get(`/drivers/${f.drivers.a1}`)).status).toBe(200);
    expect((await conducteur.get('/drivers')).status).toBe(403);
    expect((await conducteur.get('/vehicles')).status).toBe(403);
    expect((await conducteur.get(`/vehicles/${vehicleA}`)).status).toBe(404);
    expect((await conducteur.get('/users')).status).toBe(403);
    expect((await conducteur.get(`/users/${f.users.chefA}`)).status).toBe(403);
    // le conducteur voit le véhicule dont il est responsable habituel
    await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: vehicleA, driverId: f.drivers.a1, startsAt: new Date('2026-01-01T00:00:00Z') } });
    expect((await conducteur.get(`/vehicles/${vehicleA}`)).status).toBe(200);
  });

  it('le lecteur consulte mais ne modifie pas ; l’opérateur crée mais n’archive pas', async () => {
    const lecteur = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    expect((await lecteur.get(`/vehicles/${vehicleA}`)).status).toBe(200);
    expect((await lecteur.post('/vehicles', { companyId: f.companies.A, code: 'VA-2', registration: '101 TU 1', make: 'Renault', model: 'Clio', categoryId: f.categoryId })).status).toBe(403);
    const operateur = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    const created = await operateur.post('/vehicles', { companyId: f.companies.A, code: 'VA-2', registration: '101 TU 1', make: 'Renault', model: 'Clio', categoryId: f.categoryId });
    expect(created.status).toBe(201);
    expect((await operateur.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'test', expectedVersion: created.body.version })).status).toBe(403);
    expect((await chefB.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'test', expectedVersion: created.body.version })).status).toBe(404);
    expect((await chefA.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de test', expectedVersion: created.body.version })).status).toBe(200);
  });
});
