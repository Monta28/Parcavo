import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Mode de la base retenue exposé par la fiche d'un plan (CDC 6.2, 6.4) : une opération réalisée prend le
 * relais de la base déclarée. Un plan créé « sans base » (copie de modèle sans historique) ne doit plus être
 * présenté « Aucune base (plan incomplet) » une fois l'entretien clôturé, ni une base technique après une
 * opération plus récente ; la réouverture de l'intervention rétablit la base déclarée.
 */
describe('Plans d’entretien : mode de la base retenue (6.2, 6.4)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
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
    vehicleId = await createVehicle(t.prisma, f, 'A');
  });

  it('plan sans base puis vidange clôturée : base « dernière opération » ; réouverture : de nouveau sans base', async () => {
    const oilType = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const batteryType = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id as string;
    const oil = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: oilType, intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'AUCUNE' } });
    const battery = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: batteryType, intervalMonths: 48, base: { baseMode: 'BASE_TECHNIQUE', baseDate: '2026-01-10' } });
    expect(oil.status, JSON.stringify(oil.body)).toBe(201);
    expect(battery.status, JSON.stringify(battery.body)).toBe(201);
    expect(oil.body).toMatchObject({ baseMode: 'AUCUNE', baseKm: null, baseDate: null, status: 'INCOMPLET' });
    expect(battery.body).toMatchObject({ baseMode: 'BASE_TECHNIQUE', baseDate: '2026-01-10' });

    const reading = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '90300', observedAt: '2026-09-23T09:00:00Z' });
    expect(reading.status, JSON.stringify(reading.body)).toBe(201);
    const created = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId: oil.body.id }, { planId: battery.body.id }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const oilTask = (created.body.tasks as Array<{ id: string; planId: string }>).find((task) => task.planId === oil.body.id) as { id: string };
    // Seule la vidange est réalisée : la batterie garde sa base technique déclarée.
    const done = await chefA
      .post(`/interventions/${created.body.id}/complete`, { performedOn: '2026-09-23', acceptedReadingId: reading.body.reading.id, completedTaskIds: [oilTask.id], noCost: true, expectedVersion: created.body.version })
      .set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const oilAfter = (await chefA.get(`/maintenance-plans/${oil.body.id}`)).body;
    expect(oilAfter).toMatchObject({ baseMode: 'DERNIERE_OPERATION', baseKm: '90300', baseDate: '2026-09-23', nextDueKm: '100300', nextDueDate: '2027-09-23', status: 'A_JOUR' });
    expect((await chefA.get(`/maintenance-plans/${battery.body.id}`)).body).toMatchObject({ baseMode: 'BASE_TECHNIQUE', baseDate: '2026-01-10' });
    // La liste expose la même valeur que la fiche.
    const listed = (await chefA.get(`/maintenance-plans?vehicleId=${vehicleId}`)).body.items as Array<{ id: string; baseMode: string }>;
    expect(listed.find((p) => p.id === oil.body.id)?.baseMode).toBe('DERNIERE_OPERATION');

    // Réouverture : la base est recalculée sans l'intervention, le plan redevient sans base et incomplet.
    const reopened = await chefA.post(`/interventions/${created.body.id}/reopen`, { reason: 'Clôture saisie sur le mauvais véhicule', expectedVersion: done.body.version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect((await chefA.get(`/maintenance-plans/${oil.body.id}`)).body).toMatchObject({ baseMode: 'AUCUNE', baseKm: null, baseDate: null, nextDueKm: null, status: 'INCOMPLET' });
  });

  it('base technique déclarée puis opération plus récente : la base retenue devient la dernière opération', async () => {
    const oilType = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: oilType, intervalKm: '10000', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body).toMatchObject({ baseMode: 'BASE_TECHNIQUE', baseKm: '80000', nextDueKm: '90000' });

    const reading = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '89800', observedAt: '2026-09-22T09:00:00Z' });
    expect(reading.status, JSON.stringify(reading.body)).toBe(201);
    const created = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId: plan.body.id }] });
    const done = await chefA
      .post(`/interventions/${created.body.id}/complete`, { performedOn: '2026-09-22', acceptedReadingId: reading.body.reading.id, completedTaskIds: [created.body.tasks[0].id], noCost: true, expectedVersion: created.body.version })
      .set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ baseMode: 'DERNIERE_OPERATION', baseKm: '89800', nextDueKm: '99800' });
  });
});
