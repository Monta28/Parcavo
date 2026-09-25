import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/** Répertoire des fournisseurs (CDC 8.1, D-221) : unicité normalisée parmi les actifs, copie, archivés refusés. */
describe('Fournisseurs : unicité, copie vers une autre société, archivés (CDC 8.1 ; D-221)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let chefAB: Agent;

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
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    // Chef de parc des sociétés A et B.
    const hash = (await t.prisma.client.user.findUniqueOrThrow({ where: { id: f.users.chefA }, select: { passwordHash: true } })).passwordHash;
    const email = `chef.ab.${randomUUID().slice(0, 6)}@test.local`;
    await t.prisma.client.user.create({ data: { organizationId: f.organizationId, email, firstName: 'Amel', lastName: 'Chef-AB', passwordHash: hash, memberships: { create: [{ companyId: f.companies.A, role: 'CHEF_PARC' }, { companyId: f.companies.B, role: 'CHEF_PARC' }] } } });
    chefAB = await login(t.server, email, DEFAULT_PASSWORD);
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

  it('« Copier vers une autre société » : chef des deux sociétés ou administrateur ; nouvelle fiche sans historique ni montants', async () => {
    const source = await supplier(chefAB, { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE', contactName: 'M. Ben Salah', phone: '+216 71 000 000', email: 'Atelier@Garage.tn', address: 'Route de Tunis', notes: 'Ouvert le samedi' });
    const expense = await chefA.post('/expenses', { vehicleId: await createVehicle(t.prisma, f, 'A'), occurredOn: '2026-09-10', category: 'ENTRETIEN_REPARATION', supplierId: source.id, reference: 'FAC-1', amount: '450' }).set('Idempotency-Key', randomUUID());
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);

    // Chef de A seulement : la société B est hors périmètre (404) ; opérateur : 403 ; même société : 422.
    expect((await chefA.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.B })).status).toBe(404);
    expect((await operateurA.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.B })).status).toBe(403);
    expect((await chefB.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.B })).status).toBe(404);
    const same = await chefAB.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.A });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('MEME_SOCIETE');

    const copy = await chefAB.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.B });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body).toMatchObject({ companyId: f.companies.B, name: 'Garage Central', category: 'GARAGE', contactName: 'M. Ben Salah', phone: '+216 71 000 000', email: 'atelier@garage.tn', address: 'Route de Tunis', notes: 'Ouvert le samedi', status: 'ACTIF', archivedAt: null, version: 1 });
    expect(copy.body.id).not.toBe(source.id);
    // Sans historique ni montants : aucune dépense ne référence la copie ; la source garde la sienne.
    expect((await chefB.get(`/expenses?companyId=${f.companies.B}&supplierId=${copy.body.id}`)).body.total).toBe(0);
    expect(await t.prisma.client.expense.count({ where: { supplierId: copy.body.id } })).toBe(0);
    expect(await t.prisma.client.expense.count({ where: { supplierId: source.id } })).toBe(1);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'fournisseur.copie', objectId: copy.body.id } });
    expect(audit.after).toMatchObject({ copiedFromSupplierId: source.id, copiedFromCompanyId: f.companies.A });
    // Le chef de B voit la copie ; une seconde copie vers B est refusée (homonyme actif).
    expect((await chefB.get(`/suppliers/${copy.body.id}`)).status).toBe(200);
    const twice = await chefAB.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.B });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('FOURNISSEUR_EXISTANT');
    // Administrateur : toute société de l'organisation ; société inconnue : 404.
    expect((await admin.post(`/suppliers/${source.id}/copy`, { companyId: f.companies.C })).status).toBe(201);
    expect((await admin.post(`/suppliers/${source.id}/copy`, { companyId: randomUUID() })).status).toBe(404);
    // Fournisseur archivé : pas de copie.
    const archived = await chefAB.post(`/suppliers/${copy.body.id}/archive`, { expectedVersion: 1 });
    const fromArchived = await chefAB.post(`/suppliers/${archived.body.id}/copy`, { companyId: f.companies.A });
    expect(fromArchived.status).toBe(422);
    expect(fromArchived.body.code).toBe('FOURNISSEUR_ARCHIVE');
  });

  it('fournisseur archivé choisi dans un formulaire : 422 FOURNISSEUR_ARCHIVE (et non 404) ; hors société : 404', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const garage = await supplier(chefA, { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE' });
    const archived = await chefA.post(`/suppliers/${garage.id}/archive`, { expectedVersion: garage.version });
    expect(archived.status).toBe(200);

    const intervention = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', supplierId: garage.id, tasks: [{ label: 'Vidange' }] });
    expect(intervention.status).toBe(422);
    expect(intervention.body).toMatchObject({ code: 'FOURNISSEUR_ARCHIVE', fieldErrors: { supplierId: ['Fournisseur archivé.'] } });
    const expense = await chefA.post('/expenses', { vehicleId, occurredOn: '2026-09-15', category: 'ENTRETIEN_REPARATION', supplierId: garage.id, amount: '100' }).set('Idempotency-Key', randomUUID());
    expect(expense.status).toBe(422);
    expect(expense.body.code).toBe('FOURNISSEUR_ARCHIVE');
    const immobilization = await chefA.post('/immobilizations', { vehicleId, reason: 'Réparation', garageSupplierId: garage.id });
    expect(immobilization.status).toBe(422);
    expect(immobilization.body).toMatchObject({ code: 'FOURNISSEUR_ARCHIVE', fieldErrors: { garageSupplierId: ['Fournisseur archivé.'] } });
    // Plein : même contrôle (station archivée), rien n'est enregistré.
    const station = await supplier(chefA, { companyId: f.companies.A, name: 'Station du Lac', category: 'STATION' });
    await chefA.post(`/suppliers/${station.id}/archive`, { expectedVersion: station.version });
    expect((await chefA.patch(`/vehicles/${vehicleId}`, { energy: 'DIESEL', expectedVersion: 1 })).status).toBe(200);
    const fuel = await chefA.post('/fuel-entries', { vehicleId, filledAt: '2026-09-23T08:00:00Z', liters: '40', unitPrice: '2.525', totalAmount: '101.000', isFullTank: true, supplierId: station.id }).set('Idempotency-Key', randomUUID());
    expect(fuel.status, JSON.stringify(fuel.body)).toBe(422);
    expect(fuel.body).toMatchObject({ code: 'FOURNISSEUR_ARCHIVE', fieldErrors: { supplierId: ['Fournisseur archivé.'] } });
    expect(await t.prisma.client.fuelEntry.count()).toBe(0);

    // Fournisseur d'une autre société : toujours introuvable (404), sans révéler son statut.
    const garageB = await supplier(chefB, { companyId: f.companies.B, name: 'Garage B', category: 'GARAGE' });
    await chefB.post(`/suppliers/${garageB.id}/archive`, { expectedVersion: garageB.version });
    expect((await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', supplierId: garageB.id, tasks: [{ label: 'Vidange' }] })).status).toBe(404);
    // L'historique reste lisible : le fournisseur archivé s'affiche toujours.
    expect((await chefA.get(`/suppliers/${garage.id}`)).body).toMatchObject({ status: 'ARCHIVE', name: 'Garage Central' });
  });
});
