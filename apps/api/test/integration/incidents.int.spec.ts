import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Incidents et immobilisations (CDC 7.3, 7.4, 4.5 — T23)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
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
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-1', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
  });

  async function checkout(driverId = f.drivers.a1) {
    const res = await chefA.post('/usages/checkout', { vehicleId, driverId, checkedOutAt: '2026-09-24T08:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission client', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' } }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  it('le conducteur déclare sur son utilisation ; véhicule et utilisation fixés par le serveur ; il ne modifie pas le dossier', async () => {
    expect((await conducteur.post('/incidents', { type: 'PANNE', description: 'Voyant moteur allumé' })).status).toBe(404);
    const usage = await checkout();
    const other = await createVehicle(t.prisma, f, 'A');
    const declared = await conducteur.post('/incidents', { vehicleId: other, type: 'PANNE', description: 'Voyant moteur allumé' });
    expect(declared.status).toBe(404);
    const ok = await conducteur.post('/incidents', { type: 'PANNE', description: 'Voyant moteur allumé', locationLabel: 'Autoroute A1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ vehicleId, usageId: usage.id, driverId: f.drivers.a1, status: 'OUVERT', severity: 'MOYENNE' });
    expect(ok.body.reference).toMatch(/^INC-2026-\d{6}$/);
    expect((await conducteur.patch(`/incidents/${ok.body.id}`, { description: 'Autre texte assez long', expectedVersion: 1 })).status).toBe(403);
    expect((await conducteur.post(`/incidents/${ok.body.id}/transition`, { to: 'RESOLU', note: 'fait', expectedVersion: 1 })).status).toBe(403);
    // Commentaires : le conducteur ne voit que les commentaires partagés.
    await chefA.post(`/incidents/${ok.body.id}/comments`, { body: 'Coût estimé 400 DT, garage X' });
    await chefA.post(`/incidents/${ok.body.id}/comments`, { body: 'Déposez le véhicule demain.', visibility: 'PARTAGE_CONDUCTEUR' });
    await conducteur.post(`/incidents/${ok.body.id}/comments`, { body: 'D’accord.' });
    const seen = await conducteur.get(`/incidents/${ok.body.id}/comments`);
    expect(seen.body.map((c: { body: string }) => c.body)).toEqual(['Déposez le véhicule demain.', 'D’accord.']);
    expect((await chefA.get(`/incidents/${ok.body.id}/comments`)).body).toHaveLength(3);
    // Un autre conducteur (compte lié à a2) ne voit pas cet incident.
    expect((await chefB.get(`/incidents/${ok.body.id}`)).status).toBe(404);
  });

  it('déclaration conducteur possible dans les 24 h après restitution, pas au-delà', async () => {
    const usage = await checkout();
    const back = await chefA.post(`/usages/${usage.id}/return`, { returnedAt: '2026-09-24T09:00:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt' }, expectedVersion: usage.version }).set('Idempotency-Key', randomUUID());
    expect(back.status).toBe(200);
    t.clock.set('2026-09-25T08:00:00.000Z');
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.post('/incidents', { type: 'DOMMAGE', description: 'Rayure constatée au retour' })).status).toBe(201);
    t.clock.set('2026-09-25T10:00:00.000Z');
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.post('/incidents', { type: 'DOMMAGE', description: 'Rayure constatée plus tard' })).status).toBe(404);
  });

  it('incident critique : alerte immédiate, résolue à la prise en charge ; transitions et rôles ; clôture après résolution', async () => {
    const inc = await operateurA.post('/incidents', { vehicleId, type: 'ACCIDENT', severity: 'CRITIQUE', description: 'Accrochage sur parking' });
    expect(inc.status).toBe(201);
    expect(await t.prisma.client.alert.count({ where: { type: 'INCIDENT_CRITIQUE', objectId: inc.body.id, status: 'ACTIVE' } })).toBe(1);
    const inProgress = await operateurA.post(`/incidents/${inc.body.id}/transition`, { to: 'EN_TRAITEMENT', expectedVersion: 1 });
    expect(inProgress.body.status).toBe('EN_TRAITEMENT');
    expect(await t.prisma.client.alert.count({ where: { type: 'INCIDENT_CRITIQUE', objectId: inc.body.id, status: 'ACTIVE' } })).toBe(0);
    expect((await operateurA.post(`/incidents/${inc.body.id}/transition`, { to: 'RESOLU', expectedVersion: 2 })).body.code).toBe('NOTE_REQUISE');
    const resolved = await operateurA.post(`/incidents/${inc.body.id}/transition`, { to: 'RESOLU', note: 'Pare-choc remplacé', expectedVersion: 2 });
    expect(resolved.body).toMatchObject({ status: 'RESOLU', resolutionNote: 'Pare-choc remplacé' });
    // La clôture administrative est distincte et réservée au chef.
    expect((await operateurA.post(`/incidents/${inc.body.id}/transition`, { to: 'CLOTURE', expectedVersion: 3 })).status).toBe(403);
    const closed = await chefA.post(`/incidents/${inc.body.id}/transition`, { to: 'CLOTURE', expectedVersion: 3 });
    expect(closed.body.status).toBe('CLOTURE');
    expect((await chefA.post(`/incidents/${inc.body.id}/transition`, { to: 'EN_TRAITEMENT', note: 'Réouverture', expectedVersion: 4 })).status).toBe(403);
    expect((await admin.post(`/incidents/${inc.body.id}/transition`, { to: 'EN_TRAITEMENT', note: 'Litige assureur', expectedVersion: 4 })).body.status).toBe('EN_TRAITEMENT');
  });

  it('T23 — immobilisation pendant une utilisation : utilisation conservée, chef prévenu, retour possible, véhicule toujours immobilisé', async () => {
    const usage = await checkout();
    const inc = await chefA.post('/incidents', { vehicleId, usageId: usage.id, type: 'PANNE', severity: 'ELEVEE', description: 'Panne moteur en mission' });
    const immo = await chefA.post(`/incidents/${inc.body.id}/immobilize`, { reason: 'Panne moteur', locationLabel: 'Bord de route' });
    expect(immo.status, JSON.stringify(immo.body)).toBe(200);
    expect(immo.body.incident.openImmobilizationCauseId).toBeTruthy();
    expect(immo.body).toMatchObject({ created: true, placeApplied: true, expectedEndApplied: false });
    expect((await chefA.get(`/usages/${usage.id}`)).body.status).toBe('EN_COURS');
    const warn = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'IMMOBILISATION_PENDANT_UTILISATION', objectId: usage.id } });
    expect(warn.status).toBe('ACTIVE');
    const back = await chefA.post(`/usages/${usage.id}/return`, { returnedAt: '2026-09-24T09:30:00Z', reading: { physicalKm: '10140' }, location: { placeLabel: 'Garage' }, expectedVersion: usage.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('IMMOBILISE');
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { id: warn.id } })).status).toBe('RESOLUE');
    // Nouveau départ bloqué tant que l'immobilisation dure.
    const again = await chefA.post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T09:45:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '10140' }, location: { placeLabel: 'Garage' } }).set('Idempotency-Key', randomUUID());
    expect(again.status).toBe(422);
    // Deux causes simultanées regroupées ; la disponibilité revient après la dernière.
    const list = await chefA.get(`/immobilizations?vehicleId=${vehicleId}&status=ACTIVE`);
    const immobilization = list.body.items[0];
    expect(immobilization.id).toBe(immo.body.immobilizationId);
    const withSecond = await chefA.post(`/immobilizations/${immobilization.id}/causes`, { reason: 'Attente expertise assurance', expectedVersion: immobilization.version });
    expect(withSecond.body.causes).toHaveLength(2);
    expect((await chefA.post(`/immobilizations/${immobilization.id}/causes`, { reason: 'Doublon', incidentId: inc.body.id, expectedVersion: withSecond.body.version })).body.code).toBe('CAUSE_EXISTANTE');
    const firstCause = withSecond.body.causes.find((c: { incidentId: string | null }) => c.incidentId === inc.body.id);
    const one = await chefA.post(`/immobilizations/${immobilization.id}/causes/${firstCause.id}/end`, { reason: 'Moteur réparé', expectedVersion: withSecond.body.version });
    expect(one.body.status).toBe('ACTIVE');
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('IMMOBILISE');
    const done = await chefA.post(`/immobilizations/${immobilization.id}/end`, { reason: 'Expertise terminée', expectedVersion: one.body.version });
    expect(done.body.status).toBe('TERMINEE');
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('DISPONIBLE');
  });

  it('intervention ouverte depuis l’incident ; clôture de l’incident refusée tant qu’elle est ouverte ; contravention sans responsabilité déduite', async () => {
    const inc = await chefA.post('/incidents', { vehicleId, type: 'PANNE', description: 'Démarrage difficile' });
    const intervention = await chefA.post(`/incidents/${inc.body.id}/intervention`, { diagnosis: 'Batterie faible' });
    expect(intervention.status, JSON.stringify(intervention.body)).toBe(201);
    expect(intervention.body).toMatchObject({ kind: 'CORRECTIF', incidentId: inc.body.id, status: 'BROUILLON' });
    const resolved = await chefA.post(`/incidents/${inc.body.id}/transition`, { to: 'RESOLU', note: 'Diagnostic posé', expectedVersion: 1 });
    const refused = await chefA.post(`/incidents/${inc.body.id}/transition`, { to: 'CLOTURE', expectedVersion: resolved.body.version });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CLOTURE_IMPOSSIBLE');
    expect((await chefA.get(`/incidents/${inc.body.id}`)).body.interventionIds).toEqual([intervention.body.id]);

    const usage = await checkout();
    const pv = await chefA.post('/incidents', { vehicleId, type: 'CONTRAVENTION', severity: 'FAIBLE', occurredAt: '2026-09-24T09:00:00Z', description: 'Avis de contravention stationnement' });
    expect(pv.body).toMatchObject({ driverId: null, usageAtTimeId: usage.id });
    expect(pv.body.usageAtTimeDriverName).toBeTruthy();
    // Le lien au conducteur ne se pose que par une action explicite du chef.
    expect((await operateurA.patch(`/incidents/${pv.body.id}`, { driverId: f.drivers.a1, expectedVersion: 1 })).status).toBe(403);
    expect((await chefA.patch(`/incidents/${pv.body.id}`, { driverId: f.drivers.a1, expectedVersion: 1 })).body.driverId).toBe(f.drivers.a1);
    expect(await t.prisma.client.expense.count()).toBe(0);
  });
});
