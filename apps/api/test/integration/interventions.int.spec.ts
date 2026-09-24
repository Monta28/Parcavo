import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Interventions et clôture ciblée (CDC 6.3, 6.4, 15.3 — T17, T18, T24)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let vidange: { typeId: string; planId: string };
  let batterie: { typeId: string; planId: string };

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
    vehicleId = await createVehicle(t.prisma, f, 'A');
    const vType = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const bType = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id as string;
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-06-01T08:00:00Z' })).status).toBe(201);
    const vPlan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vType, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-01-10' } });
    const bPlan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: bType, intervalMonths: 48, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2023-01-15' } });
    expect(vPlan.status).toBe(201);
    expect(bPlan.status).toBe(201);
    vidange = { typeId: vType, planId: vPlan.body.id };
    batterie = { typeId: bType, planId: bPlan.body.id };
  });

  async function reading(physicalKm: string, observedAt: string): Promise<string> {
    const res = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.reading.id as string;
  }

  async function intervention(tasks: Array<Record<string, string>>, extra: Record<string, unknown> = {}) {
    const res = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; reference: string; version: number; tasks: Array<{ id: string; planId: string | null }> };
  }

  function complete(agent: Agent, i: { id: string; version: number; tasks: Array<{ id: string }> }, body: Record<string, unknown>, key = randomUUID()) {
    return agent.post(`/interventions/${i.id}/complete`, { completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version, ...body }).set('Idempotency-Key', key);
  }

  it('attribue une référence INT-AAAA-NNNNNN séquentielle et refuse un plan d’un autre véhicule', async () => {
    const a = await intervention([{ planId: vidange.planId }]);
    const b = await intervention([{ label: 'Diagnostic bruit moteur' }], { kind: 'CORRECTIF' });
    expect(a.reference).toBe('INT-2026-000001');
    expect(b.reference).toBe('INT-2026-000002');
    const other = await createVehicle(t.prisma, f, 'A');
    const res = await chefA.post('/interventions', { vehicleId: other, kind: 'PREVENTIF', tasks: [{ planId: vidange.planId }] });
    expect(res.status).toBe(404);
  });

  it('T17 — une batterie terminée n’a aucun effet sur la vidange ; vidange à 90 300 → suivante à 100 300', async () => {
    await reading('89800', '2026-09-20T08:00:00Z');
    const bat = await intervention([{ planId: batterie.planId }]);
    const batDone = await complete(chefA, bat, { performedOn: '2026-09-20' });
    expect(batDone.status, JSON.stringify(batDone.body)).toBe(200);
    expect(batDone.body.status).toBe('TERMINEE');
    const vAfterBattery = (await chefA.get(`/maintenance-plans/${vidange.planId}`)).body;
    expect(vAfterBattery).toMatchObject({ nextDueKm: '90000', baseKm: '80000', status: 'A_PREVOIR' });
    const bAfter = (await chefA.get(`/maintenance-plans/${batterie.planId}`)).body;
    expect(bAfter).toMatchObject({ baseDate: '2026-09-20', nextDueDate: '2030-09-20', status: 'A_JOUR' });

    const readingId = await reading('90300', '2026-09-23T09:00:00Z');
    const oil = await intervention([{ planId: vidange.planId }]);
    const oilDone = await complete(chefA, oil, { performedOn: '2026-09-23', acceptedReadingId: readingId });
    expect(oilDone.status, JSON.stringify(oilDone.body)).toBe(200);
    expect(oilDone.body.performedKm).toBe('90300');
    const vAfter = (await chefA.get(`/maintenance-plans/${vidange.planId}`)).body;
    expect(vAfter).toMatchObject({ baseKm: '90300', nextDueKm: '100300', status: 'A_JOUR' });
    // L'alerte d'échéance précédente est résolue par l'entretien effectué (9.2).
    expect(await t.prisma.client.alert.count({ where: { objectId: vidange.planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(0);
    // La batterie n'a pas bougé.
    expect((await chefA.get(`/maintenance-plans/${batterie.planId}`)).body.baseDate).toBe('2026-09-20');
  });

  it('T18 — une vidange antérieure ajoutée après coup ne fait pas régresser la base courante', async () => {
    const r1 = await reading('90300', '2026-09-23T09:00:00Z');
    const recent = await intervention([{ planId: vidange.planId }]);
    expect((await complete(chefA, recent, { performedOn: '2026-09-23', acceptedReadingId: r1 })).status).toBe(200);
    const old = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '86000', observedAt: '2026-07-01T08:00:00Z' });
    expect(old.body.outcome).toBe('ACCEPTE');
    const past = await intervention([{ planId: vidange.planId }], { isHistorical: true });
    const pastDone = await complete(chefA, past, { performedOn: '2026-07-01', acceptedReadingId: old.body.reading.id });
    expect(pastDone.status, JSON.stringify(pastDone.body)).toBe(200);
    const plan = (await chefA.get(`/maintenance-plans/${vidange.planId}`)).body;
    expect(plan).toMatchObject({ baseKm: '90300', baseDate: '2026-09-23', nextDueKm: '100300' });
  });

  it('exige un relevé validé, physique et à la date effective pour un plan en km ; refuse une date future', async () => {
    const i = await intervention([{ planId: vidange.planId }]);
    const none = await complete(chefA, i, { performedOn: '2026-09-23' });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('RELEVE_REQUIS');
    const far = await reading('89000', '2026-09-10T08:00:00Z');
    const wrongDay = await complete(chefA, i, { performedOn: '2026-09-23', acceptedReadingId: far });
    expect(wrongDay.body.code).toBe('RELEVE_NON_CORRESPONDANT');
    const future = await complete(chefA, i, { performedOn: '2026-09-25', newReading: { physicalKm: '90100', observedAt: '2026-09-24T09:00:00Z' } });
    expect(future.body.code).toBe('DATE_FUTURE');
    // Relevé créé dans la même transaction (contexte ENTRETIEN).
    const ok = await complete(chefA, i, { performedOn: '2026-09-24', newReading: { physicalKm: '90100', observedAt: '2026-09-24T09:00:00Z' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const created = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: ok.body.performedReadingId } });
    expect(created).toMatchObject({ context: 'ENTRETIEN', status: 'ACCEPTE' });
    expect((await chefA.get(`/maintenance-plans/${vidange.planId}`)).body.nextDueKm).toBe('100100');
  });

  it('un relevé d’exécution qui passerait en attente fait échouer toute la clôture (aucune clôture partielle)', async () => {
    await reading('89000', '2026-09-20T08:00:00Z');
    const i = await intervention([{ planId: vidange.planId }]);
    const res = await complete(chefA, i, { performedOn: '2026-09-24', newReading: { physicalKm: '80000', observedAt: '2026-09-24T09:00:00Z' } });
    expect(res.status).toBe(422);
    const fresh = (await chefA.get(`/interventions/${i.id}`)).body;
    expect(fresh.status).toBe('BROUILLON');
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, context: 'ENTRETIEN' } })).toBe(0);
  });

  it('T24 — clôture rejouée : même clé → même résultat ; autre clé → 409 ; une seule dépense', async () => {
    const r = await reading('90300', '2026-09-23T09:00:00Z');
    const i = await intervention([{ planId: vidange.planId }]);
    const key = randomUUID();
    const body = { performedOn: '2026-09-23', acceptedReadingId: r, lines: [{ kind: 'PIECE', label: 'Huile 5W30', quantity: '4.5', unitPrice: '32.500' }, { kind: 'MAIN_OEUVRE', label: 'Main-d’œuvre', quantity: '1', unitPrice: '45' }] };
    const [a, b] = await Promise.all([complete(chefA, i, body, key), complete(chefA, i, body, key)]);
    const statuses = [a.status, b.status].sort();
    // Deux envois simultanés de la même clé : un succès, l'autre rejoué ou « en cours » (409).
    expect(statuses[0]).toBe(200);
    const again = await complete(chefA, i, body, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(i.id);
    expect(again.body.totalAmount).toBe('191.250');
    const other = await complete(chefA, i, body);
    expect(other.status).toBe(409);
    expect(await t.prisma.client.expense.count({ where: { sourceType: 'INTERVENTION', sourceId: i.id } })).toBe(1);
    const expense = await t.prisma.client.expense.findFirstOrThrow({ where: { sourceId: i.id } });
    expect(expense).toMatchObject({ category: 'ENTRETIEN_REPARATION', status: 'VALIDEE', companyId: f.companies.A });
    expect(expense.amount.toFixed(3)).toBe('191.250');
    expect(expense.occurredOn.toISOString().slice(0, 10)).toBe('2026-09-23');
  });

  it('clôture sans montant : coût « à saisir », puis saisie ultérieure créant l’unique dépense ; réouverture motivée', async () => {
    const r = await reading('90300', '2026-09-23T09:00:00Z');
    const i = await intervention([{ planId: vidange.planId }]);
    const done = await complete(chefA, i, { performedOn: '2026-09-23', acceptedReadingId: r });
    expect(done.body.costStatus).toBe('A_SAISIR');
    expect(await t.prisma.client.expense.count()).toBe(0);
    expect((await operateurA.post(`/interventions/${i.id}/cost`, { totalAmount: '150', expectedVersion: done.body.version })).status).toBe(200);
    const withCost = (await chefA.get(`/interventions/${i.id}`)).body;
    expect(withCost).toMatchObject({ costStatus: 'SAISI', totalAmount: '150.000' });
    expect((await chefA.post(`/interventions/${i.id}/cost`, { totalAmount: '10', expectedVersion: withCost.version })).body.code).toBe('COUT_DEJA_SAISI');

    // Réouverture : réservée au chef (l'opérateur n'a pas le rôle), motivée, dépense annulée, base recalculée.
    expect((await operateurA.post(`/interventions/${i.id}/reopen`, { reason: 'Erreur de saisie', expectedVersion: withCost.version })).status).toBe(403);
    const reopened = await chefA.post(`/interventions/${i.id}/reopen`, { reason: 'Mauvais véhicule saisi', expectedVersion: withCost.version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'EN_COURS', costStatus: 'A_SAISIR', reopenReason: 'Mauvais véhicule saisi' });
    const expense = await t.prisma.client.expense.findFirstOrThrow({ where: { sourceId: i.id } });
    expect(expense.status).toBe('ANNULEE');
    expect((await chefA.get(`/maintenance-plans/${vidange.planId}`)).body).toMatchObject({ baseKm: '80000', nextDueKm: '90000' });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'intervention.reouverture', objectId: i.id } });
    expect(audit.reason).toBe('Mauvais véhicule saisi');
  });

  it('démarrage avec immobilisation explicite ; la clôture met fin à la cause et rétablit la disponibilité', async () => {
    const r = await reading('90300', '2026-09-24T08:00:00Z');
    const i = await intervention([{ planId: vidange.planId }]);
    const started = await chefA.post(`/interventions/${i.id}/start`, { immobilize: true, immobilizationReason: 'Vidange au garage', expectedVersion: i.version });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.openImmobilizationCauseId).toBeTruthy();
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('IMMOBILISE');
    const done = await complete(chefA, started.body, { performedOn: '2026-09-24', acceptedReadingId: r });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.openImmobilizationCauseId).toBeNull();
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('DISPONIBLE');
    const immo = await t.prisma.client.immobilization.findFirstOrThrow({ where: { vehicleId } });
    expect(immo.status).toBe('TERMINEE');
  });

  it('annulation motivée ; permissions et cloisonnement', async () => {
    const i = await intervention([{ label: 'Contrôle freins' }], { kind: 'CORRECTIF' });
    expect((await chefB.get(`/interventions/${i.id}`)).status).toBe(404);
    expect((await chefB.get('/interventions')).body.total).toBe(0);
    // L'opérateur crée mais ne clôture pas sans maintenance.complete.
    expect((await complete(operateurA, i, { performedOn: '2026-09-24' })).status).toBe(403);
    const cancelled = await chefA.post(`/interventions/${i.id}/cancel`, { reason: 'Doublon', expectedVersion: i.version });
    expect(cancelled.body).toMatchObject({ status: 'ANNULEE', cancelReason: 'Doublon' });
    expect((await complete(chefA, cancelled.body, { performedOn: '2026-09-24' })).status).toBe(409);
    const lecteur = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    const seen = await lecteur.get(`/interventions/${i.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.lines).toEqual([]);
  });
});
