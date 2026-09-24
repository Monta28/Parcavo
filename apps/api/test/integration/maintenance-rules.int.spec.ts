import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Règles de plan complémentaires (CDC 5.5, 6.1, 6.2) : contrainte en base « au moins un intervalle »,
 * intervalle en jours, cumul incomplet et relevé ancien affichés à part du statut d'échéance.
 */
describe('Plans d’entretien : intervalle requis en base, jours, données manquantes ou anciennes (CDC 5.5, 6.1, 6.2)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let typeId: string;

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
    typeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id;
  });

  it('R-6.1-04 — la contrainte CHECK plan_has_interval refuse en base un plan sans aucun intervalle (création et modification directes)', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    // Refus serveur d'abord (422), avant toute écriture.
    const api = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, base: { baseMode: 'AUCUNE' } });
    expect(api.status).toBe(422);
    expect(api.body.code).toBe('INTERVALLE_REQUIS');
    // Écriture qui contournerait le service : la base refuse.
    await expect(
      t.prisma.client.$executeRaw`INSERT INTO "VehicleMaintenancePlan" ("id", "organizationId", "companyId", "vehicleId", "maintenanceTypeId", "baseMode", "updatedAt") VALUES (${randomUUID()}::uuid, ${f.organizationId}::uuid, ${f.companies.A}::uuid, ${vehicleId}::uuid, ${typeId}::uuid, 'AUCUNE', now())`,
    ).rejects.toThrow(/plan_has_interval/);
    const ok = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await expect(t.prisma.client.$executeRaw`UPDATE "VehicleMaintenancePlan" SET "intervalKm" = NULL WHERE "id" = ${ok.body.id}::uuid`).rejects.toThrow(/plan_has_interval/);
    expect((await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: ok.body.id } })).intervalKm?.toString()).toBe('10000');
    expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(1);
  });

  it('R-6.2-02 — intervalle en jours : base + 90 jours, puis date effective de la dernière opération + 90 jours', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalDays: 90, noticeDays: 10, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-07-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body).toMatchObject({ intervalDays: 90, intervalMonths: null, nextDueDate: '2026-09-29', status: 'A_PREVOIR', remainingDays: 5, nextDueKm: null });
    // Plan calendaire : aucun relevé exigé à la clôture.
    const i = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId: plan.body.id }] });
    const done = await chefA.post(`/interventions/${i.body.id}/complete`, { completedTaskIds: i.body.tasks.map((x: { id: string }) => x.id), performedOn: '2026-09-20', expectedVersion: i.body.version }).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ baseDate: '2026-09-20', nextDueDate: '2026-12-19', status: 'A_JOUR', remainingDays: 86 });
    // Mois et jours ensemble : refusé.
    const current = (await chefA.get(`/maintenance-plans/${plan.body.id}`)).body;
    const both = await chefA.patch(`/maintenance-plans/${plan.body.id}`, { intervalMonths: 3, reason: 'Consigne trimestrielle', expectedVersion: current.version });
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('INTERVALLE_TEMPS');
  });

  it('R-6.2-10 — cumul incomplet : statut calculé sur le cumul connu, avertissement CUMUL_INCOMPLET affiché à part (fiche et liste)', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const segment = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-20T08:00:00Z', physicalKm: '85000', cumulativeKnown: false, reason: 'Véhicule d’occasion, historique inconnu' });
    expect(segment.status, JSON.stringify(segment.body)).toBe(201);
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const view = (await chefA.get(`/maintenance-plans/${plan.body.id}`)).body;
    expect(view).toMatchObject({ status: 'A_JOUR', currentKm: '85000', remainingKm: '5000' });
    expect(view.warnings).toEqual(['CUMUL_INCOMPLET']);
    const row = (await chefA.get(`/maintenance-plans?vehicleId=${vehicleId}`)).body.items[0];
    expect(row).toMatchObject({ status: 'A_JOUR', warnings: ['CUMUL_INCOMPLET'] });
  });

  it('R-5.5-06 — relevé ancien (T12) : un plan non atteint selon un relevé de plus de sept jours porte KILOMETRAGE_ANCIEN, levé au relevé suivant', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-09-10T08:00:00Z' })).status).toBe(201);
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } });
    const view = (await chefA.get(`/maintenance-plans/${plan.body.id}`)).body;
    // Le statut d'échéance reste celui du dernier cumul connu ; l'ancienneté est signalée séparément.
    expect(view).toMatchObject({ status: 'A_JOUR', currentKm: '85000', currentKmObservedAt: '2026-09-10T08:00:00.000Z' });
    expect(view.warnings).toEqual(['KILOMETRAGE_ANCIEN']);
    // Même règle de fraîcheur que la fiche compteur du véhicule (5.5).
    const odometer = (await chefA.get(`/vehicles/${vehicleId}/odometer`)).body;
    expect(JSON.stringify(odometer)).toContain('A_ACTUALISER');
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85400', observedAt: '2026-09-24T08:00:00Z' })).status).toBe(201);
    const refreshed = (await chefA.get(`/maintenance-plans/${plan.body.id}`)).body;
    expect(refreshed).toMatchObject({ status: 'A_JOUR', currentKm: '85400', warnings: [] });
  });
});
