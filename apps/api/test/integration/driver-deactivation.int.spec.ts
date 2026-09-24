import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/** Désactivation d'un conducteur (CDC 3.3, D-131). */
describe('Désactivation d’un conducteur (CDC 3.3 — D-131)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;

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
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a2, number: 'P-A2', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
  });

  const version = async (driverId: string) => (await t.prisma.client.driver.findUniqueOrThrow({ where: { id: driverId } })).version;

  it('refuse avec une utilisation en cours, puis exige l’annulation explicite des réservations futures et clôt l’affectation habituelle', async () => {
    const v1 = await createVehicle(t.prisma, f, 'A', { code: 'DEA-1' });
    const v2 = await createVehicle(t.prisma, f, 'A', { code: 'DEA-2' });
    const usage = await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: v1, driverId: f.drivers.a2, status: 'EN_COURS', purpose: 'Mission', checkedOutAt: new Date('2026-09-24T08:00:00Z'), expectedReturnAt: new Date('2026-09-24T18:00:00Z'), checkedOutById: f.users.chefA } });
    let res = await chefA.post(`/drivers/${f.drivers.a2}/deactivate`, { reason: 'Départ de l’entreprise', expectedVersion: await version(f.drivers.a2) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'UTILISATION_OUVERTE', details: { usageId: usage.id } });
    await t.prisma.client.vehicleUsage.update({ where: { id: usage.id }, data: { status: 'TERMINEE', returnedAt: new Date('2026-09-24T09:00:00Z'), returnWithoutReading: true } });

    const current = await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: v1, driverId: f.drivers.a2, startsAt: new Date('2026-09-01T08:00:00Z'), endsAt: new Date('2026-12-31T18:00:00Z'), createdById: f.users.chefA } });
    const upcoming = await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: v2, driverId: f.drivers.a2, startsAt: new Date('2027-01-01T08:00:00Z'), createdById: f.users.chefA } });
    const reservation = await chefA.post('/reservations', { vehicleId: v2, driverId: f.drivers.a2, startAt: '2026-09-25T08:00:00Z', endAt: '2026-09-25T17:00:00Z', purpose: 'Salon' }).set('Idempotency-Key', randomUUID());
    expect(reservation.status, JSON.stringify(reservation.body)).toBe(201);

    res = await chefA.post(`/drivers/${f.drivers.a2}/deactivate`, { reason: 'Départ de l’entreprise', expectedVersion: await version(f.drivers.a2) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESERVATIONS_FUTURES');
    expect(res.body.details.reservations).toEqual([{ id: reservation.body.id, vehicleCode: 'DEA-2', startAt: '2026-09-25T08:00:00.000Z', endAt: '2026-09-25T17:00:00.000Z' }]);
    expect((await t.prisma.client.reservation.findUniqueOrThrow({ where: { id: reservation.body.id } })).status).toBe('CONFIRMEE');

    res = await chefA.post(`/drivers/${f.drivers.a2}/deactivate`, { reason: 'Départ de l’entreprise', expectedVersion: await version(f.drivers.a2), cancelFutureReservations: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INACTIF');
    expect((await t.prisma.client.reservation.findUniqueOrThrow({ where: { id: reservation.body.id } })).status).toBe('ANNULEE');
    const closed = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: current.id } });
    expect(closed.endsAt?.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(await t.prisma.client.vehicleResponsibleAssignment.count({ where: { id: upcoming.id } })).toBe(0);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'conducteur.desactivation', objectId: f.drivers.a2 } });
    expect(audit.after).toMatchObject({ reservationsAnnulees: 1, affectationsCloturees: 1, affectationsRetirees: 1 });
  });

  it('deux désactivations simultanées : une seule réussit, jamais d’erreur 500', async () => {
    const expectedVersion = await version(f.drivers.a2);
    const results = await Promise.all([
      chefA.post(`/drivers/${f.drivers.a2}/deactivate`, { reason: 'Premier', expectedVersion }),
      chefA.post(`/drivers/${f.drivers.a2}/deactivate`, { reason: 'Second', expectedVersion }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'conducteur.desactivation', objectId: f.drivers.a2 } })).toBe(1);
  });
});
