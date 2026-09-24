import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { buildOpenApiDocument } from '../../src/bootstrap.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Incidents — idempotence de la déclaration (D-308), responsable du suivi, suivi interne masqué au
 * conducteur (D-216), contravention sans responsabilité déduite (D-217).
 */
describe('Incidents : déclaration idempotente, suivi et visibilité (CDC 7.3, 10.3 ; D-216, D-217, D-308)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteur: Agent;
  let vehicleId: string;

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
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-1', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
  });

  async function checkout() {
    const res = await chefA.post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T08:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission client', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' } }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  it('POST /incidents : Idempotency-Key facultatif, lié à l’utilisateur ; même clé et même corps → une seule déclaration', async () => {
    const usage = await checkout();
    const key = randomUUID();
    const body = { type: 'PANNE', description: 'Voyant moteur allumé', locationLabel: 'Autoroute A1' };
    const first = await conducteur.post('/incidents', body).set('Idempotency-Key', key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Réseau mobile instable : le formulaire renvoie la même clé.
    const replay = await conducteur.post('/incidents', body).set('Idempotency-Key', key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.reference).toBe(first.body.reference);
    expect(await t.prisma.client.incident.count()).toBe(1);
    // Même clé, contenu différent : 409, rien d'enregistré.
    const other = await conducteur.post('/incidents', { ...body, description: 'Autre problème constaté' }).set('Idempotency-Key', key);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect(await t.prisma.client.incident.count()).toBe(1);
    // La clé est liée à l'utilisateur : la même clé chez un autre utilisateur est une autre opération.
    const staff = await chefA.post('/incidents', { ...body, vehicleId }).set('Idempotency-Key', key);
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    expect(staff.body.id).not.toBe(first.body.id);
    // Clé invalide : 422 explicite ; sans clé, chaque envoi est une nouvelle déclaration.
    const short = await conducteur.post('/incidents', body).set('Idempotency-Key', 'abc');
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('IDEMPOTENCE_CLE_INVALIDE');
    expect((await conducteur.post('/incidents', body)).status).toBe(201);
    expect(await t.prisma.client.incident.count()).toBe(3);
    // Le rejeu n'intervient qu'après l'autorisation : hors fenêtre de déclaration, la clé n'est plus rejouée.
    const back = await chefA.post(`/usages/${usage.id}/return`, { returnedAt: '2026-09-24T09:00:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt' }, expectedVersion: usage.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    t.clock.set('2026-09-25T10:00:00.000Z');
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.post('/incidents', body).set('Idempotency-Key', key)).status).toBe(404);
  });

  it('vue : nom du site et du responsable du suivi ; candidats au suivi (nom seulement) pour le personnel de la société', async () => {
    const site = await t.prisma.client.site.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, name: 'Dépôt Nord' } });
    const inc = await chefA.post('/incidents', { vehicleId, type: 'DOMMAGE', description: 'Rétroviseur cassé', siteId: site.id, followUpUserId: f.users.operateurA });
    expect(inc.status, JSON.stringify(inc.body)).toBe(201);
    expect(inc.body).toMatchObject({ siteId: site.id, siteName: 'Dépôt Nord', followUpUserId: f.users.operateurA, followUpUserName: 'Omar Opérateur-A' });
    const listed = await chefA.get('/incidents');
    expect(listed.body.items[0]).toMatchObject({ siteName: 'Dépôt Nord', followUpUserName: 'Omar Opérateur-A' });

    // Candidats : administrateur, chefs de parc et opérateurs ACTIFS de la société ; nom seulement.
    const inactive = await t.prisma.client.user.create({ data: { organizationId: f.organizationId, email: `inactif.${randomUUID().slice(0, 6)}@test.local`, firstName: 'Ines', lastName: 'Inactive', passwordHash: 'x', status: 'DESACTIVE', memberships: { create: [{ companyId: f.companies.A, role: 'OPERATEUR' }] } } });
    const candidates = await operateurA.get(`/incidents/follow-up-candidates?companyId=${f.companies.A}`);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body).toEqual([
      { id: f.users.admin, name: 'Alice Admin' },
      { id: f.users.chefA, name: 'Chaima Chef-A' },
      { id: f.users.operateurA, name: 'Omar Opérateur-A' },
    ]);
    expect(candidates.body.some((c: { id: string }) => c.id === inactive.id)).toBe(false);
    expect((await admin.get(`/incidents/follow-up-candidates?companyId=${f.companies.B}`)).body).toEqual([
      { id: f.users.admin, name: 'Alice Admin' },
      { id: f.users.chefB, name: 'Bilel Chef-B' },
    ]);
    // Accès : personnel de la société (lecteur compris, lecture seule) ; autre société : 404 ; conducteur : 403.
    expect((await chefB.get(`/incidents/follow-up-candidates?companyId=${f.companies.A}`)).status).toBe(404);
    const forReader = await lecteurA.get(`/incidents/follow-up-candidates?companyId=${f.companies.A}`);
    expect(forReader.status, JSON.stringify(forReader.body)).toBe(200);
    expect(forReader.body).toEqual(candidates.body);
    expect((await conducteur.get(`/incidents/follow-up-candidates?companyId=${f.companies.A}`)).status).toBe(403);
    expect((await chefA.get('/incidents/follow-up-candidates')).status).toBe(422);
    // Un opérateur désigne un autre candidat ; un utilisateur inactif est refusé.
    expect((await operateurA.patch(`/incidents/${inc.body.id}`, { followUpUserId: f.users.chefA, expectedVersion: 1 })).body.followUpUserName).toBe('Chaima Chef-A');
    expect((await operateurA.patch(`/incidents/${inc.body.id}`, { followUpUserId: inactive.id, expectedVersion: 2 })).status).toBe(404);
  });

  it('D-216 : la note de résolution n’est pas renvoyée au conducteur ; il lit les commentaires partagés', async () => {
    await checkout();
    const inc = await conducteur.post('/incidents', { type: 'CREVAISON', description: 'Pneu avant droit crevé' });
    expect(inc.status).toBe(201);
    const assigned = await chefA.patch(`/incidents/${inc.body.id}`, { followUpUserId: f.users.chefA, expectedVersion: 1 });
    const resolved = await chefA.post(`/incidents/${inc.body.id}/transition`, { to: 'RESOLU', note: 'Pneu remplacé, facture 180 DT chez Garage X', expectedVersion: assigned.body.version });
    expect(resolved.body.resolutionNote).toBe('Pneu remplacé, facture 180 DT chez Garage X');
    await chefA.post(`/incidents/${inc.body.id}/comments`, { body: 'Le pneu a été remplacé, vous pouvez reprendre le véhicule.', visibility: 'PARTAGE_CONDUCTEUR' });

    const seen = await conducteur.get(`/incidents/${inc.body.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ status: 'RESOLU', resolutionNote: null, closureNote: null, followUpUserId: null, followUpUserName: null });
    expect(seen.body.resolvedAt).toBeTruthy();
    expect((await conducteur.get('/incidents')).body.items[0].resolutionNote).toBeNull();
    const comments = await conducteur.get(`/incidents/${inc.body.id}/comments`);
    expect(comments.body.map((c: { body: string }) => c.body)).toEqual(['Le pneu a été remplacé, vous pouvez reprendre le véhicule.']);
    expect(JSON.stringify(comments.body)).not.toContain('180 DT');
    expect((await chefA.get(`/incidents/${inc.body.id}`)).body.followUpUserName).toBe('Chaima Chef-A');
  });

  it('contravention : conducteur de l’utilisation à l’instant déclaré fourni à titre d’information (identifiant et nom)', async () => {
    const usage = await checkout();
    const pv = await chefA.post('/incidents', { vehicleId, type: 'CONTRAVENTION', severity: 'FAIBLE', occurredAt: '2026-09-24T09:00:00Z', description: 'Avis de contravention stationnement' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(201);
    expect(pv.body).toMatchObject({ driverId: null, usageAtTimeId: usage.id, usageAtTimeDriverId: f.drivers.a1, usageAtTimeDriverName: 'Karim Conducteur-A' });
    const before = await chefA.post('/incidents', { vehicleId, type: 'CONTRAVENTION', severity: 'FAIBLE', occurredAt: '2026-09-23T09:00:00Z', description: 'Avis antérieur au départ' });
    expect(before.body).toMatchObject({ usageAtTimeId: null, usageAtTimeDriverId: null, usageAtTimeDriverName: null });
    const list = await chefA.get('/incidents?type=CONTRAVENTION');
    expect(list.body.items.map((i: { usageAtTimeDriverId: string | null }) => i.usageAtTimeDriverId).sort()).toEqual([f.drivers.a1, null].sort());
  });

  it('contrat OpenAPI : en-tête Idempotency-Key facultatif, candidats au suivi, résultat de l’immobilisation', () => {
    const openapi = buildOpenApiDocument(t.app);
    const create = openapi.paths['/api/v1/incidents']?.post;
    expect(create?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: false })]));
    expect(openapi.paths['/api/v1/incidents/follow-up-candidates']?.get?.responses?.['200']).toBeDefined();
    const schemas = openapi.components?.schemas ?? {};
    expect(Object.keys((schemas['IncidentImmobilizeResultDto'] as { properties: object }).properties)).toEqual(expect.arrayContaining(['immobilizationId', 'causeId', 'created', 'incident']));
    expect(Object.keys((schemas['IncidentViewDto'] as { properties: object }).properties)).toEqual(expect.arrayContaining(['siteName', 'followUpUserName', 'usageAtTimeDriverId']));
    expect(openapi.paths['/api/v1/suppliers/{id}/copy']?.post).toBeDefined();
  });
});
