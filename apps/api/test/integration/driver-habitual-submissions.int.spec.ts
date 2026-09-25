import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * D-268 (CDC 10.3, 2.3) : avec drivers.allowHabitualVehicleSubmissions, le conducteur responsable habituel
 * actif d'un véhicule y fait, sans utilisation en cours, les trois actions de « Mon véhicule » : relevé de
 * compteur, signalement d'incident et ticket carburant. Règle unique : DriverSubmissionService (cibles
 * renvoyées par GET /driver-submissions/vehicles), appliquée par les modules relevés, incidents et carburant.
 * Paramètre inactif : refus ; véhicule dont il n'est pas responsable : 404 ; utilisation en cours d'un autre
 * véhicule : seul ce véhicule reste ouvert ; la déclaration d'incident après restitution (D-216) est conservée.
 */
describe('Responsable habituel sans utilisation : relevé, signalement et ticket (D-268)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let conducteur: Agent;
  let habitualId: string;
  let otherId: string;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    habitualId = await prepareVehicle('10000');
    otherId = await prepareVehicle('20000');
    const assignment = await chefA.post('/responsible-assignments', { vehicleId: habitualId, driverId: f.drivers.a1, startsAt: '2026-09-01T08:00:00Z' });
    expect(assignment.status, JSON.stringify(assignment.body)).toBe(201);
  });

  /** Véhicule diesel de la société A, compteur initialisé par le chef. */
  async function prepareVehicle(initKm: string): Promise<string> {
    const id = await createVehicle(t.prisma, f, 'A');
    const patched = await chefA.patch(`/vehicles/${id}`, { energy: 'DIESEL', tankCapacityLiters: '60', expectedVersion: 1 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const init = await chefA.post(`/vehicles/${id}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: initKm });
    expect(init.status, JSON.stringify(init.body)).toBe(201);
    return id;
  }

  async function enableSetting(value: boolean) {
    const res = await admin.put('/settings/drivers.allowHabitualVehicleSubmissions', { value, reason: value ? 'Véhicules de fonction' : 'Retour au régime par défaut' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  const reading = (vehicleId: string, physicalKm: string) => conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt: '2026-09-24T09:30:00Z' }).set('Idempotency-Key', randomUUID());
  const incident = (payload: Record<string, unknown>) => conducteur.post('/incidents', { type: 'PANNE', description: 'Voyant moteur allumé', ...payload }).set('Idempotency-Key', randomUUID());
  const ticket = async (vehicleId: string, filledAt = '2026-09-24T07:30:00Z') =>
    conducteur.post('/fuel-entries', { vehicleId, filledAt, liters: '25', totalAmount: '63.125', isFullTank: false, ticketAttachmentId: await uploadPdf(conducteur, t.server, f.companies.A) }).set('Idempotency-Key', randomUUID());

  it('paramètre inactif : aucune cible, relevé refusé (403), signalement et ticket introuvables (404), rien n’est enregistré', async () => {
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([]);
    const refusedReading = await reading(habitualId, '10200');
    expect(refusedReading.status, JSON.stringify(refusedReading.body)).toBe(403);
    expect(refusedReading.body.code).toBe('ACTION_INTERDITE');
    expect((await incident({})).status).toBe(404);
    expect((await incident({ vehicleId: habitualId })).status).toBe(404);
    expect((await ticket(habitualId)).status).toBe(404);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: habitualId, createdById: f.users.conducteurA } })).toBe(0);
    expect(await t.prisma.client.incident.count({ where: { vehicleId: habitualId } })).toBe(0);
    expect(await t.prisma.client.fuelEntry.count({ where: { vehicleId: habitualId } })).toBe(0);
  });

  it('paramètre actif : relevé en attente, signalement sans utilisation et ticket soumis sur le véhicule habituel ; véhicule d’un autre : 404', async () => {
    await enableSetting(true);
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([{ vehicleId: habitualId, vehicleCode: expect.any(String), registration: expect.any(String), basis: 'RESPONSABLE_HABITUEL', usageId: null }]);

    const accepted = await reading(habitualId, '10200');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.reading).toMatchObject({ vehicleId: habitualId, status: 'EN_ATTENTE' });

    const declared = await incident({ vehicleId: habitualId, locationLabel: 'Parking du siège' });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    expect(declared.body).toMatchObject({ vehicleId: habitualId, usageId: null, driverId: f.drivers.a1, status: 'OUVERT' });
    // Sans véhicule indiqué : le seul véhicule habituel est retenu par le serveur.
    const implicit = await incident({});
    expect(implicit.status, JSON.stringify(implicit.body)).toBe(201);
    expect(implicit.body).toMatchObject({ vehicleId: habitualId, usageId: null });
    // Le chef de parc suit le dossier, rattaché au conducteur.
    expect((await chefA.get(`/incidents/${declared.body.id}`)).body).toMatchObject({ driverId: f.drivers.a1, usageId: null });
    // Même délai que la déclaration après restitution (incidents.driverLateDeclarationHours, 24 h par défaut).
    const old = await incident({ vehicleId: habitualId, occurredAt: '2026-09-23T09:00:00Z' });
    expect(old.status, JSON.stringify(old.body)).toBe(422);
    expect(old.body.code).toBe('DATE_HORS_DELAI');
    // Un conducteur ne fixe ni l'utilisation ni le suivi.
    expect((await incident({ vehicleId: habitualId, siteId: randomUUID() })).body.code).toBe('CHAMP_RESERVE');

    const submitted = await ticket(habitualId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({ vehicleId: habitualId, status: 'SOUMIS' });

    // Véhicule d'un autre (ni utilisation ni responsabilité) : introuvable pour les trois actions.
    expect((await reading(otherId, '20100')).status).toBe(404);
    expect((await incident({ vehicleId: otherId })).status).toBe(404);
    expect((await ticket(otherId)).status).toBe(404);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: otherId, createdById: f.users.conducteurA } })).toBe(0);
    expect(await t.prisma.client.incident.count({ where: { vehicleId: otherId } })).toBe(0);
    expect(await t.prisma.client.fuelEntry.count({ where: { vehicleId: otherId } })).toBe(0);

    // Paramètre désactivé à nouveau : le droit disparaît aussitôt.
    await enableSetting(false);
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([]);
    expect((await incident({ vehicleId: habitualId })).status).toBe(404);
  });

  it('utilisation en cours d’un autre véhicule : seul ce véhicule reste ouvert ; après restitution, le signalement tardif reste rattaché à l’utilisation', async () => {
    await enableSetting(true);
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-HAB', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const usage = await chefA
      .post('/usages/checkout', { vehicleId: otherId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T08:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission client', reading: { physicalKm: '20100' }, location: { placeLabel: 'Dépôt' } })
      .set('Idempotency-Key', randomUUID());
    expect(usage.status, JSON.stringify(usage.body)).toBe(201);
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([{ vehicleId: otherId, vehicleCode: expect.any(String), registration: expect.any(String), basis: 'UTILISATION_EN_COURS', usageId: usage.body.id }]);
    expect((await reading(habitualId, '10200')).status).toBe(403);
    expect((await incident({ vehicleId: habitualId })).status).toBe(404);
    expect((await ticket(habitualId, '2026-09-24T09:00:00Z')).status).toBe(404);

    const back = await chefA.post(`/usages/${usage.body.id}/return`, { returnedAt: '2026-09-24T09:00:00Z', reading: { physicalKm: '20150' }, location: { placeLabel: 'Dépôt' }, expectedVersion: usage.body.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    t.clock.set('2026-09-25T08:00:00.000Z');
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    // Utilisation terminée depuis moins de 24 h : elle reste prioritaire (D-216) ; le véhicule habituel reste accessible.
    const late = await incident({});
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect(late.body).toMatchObject({ vehicleId: otherId, usageId: usage.body.id });
    const onHabitual = await incident({ vehicleId: habitualId });
    expect(onHabitual.status, JSON.stringify(onHabitual.body)).toBe(201);
    expect(onHabitual.body).toMatchObject({ vehicleId: habitualId, usageId: null });
    // Au-delà du délai : l'utilisation n'est plus retenue, le signalement va au véhicule habituel.
    t.clock.set('2026-09-25T10:00:00.000Z');
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await incident({ vehicleId: otherId })).status).toBe(404);
    const fallback = await incident({});
    expect(fallback.status, JSON.stringify(fallback.body)).toBe(201);
    expect(fallback.body).toMatchObject({ vehicleId: habitualId, usageId: null });
  });
});
