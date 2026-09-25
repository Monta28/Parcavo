import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * QR code interne d'un véhicule (CDC 10.3) : il ne porte qu'un identifiant opaque, aléatoire et
 * régénérable ; sa résolution exige une session, respecte le périmètre et ne fait que lire : aucune
 * affectation, utilisation, réservation, relevé ni localisation n'est créé, rien n'est modifié.
 */
describe('QR code interne du véhicule (CDC 10.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;
  let conducteurA: Agent;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-24T10:00:00.000Z' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  });

  async function vehicle(code: string, registration: string): Promise<{ id: string; qrToken: string }> {
    const created = await chefA.post('/vehicles', { companyId: f.companies.A, code, registration, make: 'Peugeot', model: '308', categoryId: f.categoryId, vin: `VF1QR${code.replace(/[^A-Z0-9]/g, '')}`.padEnd(17, '0').slice(0, 17) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const synthesis = await chefA.get(`/vehicles/${created.body.id}/synthesis`);
    expect(synthesis.status).toBe(200);
    return { id: created.body.id as string, qrToken: synthesis.body.qrToken as string };
  }

  /** État complet de ce que le scan pourrait écrire (lignes métier et version des véhicules). */
  async function snapshot() {
    const c = t.prisma.client;
    return {
      usages: await c.vehicleUsage.findMany({ select: { id: true, status: true, driverId: true }, orderBy: { id: 'asc' } }),
      assignments: await c.vehicleResponsibleAssignment.count(),
      reservations: await c.reservation.count(),
      readings: await c.odometerReading.count(),
      locations: await c.vehicleLocationReport.count(),
      alerts: await c.alert.count(),
      audit: await c.auditEvent.count(),
      vehicles: await c.vehicle.findMany({ select: { id: true, version: true, qrToken: true, companyId: true, lifecycleStatus: true }, orderBy: { id: 'asc' } }),
    };
  }

  it('le QR ne contient qu’un identifiant opaque : UUID aléatoire sans donnée du véhicule, propre à chaque véhicule, régénérable', async () => {
    const one = await vehicle('QR-001', '123 TU 4567');
    const two = await vehicle('QR-002', '124 TU 4567');
    const row = await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: one.id } });
    expect(one.qrToken).toMatch(UUID_V4);
    expect(two.qrToken).toMatch(UUID_V4);
    expect(one.qrToken).not.toBe(two.qrToken);
    for (const data of [row.id, row.code, row.registration, row.registrationNormalized, row.vin ?? '-', row.companyId, row.organizationId, f.companies.A]) {
      expect(one.qrToken.toLowerCase()).not.toContain(data.toLowerCase());
    }
    // La résolution ne renvoie que ce qu'il faut pour ouvrir la fiche.
    const resolved = await chefA.get(`/vehicles/qr/${one.qrToken}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ vehicleId: one.id, code: 'QR-001', registration: '123 TU 4567' });

    // Régénération (chef, auditée) : nouveau jeton opaque, l'ancien n'ouvre plus rien.
    const regenerated = await chefA.post(`/vehicles/${one.id}/qr/regenerate`);
    expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(200);
    expect(regenerated.body.qrToken).toMatch(UUID_V4);
    expect(regenerated.body.qrToken).not.toBe(one.qrToken);
    expect((await chefA.get(`/vehicles/qr/${one.qrToken}`)).status).toBe(404);
    expect((await chefA.get(`/vehicles/qr/${regenerated.body.qrToken}`)).body.vehicleId).toBe(one.id);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'vehicule.qr_regenere', objectId: one.id } })).toBe(1);
    // Un conducteur ne régénère pas le QR.
    expect((await conducteurA.post(`/vehicles/${one.id}/qr/regenerate`)).status).toBe(404);
  });

  it('résolution en lecture seule : ni affectation, ni utilisation, ni réservation, relevé, localisation, alerte ou trace créés ; véhicule inchangé', async () => {
    const free = await vehicle('QR-010', '310 TU 1000');
    const driven = await vehicle('QR-011', '311 TU 1000');
    // Utilisation en cours du conducteur A sur « driven » (remise faite ailleurs, pas par le QR).
    await t.prisma.client.vehicleUsage.create({
      data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: driven.id, driverId: f.drivers.a1, purpose: 'tournée', checkedOutAt: new Date('2026-09-24T08:00:00Z'), expectedReturnAt: new Date('2026-09-24T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' },
    });
    const before = await snapshot();

    // Chef de la société : ouvre la fiche, plusieurs fois.
    for (let i = 0; i < 3; i += 1) expect((await chefA.get(`/vehicles/qr/${free.qrToken}`)).status).toBe(200);
    // Conducteur : le QR d'un véhicule qui ne lui est pas remis ne l'affecte pas et ne lui ouvre rien.
    const notHis = await conducteurA.get(`/vehicles/qr/${free.qrToken}`);
    expect(notHis.status).toBe(404);
    expect(notHis.body.code).toBe('INTROUVABLE');
    // Son véhicule en cours d'utilisation : la fiche s'ouvre, sans nouvelle utilisation.
    expect((await conducteurA.get(`/vehicles/qr/${driven.qrToken}`)).body.vehicleId).toBe(driven.id);
    // Hors périmètre et jeton inconnu : même réponse 404.
    const other = await chefB.get(`/vehicles/qr/${free.qrToken}`);
    const unknown = await chefB.get(`/vehicles/qr/${randomUUID()}`);
    expect([other.status, unknown.status]).toEqual([404, 404]);
    expect(other.body.code).toBe(unknown.body.code);
    // Sans session : 401, aucun accès public par le QR.
    const anonymous = await request(t.server).get(`/api/v1/vehicles/qr/${free.qrToken}`);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain('QR-010');

    expect(await snapshot()).toEqual(before);
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId: free.id } })).toBe(0);
    expect(await t.prisma.client.vehicleResponsibleAssignment.count({ where: { vehicleId: { in: [free.id, driven.id] } } })).toBe(0);
  });
});
