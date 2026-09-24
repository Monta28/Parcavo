import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Clôture d'intervention (CDC 6.3, 6.4, 13.3, 15.3) : objets hors périmètre de l'intervention refusés
 * (plan, fournisseur, relevé, pièces jointes contrôlées sur la société de l'intervention), alertes des plans
 * réévaluées dans la même transaction, et intervention planifiée sans effet sur les plans ni les dépenses.
 */
describe('Clôture d’intervention : périmètre de la société et transaction unique (CDC 6.3, 6.4, 15.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let chefAB: Agent;
  let vehicleId: string;
  let vehicleB: string;
  let planId: string;
  let readingId: string;

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
    // Chef de parc des sociétés A et B : il voit les deux sociétés, mais une intervention reste d'une seule.
    const hash = (await t.prisma.client.user.findUniqueOrThrow({ where: { id: f.users.chefA }, select: { passwordHash: true } })).passwordHash;
    const email = `chef.ab.${randomUUID().slice(0, 6)}@test.local`;
    await t.prisma.client.user.create({ data: { organizationId: f.organizationId, email, firstName: 'Amel', lastName: 'Chef-AB', passwordHash: hash, memberships: { create: [{ companyId: f.companies.A, role: 'CHEF_PARC' }, { companyId: f.companies.B, role: 'CHEF_PARC' }] } } });
    chefAB = await login(t.server, email, DEFAULT_PASSWORD);

    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A' });
    vehicleB = await createVehicle(t.prisma, f, 'B', { code: 'V-B' });
    const typeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-01-10' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    planId = plan.body.id;
    const r = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '90200', observedAt: '2026-09-24T08:00:00Z' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    readingId = r.body.reading.id;
    expect((await chefA.get(`/maintenance-plans/${planId}`)).body.status).toBe('EN_RETARD');
  });

  async function intervention(agent: Agent, vId: string, extra: Record<string, unknown> = {}) {
    const res = await agent.post('/interventions', { vehicleId: vId, kind: 'PREVENTIF', tasks: vId === vehicleId ? [{ planId }] : [{ label: 'Contrôle' }], ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; reference: string; version: number; status: string; tasks: Array<{ id: string }> };
  }

  function complete(agent: Agent, i: { id: string; version: number; tasks: Array<{ id: string }> }, body: Record<string, unknown>) {
    return agent.post(`/interventions/${i.id}/complete`, { completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version, performedOn: '2026-09-24', acceptedReadingId: readingId, ...body }).set('Idempotency-Key', randomUUID());
  }

  /** Panne injectée au niveau de la base : toute écriture sur les alertes échoue pendant `fn`. */
  async function withAlertWriteFailure<T>(fn: () => Promise<T>): Promise<T> {
    await t.prisma.client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_alert_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'écriture d''alerte refusée (test)'; END $$`);
    await t.prisma.client.$executeRawUnsafe(`CREATE TRIGGER test_alert_write_failure BEFORE INSERT OR UPDATE ON "Alert" FOR EACH ROW EXECUTE FUNCTION test_alert_write_failure()`);
    try {
      return await fn();
    } finally {
      await t.prisma.client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_alert_write_failure ON "Alert"`);
      await t.prisma.client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_alert_write_failure()`);
    }
  }

  async function assertNothingClosed(interventionId: string) {
    const row = await t.prisma.client.intervention.findUniqueOrThrow({ where: { id: interventionId } });
    expect(row.status).not.toBe('TERMINEE');
    expect(row.version).toBe(1);
    expect(await t.prisma.client.expense.count()).toBe(0);
    expect(await t.prisma.client.interventionTask.count({ where: { interventionId, completed: true } })).toBe(0);
    const plan = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.baseKm?.toString()).toBe('80000');
    expect(plan.computedStatus).toBe('EN_RETARD');
  }

  it('R-15.3-08 — fournisseur, ligne de travail, relevé et pièces jointes hors périmètre de l’intervention : 404, rien n’est clôturé', async () => {
    const i = await intervention(chefA, vehicleId);
    const supplierB = await chefB.post('/suppliers', { companyId: f.companies.B, name: 'Garage Nord', category: 'GARAGE' });
    expect(supplierB.status, JSON.stringify(supplierB.body)).toBe(201);
    // Fournisseur d'une autre société, même pour un chef qui voit les deux sociétés.
    expect((await complete(chefAB, i, { supplierId: supplierB.body.id })).status).toBe(404);
    // Ligne de travail d'une autre intervention (autre société).
    const other = await intervention(chefB, vehicleB);
    expect((await complete(chefAB, { ...i, tasks: [...i.tasks, ...other.tasks] }, {})).status).toBe(404);
    // Relevé d'un autre véhicule.
    const rB = await chefB.post(`/vehicles/${vehicleB}/readings`, { physicalKm: '5000', observedAt: '2026-09-24T08:00:00Z' });
    expect((await complete(chefAB, i, { acceptedReadingId: rB.body.reading.id })).status).toBe(404);
    // Pièce jointe téléversée pour la société B : hors périmètre de l'intervention de A, même pour l'administrateur.
    const fileB = await uploadPdf(chefAB, t.server, f.companies.B, 'rapport-b.pdf');
    expect((await complete(chefAB, i, { attachmentIds: [fileB] })).status).toBe(404);
    const adminFileB = await uploadPdf(admin, t.server, f.companies.B, 'rapport-admin-b.pdf');
    expect((await complete(admin, i, { attachmentIds: [adminFileB] })).status).toBe(404);
    // Photo du relevé d'exécution téléversée pour B : refusée aussi, et le relevé n'est pas créé.
    const readingsBefore = await t.prisma.client.odometerReading.count();
    expect((await complete(chefAB, i, { acceptedReadingId: undefined, newReading: { physicalKm: '90250', observedAt: '2026-09-24T09:00:00Z', attachmentId: fileB } })).status).toBe(404);
    expect(await t.prisma.client.odometerReading.count()).toBe(readingsBefore);
    // Pièce d'un autre utilisateur de B, illisible du chef A.
    const chefBFile = await uploadPdf(chefB, t.server, f.companies.B, 'rapport-chef-b.pdf');
    expect((await complete(chefA, i, { attachmentIds: [chefBFile] })).status).toBe(404);
    await assertNothingClosed(i.id);
    for (const id of [fileB, adminFileB, chefBFile]) expect((await t.prisma.client.attachment.findUniqueOrThrow({ where: { id } })).ownerId).toBeNull();

    // Objets de la société de l'intervention : clôture acceptée.
    const fileA = await uploadPdf(chefAB, t.server, f.companies.A, 'rapport-a.pdf');
    const done = await complete(chefAB, i, { attachmentIds: [fileA] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: fileA } })).toMatchObject({ ownerType: 'INTERVENTION', ownerId: i.id, companyId: f.companies.A });

    // Facture du coût saisi après coup : même contrôle sur la société de l'intervention.
    const invoiceB = await uploadPdf(chefAB, t.server, f.companies.B, 'facture-b.pdf');
    const cost = await chefAB.post(`/interventions/${i.id}/cost`, { totalAmount: '120.500', invoiceAttachmentId: invoiceB, expectedVersion: done.body.version });
    expect(cost.status).toBe(404);
    expect(await t.prisma.client.expense.count()).toBe(0);
    const invoiceA = await uploadPdf(chefAB, t.server, f.companies.A, 'facture-a.pdf');
    const costOk = await chefAB.post(`/interventions/${i.id}/cost`, { totalAmount: '120.500', invoiceAttachmentId: invoiceA, expectedVersion: done.body.version });
    expect(costOk.status, JSON.stringify(costOk.body)).toBe(200);
    expect(await t.prisma.client.expense.findFirstOrThrow({ where: { sourceId: i.id } })).toMatchObject({ companyId: f.companies.A, attachmentId: invoiceA });
  });

  it('R-6.3-06 — société historique : après transfert du véhicule, une pièce de la nouvelle société est refusée sur l’intervention de l’ancienne', async () => {
    const i = await intervention(chefA, vehicleId);
    // Le véhicule passe en société B (écriture directe : seule la société historique de l'intervention compte ici).
    await t.prisma.client.vehicle.update({ where: { id: vehicleId }, data: { companyId: f.companies.B } });
    const fileB = await uploadPdf(chefAB, t.server, f.companies.B, 'rapport-nouvelle-societe.pdf');
    const refused = await complete(chefAB, i, { attachmentIds: [fileB] });
    expect(refused.status).toBe(404);
    expect(refused.body.message).toContain('Pièce jointe');
    const row = await t.prisma.client.intervention.findUniqueOrThrow({ where: { id: i.id } });
    expect(row).toMatchObject({ companyId: f.companies.A, status: 'BROUILLON' });
    // Contrôle positif : la même clôture avec une pièce de la société historique est acceptée (seule la pièce était refusée).
    const fileA = await uploadPdf(chefAB, t.server, f.companies.A, 'rapport-societe-historique.pdf');
    const done = await complete(chefAB, i, { attachmentIds: [fileA] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ companyId: f.companies.A, status: 'TERMINEE' });
  });

  it('R-6.4-06 — les alertes des plans sont réévaluées dans la transaction de clôture : un échec d’écriture d’alerte annule toute la clôture', async () => {
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
    expect(alert.severity).toBe('CRITIQUE');
    const i = await intervention(chefA, vehicleId);
    // Panne injectée au niveau de la base : toute écriture sur les alertes échoue.
    const failed = await withAlertWriteFailure(() => complete(chefA, i, { totalAmount: '95.000' }));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // Tout ou rien : intervention, travaux, base du plan, échéance, dépense et alerte inchangés.
    await assertNothingClosed(i.id);
    expect(await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'ACTIVE', version: alert.version });

    const done = await complete(chefA, i, { totalAmount: '95.000' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const closed = await t.prisma.client.intervention.findUniqueOrThrow({ where: { id: i.id } });
    const resolved = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(resolved.status).toBe('RESOLUE');
    expect(resolved.resolvedAt?.toISOString()).toBe(closed.completedAt?.toISOString());
    expect((await chefA.get(`/maintenance-plans/${planId}`)).body).toMatchObject({ baseKm: '90200', nextDueKm: '100200', status: 'A_JOUR' });
    expect(await t.prisma.client.expense.count({ where: { sourceId: i.id, status: 'VALIDEE' } })).toBe(1);
    expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(0);
  });

  it('R-13.3-09 — réouverture : dépense annulée, base recalculée et alerte réactivée dans la même transaction', async () => {
    const i = await intervention(chefA, vehicleId);
    const done = await complete(chefA, i, { totalAmount: '95.000' });
    expect(done.status).toBe(200);
    expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(0);
    // Même transaction : un échec d'écriture d'alerte annule toute la réouverture (statut, dépense, base, coût inchangés).
    const failed = await withAlertWriteFailure(() => chefA.post(`/interventions/${i.id}/reopen`, { reason: 'Relevé d’exécution erroné', expectedVersion: done.body.version }));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await t.prisma.client.intervention.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ status: 'TERMINEE', version: done.body.version, costStatus: 'SAISI' });
    expect(await t.prisma.client.expense.count({ where: { sourceId: i.id, status: 'VALIDEE' } })).toBe(1);
    expect((await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId } })).baseKm?.toString()).toBe('90200');
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'intervention.reouverture', objectId: i.id } })).toBe(0);

    const reopened = await chefA.post(`/interventions/${i.id}/reopen`, { reason: 'Relevé d’exécution erroné', expectedVersion: done.body.version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect((await chefA.get(`/maintenance-plans/${planId}`)).body).toMatchObject({ baseKm: '80000', status: 'EN_RETARD' });
    expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(1);
    expect(await t.prisma.client.expense.count({ where: { sourceId: i.id, status: 'VALIDEE' } })).toBe(0);
  });

  it('R-6.3-03 — planifier, démarrer ou annuler n’exécute rien : bases, échéances, alertes et dépenses inchangées', async () => {
    const snapshot = async () => {
      const p = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId } });
      return { baseKm: p.baseKm?.toString(), baseDate: p.baseDate?.toISOString(), nextDueKm: p.nextDueKm?.toString(), status: p.computedStatus, alerts: await t.prisma.client.alert.count({ where: { objectId: planId, status: 'ACTIVE' } }), expenses: await t.prisma.client.expense.count() };
    };
    const before = await snapshot();
    const planned = await intervention(chefA, vehicleId, { plannedStartAt: '2026-09-25T07:00:00.000Z' });
    expect(planned.status).toBe('PLANIFIEE');
    expect(await snapshot()).toEqual(before);
    const started = await chefA.post(`/interventions/${planned.id}/start`, { expectedVersion: planned.version });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await snapshot()).toEqual(before);
    const cancelled = await chefA.post(`/interventions/${planned.id}/cancel`, { reason: 'Garage indisponible', expectedVersion: started.body.version });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await chefA.get(`/maintenance-plans/${planId}`)).body).toMatchObject({ baseKm: '80000', nextDueKm: '90000', status: 'EN_RETARD' });
  });
});
