import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Paramètres versionnés (CDC 17.1)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;

  beforeAll(async () => {
    t = await startTestApp();
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
  });

  it('expose les valeurs initiales du CDC avec leur origine', async () => {
    const res = await chefA.get('/settings');
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.map((s: { key: string }) => [s.key, s]));
    expect(byKey['odometer.staleAfterDays']).toMatchObject({ value: 7, source: 'defaut' });
    expect(byKey['documents.noticeDays'].value).toEqual([30, 15, 7]);
    expect(byKey['telemetry.silentAfterHours'].value).toBe(24);
    expect(byKey['telemetry.driftThresholdPercent'].value).toBe(3);
    expect(byKey['pagination.maxPageSize'].value).toBe(100);
  });

  it('versionne et audite chaque modification ; surcharge société explicite ; réservé à l’administrateur', async () => {
    expect((await chefA.put('/settings/odometer.staleAfterDays', { value: 10, reason: 'essai' })).status).toBe(403);
    const invalid = await admin.put('/settings/odometer.staleAfterDays', { value: 0, reason: 'valeur hors bornes' });
    expect(invalid.status).toBe(422);
    const v1 = await admin.put('/settings/odometer.staleAfterDays', { value: 10, reason: 'politique groupe' });
    expect(v1.body).toMatchObject({ value: 10, source: 'groupe', settingVersion: 1 });
    const v2 = await admin.put('/settings/odometer.staleAfterDays', { value: 14, reason: 'révision' });
    expect(v2.body.settingVersion).toBe(2);
    const override = await admin.put('/settings/odometer.staleAfterDays', { value: 3, companyId: f.companies.A, reason: 'parc urbain' });
    expect(override.body).toMatchObject({ value: 3, source: 'societe' });
    expect((await admin.put('/settings/session.ttlHours', { value: 8, companyId: f.companies.A, reason: 'x y z' })).status).toBe(422);
    const history = await admin.get('/settings/odometer.staleAfterDays/history');
    expect(history.body).toHaveLength(3);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'parametre.modification' } })).toBe(3);
    // la surcharge société s'applique réellement à la fraîcheur (synthèse véhicule et compteur courant)
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const segment = await t.prisma.client.odometerSegment.create({ data: { organizationId: f.organizationId, vehicleId, sequence: 1, startedAt: new Date('2026-01-01T00:00:00Z'), startPhysicalKm: '0', startCumulativeKm: '0' } });
    await t.prisma.client.odometerReading.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, segmentId: segment.id, source: 'MANUAL', context: 'RELEVE_LIBRE', status: 'ACCEPTE', physicalKm: '1000', cumulativeKm: '1000', observedAt: new Date('2026-09-20T08:00:00Z') } });
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.freshness).toBe('A_ACTUALISER');
    await admin.delete('/settings/odometer.staleAfterDays/override').send({ companyId: f.companies.A, reason: 'retour au groupe' });
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.freshness).toBe('A_JOUR');
  });
});
