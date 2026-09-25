import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenancePlansService } from '../../src/modules/maintenance/maintenance-plans.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type TestApp } from '../support/test-app.js';

/** 23:30 UTC : déjà le 25/09 à Tunis (UTC+1), encore le 24/09 à São Paulo (UTC−3). */
const LATE = '2026-09-24T23:30:00.000Z';

/**
 * Fuseau de référence du groupe (CDC 9.3, 17.1) : Africa/Tunis par défaut, modifiable par l'administrateur
 * (validé, versionné, audité) ; il détermine le jour local des échéances et la date des dépenses de synthèse.
 */
describe('Fuseau du groupe : Africa/Tunis par défaut, configurable, jour local des échéances (CDC 9.3)', () => {
  let t: TestApp;
  let f: Fixture;

  beforeAll(async () => {
    t = await startTestApp({ now: LATE });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(LATE);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
  });

  it('modification réservée à l’administrateur, fuseau inconnu refusé (422 FUSEAU_INVALIDE), version contrôlée, audit ; la session expose le nouveau fuseau', async () => {
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const org = await admin.get('/organization');
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ timezone: 'Africa/Tunis', currency: 'TND', currencyDecimals: 3 });
    const version = org.body.version as number;

    expect((await chefA.patch('/organization', { timezone: 'Europe/Paris', expectedVersion: version })).status).toBe(403);
    for (const timezone of ['Mars/Olympus', 'UTC+1', 'Tunis']) {
      const invalid = await admin.patch('/organization', { timezone, expectedVersion: version });
      expect(invalid.status, timezone).toBe(422);
      expect(invalid.body).toMatchObject({ code: 'FUSEAU_INVALIDE', fieldErrors: { timezone: ['Fuseau horaire inconnu.'] } });
    }
    const stale = await admin.patch('/organization', { timezone: 'America/Sao_Paulo', expectedVersion: version + 5 });
    expect(stale.status).toBe(409);
    expect((await t.prisma.client.organization.findUniqueOrThrow({ where: { id: f.organizationId } })).timezone).toBe('Africa/Tunis');

    const updated = await admin.patch('/organization', { timezone: 'America/Sao_Paulo', expectedVersion: version });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ timezone: 'America/Sao_Paulo', version: version + 1 });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'organisation.modification', objectId: f.organizationId } });
    expect(audit.before).toMatchObject({ timezone: 'Africa/Tunis' });
    expect(audit.after).toMatchObject({ timezone: 'America/Sao_Paulo' });
    // Le web formate les dates avec le fuseau fourni par la session.
    expect((await chefA.get('/auth/session')).body.timezone).toBe('America/Sao_Paulo');
  });

  it('le fuseau du groupe détermine le jour local des échéances d’entretien et la date des dépenses de synthèse', async () => {
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const v1 = await createVehicle(t.prisma, f, 'A', { code: 'TZ-01' });
    const v2 = await createVehicle(t.prisma, f, 'A', { code: 'TZ-02' });
    for (const v of [v1, v2]) expect((await chefA.patch(`/vehicles/${v}`, { energy: 'DIESEL', expectedVersion: 1 })).status).toBe(200);
    const typeId = (await admin.post('/maintenance-types', { code: 'CONTROLE', label: 'Contrôle semestriel' })).body.id as string;
    // Échéance au 24/09/2026 (base 24/03/2026 + 6 mois).
    const plan = await chefA.post('/maintenance-plans', { vehicleId: v1, maintenanceTypeId: typeId, intervalMonths: 6, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-03-24' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body.nextDueDate).toBe('2026-09-24');

    // Africa/Tunis : il est déjà le 25/09 → échéance dépassée ; le plein de 00:10 locale date du 25/09.
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body.status).toBe('EN_RETARD');
    const fuelTunis = await chefA.post('/fuel-entries', { vehicleId: v1, filledAt: '2026-09-24T23:10:00Z', liters: '40', unitPrice: '2.525', totalAmount: '101.000', isFullTank: true }).set('Idempotency-Key', randomUUID());
    expect(fuelTunis.status, JSON.stringify(fuelTunis.body)).toBe(201);
    expect((await chefA.get(`/expenses/${fuelTunis.body.expenseId}`)).body.occurredOn).toBe('2026-09-25');

    // Changement de fuseau : São Paulo, il est encore le 24/09 à 20:30.
    const version = (await admin.get('/organization')).body.version as number;
    expect((await admin.patch('/organization', { timezone: 'America/Sao_Paulo', expectedVersion: version })).status).toBe(200);
    await t.app.get(MaintenancePlansService).recomputeAll(f.organizationId);
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body.status).toBe('A_FAIRE');
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: plan.body.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
    expect(alert.severity).not.toBe('CRITIQUE');
    // Texte de l'alerte : date civile affichée en français, jamais au format ISO.
    expect(alert.message).toContain('échéance 24/09/2026 —');
    expect(alert.message).not.toContain('2026-09-24');
    const fuelSaoPaulo = await chefA.post('/fuel-entries', { vehicleId: v2, filledAt: '2026-09-24T23:10:00Z', liters: '40', unitPrice: '2.525', totalAmount: '101.000', isFullTank: true }).set('Idempotency-Key', randomUUID());
    expect(fuelSaoPaulo.status, JSON.stringify(fuelSaoPaulo.body)).toBe(201);
    expect((await chefA.get(`/expenses/${fuelSaoPaulo.body.expenseId}`)).body.occurredOn).toBe('2026-09-24');
    // Les dépenses déjà enregistrées gardent leur date (aucune réécriture rétroactive).
    expect((await chefA.get(`/expenses/${fuelTunis.body.expenseId}`)).body.occurredOn).toBe('2026-09-25');
  });
});
