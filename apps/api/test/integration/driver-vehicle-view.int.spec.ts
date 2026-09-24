import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/** Ce que voit un conducteur du véhicule (CDC 2.3, D-116) : contrôle serveur, pas seulement l'écran. */
describe('Fiche véhicule vue par un conducteur (CDC 2.3 — D-116, T03)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let conducteur: Agent;

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
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  });

  async function openUsage(vehicleId: string, driverId: string) {
    return t.prisma.client.vehicleUsage.create({
      data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId, status: 'EN_COURS', purpose: 'Mission', checkedOutAt: new Date('2026-09-24T08:00:00Z'), expectedReturnAt: new Date('2026-09-24T18:00:00Z'), checkedOutById: f.users.chefA },
    });
  }

  it('utilisation en cours du conducteur : identité, relevé et localisation sans auteur ; aucune donnée de gestion', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'DRV-1' });
    await t.prisma.client.vehicle.update({ where: { id: vehicleId }, data: { notes: 'Note interne du chef', vin: 'VF3ABCDEFGH123456' } });
    await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a2, startsAt: new Date('2026-09-01T08:00:00Z'), createdById: f.users.chefA } });
    expect((await chefA.post(`/vehicles/${vehicleId}/location-reports`, { placeLabel: 'Parking client', observedAt: '2026-09-24T07:30:00Z', comment: 'vu par Sami Deux' })).status).toBe(201);
    await openUsage(vehicleId, f.drivers.a1);

    const staff = (await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body;
    expect(staff.responsible.driverName).toBe('Sami Deux');
    expect(staff.notes).toBe('Note interne du chef');
    expect(staff.documentCompliance).not.toBeNull();
    expect(staff.qrToken).toEqual(expect.any(String));

    const res = await conducteur.get(`/vehicles/${vehicleId}/synthesis`);
    expect(res.status).toBe(200);
    const v = res.body;
    expect(v.code).toBe('DRV-1');
    expect(v.currentUsage.driverId).toBe(f.drivers.a1);
    expect(v.responsible).toBeNull();
    expect(v.notes).toBeNull();
    expect(v.vin).toBeNull();
    expect(v.upcomingMaintenance).toEqual([]);
    expect(v.documentCompliance).toBeNull();
    expect(v.openIncidents).toBeNull();
    expect(v.pendingReadings).toBeNull();
    expect(v.photoAttachmentIds).toEqual([]);
    expect(v.qrToken).toBeNull();
    expect(v.lastLocation).toMatchObject({ placeLabel: 'Parking client', createdById: null, createdByName: null, comment: null });
    const view = (await conducteur.get(`/vehicles/${vehicleId}`)).body;
    expect(view.notes).toBeNull();
    expect(JSON.stringify(view)).not.toContain('Sami');
  });

  it('véhicule dont il est responsable habituel mais utilisé par un autre : jamais le nom de l’autre conducteur', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'DRV-2' });
    await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, startsAt: new Date('2026-09-01T08:00:00Z'), createdById: f.users.chefA } });
    await openUsage(vehicleId, f.drivers.a2);
    const res = await conducteur.get(`/vehicles/${vehicleId}/synthesis`);
    expect(res.status).toBe(200);
    expect(res.body.operationalStatus).toBe('EN_UTILISATION');
    expect(res.body.currentUsage).toBeNull();
    expect(res.body.responsible.driverId).toBe(f.drivers.a1);
    expect(JSON.stringify(res.body)).not.toContain('Sami');
    expect(JSON.stringify((await conducteur.get(`/vehicles/${vehicleId}`)).body)).not.toContain('Sami');
  });
});
