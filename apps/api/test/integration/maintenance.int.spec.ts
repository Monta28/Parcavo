import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenancePlansService } from '../../src/modules/maintenance/maintenance-plans.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Plans d’entretien (CDC 6.1, 6.2 — T15, T16)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let vidangeId: string;
  let batterieId: string;

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
    const v = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    expect(v.status).toBe(201);
    vidangeId = v.body.id;
    batterieId = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id;
  });

  async function reading(physicalKm: string, observedAt: string, vehicle = vehicleId) {
    const res = await chefA.post(`/vehicles/${vehicle}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.outcome).toBe('ACCEPTE');
    return res.body;
  }

  async function oilPlan(vehicle = vehicleId) {
    const res = await chefA.post('/maintenance-plans', { vehicleId: vehicle, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-03-01' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; status: string; nextDueKm: string };
  }

  it('le catalogue est réservé à l’administrateur ; codes uniques', async () => {
    expect((await chefA.post('/maintenance-types', { code: 'PNEUS', label: 'Pneus' })).status).toBe(403);
    expect((await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Doublon' })).status).toBe(409);
    const list = await operateurA.get('/maintenance-types');
    expect(list.status).toBe(200);
    expect(list.body.map((x: { code: string }) => x.code)).toEqual(['BATTERIE', 'VIDANGE']);
  });

  it('T15 — base 80 000, intervalle 10 000 : 89 500 A_PREVOIR, 90 000 A_FAIRE, 90 200 EN_RETARD, sans GPS', async () => {
    await reading('85000', '2026-09-01T08:00:00Z');
    const plan = await oilPlan();
    expect(plan.nextDueKm).toBe('90000');
    expect(plan.status).toBe('A_JOUR');

    await reading('89500', '2026-09-20T08:00:00Z');
    let p = (await chefA.get(`/maintenance-plans/${plan.id}`)).body;
    expect(p.status).toBe('A_PREVOIR');
    expect(p.remainingKm).toBe('500');
    let stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(stored.computedStatus).toBe('A_PREVOIR');
    let alerts = await t.prisma.client.alert.findMany({ where: { objectId: plan.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('ATTENTION');

    await reading('90000', '2026-09-22T08:00:00Z');
    p = (await chefA.get(`/maintenance-plans/${plan.id}`)).body;
    expect(p.status).toBe('A_FAIRE');
    stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(stored.computedStatus).toBe('A_FAIRE');

    await reading('90200', '2026-09-23T08:00:00Z');
    p = (await chefA.get(`/maintenance-plans/${plan.id}`)).body;
    expect(p.status).toBe('EN_RETARD');
    expect(p.remainingKm).toBe('-200');
    expect(p.currentKmSource).toBe('COMPTEUR_AFFICHE');
    // Une seule occurrence d'alerte, gravité portée au niveau critique (déduplication 9.2).
    alerts = await t.prisma.client.alert.findMany({ where: { objectId: plan.id, type: 'ENTRETIEN_ECHEANCE' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe('ACTIVE');
    expect(alerts[0]?.severity).toBe('CRITIQUE');
    const urgent = await chefA.get('/maintenance-plans?urgent=true');
    expect(urgent.body.items.map((x: { id: string }) => x.id)).toEqual([plan.id]);
  });

  it('T15 — une saisie qui passe directement de 89 500 à 90 200 déclenche le retard', async () => {
    await reading('89500', '2026-09-20T08:00:00Z');
    const plan = await oilPlan();
    expect(plan.status).toBe('A_PREVOIR');
    await reading('90200', '2026-09-23T08:00:00Z');
    expect((await chefA.get(`/maintenance-plans/${plan.id}`)).body.status).toBe('EN_RETARD');
  });

  it('T16 — date atteinte avant le kilométrage : à faire le jour local de l’échéance, en retard le lendemain', async () => {
    await reading('81000', '2026-09-20T08:00:00Z');
    const res = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2025-09-26' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.nextDueDate).toBe('2026-09-26');
    expect(res.body.noticeDays).toBe(30);
    expect(res.body.noticeKm).toBe('500');
    expect(res.body.status).toBe('A_PREVOIR');
    expect(res.body.kmStatus).toBe('A_JOUR');
    const plans = t.app.get(MaintenancePlansService);

    // 25/09 23:30 UTC = 26/09 00:30 à Tunis : jour de l'échéance.
    t.clock.set('2026-09-25T23:30:00.000Z');
    await plans.recomputeAll(f.organizationId);
    let stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.computedStatus).toBe('A_FAIRE');
    // La session de 12 h a expiré avec l'horloge avancée : nouvelle connexion.
    expect((await chefA.get(`/maintenance-plans/${res.body.id}`)).status).toBe(401);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await chefA.get(`/maintenance-plans/${res.body.id}`)).body.status).toBe('A_FAIRE');

    // 26/09 22:59 UTC = 26/09 23:59 locale : toujours A_FAIRE ; 27/09 00:00 locale : EN_RETARD.
    t.clock.set('2026-09-26T22:59:00.000Z');
    await plans.recomputeAll(f.organizationId);
    stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.computedStatus).toBe('A_FAIRE');
    t.clock.set('2026-09-26T23:00:00.000Z');
    await plans.recomputeAll(f.organizationId);
    stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.computedStatus).toBe('EN_RETARD');
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: res.body.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
    expect(alert.severity).toBe('CRITIQUE');
    // Rattrapage relancé plusieurs fois : une seule alerte active.
    await plans.recomputeAll(f.organizationId);
    await plans.recomputeAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { objectId: res.body.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(1);
  });

  it('plan sans historique fiable : INCOMPLET avec alerte, sans fausse vidange à zéro ; puis échéance initiale', async () => {
    await reading('50000', '2026-09-20T08:00:00Z');
    const res = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('INCOMPLET');
    expect(res.body.nextDueKm).toBeNull();
    expect(res.body.warnings).toContain('AUCUNE_BASE');
    expect(await t.prisma.client.alert.count({ where: { objectId: res.body.id, type: 'ENTRETIEN_PLAN_INCOMPLET', status: 'ACTIVE' } })).toBe(1);
    expect(await t.prisma.client.interventionTask.count()).toBe(0);

    const preview = await chefA.patch(`/maintenance-plans/${res.body.id}`, { base: { baseMode: 'ECHEANCE_INITIALE', nextDueKm: '55000' }, preview: true, reason: 'Initialisation', expectedVersion: 1 });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.nextDueKm).toBe('55000');
    expect(preview.body.before.status).toBe('INCOMPLET');
    // La prévisualisation n'enregistre rien.
    expect((await chefA.get(`/maintenance-plans/${res.body.id}`)).body).toMatchObject({ status: 'INCOMPLET', version: 1 });

    const applied = await chefA.patch(`/maintenance-plans/${res.body.id}`, { base: { baseMode: 'ECHEANCE_INITIALE', nextDueKm: '55000' }, reason: 'Initialisation', expectedVersion: 1 });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: 'A_JOUR', nextDueKm: '55000', version: 2 });
    expect(await t.prisma.client.alert.count({ where: { objectId: res.body.id, type: 'ENTRETIEN_PLAN_INCOMPLET', status: 'ACTIVE' } })).toBe(0);
    // Verrou optimiste.
    expect((await chefA.patch(`/maintenance-plans/${res.body.id}`, { noticeKm: '400', reason: 'Préavis', expectedVersion: 1 })).status).toBe(409);
  });

  it('refuse un plan sans intervalle, un préavis supérieur à l’intervalle et un second plan actif du même type', async () => {
    const none = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, base: { baseMode: 'AUCUNE' } });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('INTERVALLE_REQUIS');
    const notice = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '1000', noticeKm: '1000', base: { baseMode: 'AUCUNE' } });
    expect(notice.status).toBe(422);
    expect(notice.body.code).toBe('PREAVIS_KM_TROP_GRAND');
    const both = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalMonths: 6, intervalDays: 180, base: { baseMode: 'AUCUNE' } });
    expect(both.status).toBe(422);
    const noBase = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'BASE_TECHNIQUE' } });
    expect(noBase.status).toBe(422);
    expect(noBase.body.code).toBe('BASE_KM_REQUISE');
    await oilPlan();
    const dup = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '15000', base: { baseMode: 'AUCUNE' } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PLAN_EXISTANT');
  });

  it('cloisonnement : le chef B ne voit ni ne modifie les plans de A ; l’opérateur ne crée pas de plan', async () => {
    const plan = await oilPlan();
    expect((await chefB.get(`/maintenance-plans/${plan.id}`)).status).toBe(404);
    expect((await chefB.get('/maintenance-plans')).body.total).toBe(0);
    expect((await chefB.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Hors périmètre', expectedVersion: 1 })).status).toBe(404);
    expect((await chefB.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } })).status).toBe(404);
    expect((await operateurA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: batterieId, intervalMonths: 24, base: { baseMode: 'AUCUNE' } })).status).toBe(403);
    expect((await operateurA.get(`/maintenance-plans/${plan.id}`)).status).toBe(200);
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.get(`/maintenance-plans/${plan.id}`)).status).toBe(404);
  });

  it('modèle copié vers plusieurs véhicules : instantané, plans existants ignorés ou mis à jour en gardant la base', async () => {
    const v2 = await createVehicle(t.prisma, f, 'A');
    const existing = await oilPlan();
    const tpl = await admin.post('/maintenance-templates', { name: 'Citadine essence', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000', intervalMonths: 12 }, { maintenanceTypeId: batterieId, intervalMonths: 48 }] });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    expect((await chefA.post('/maintenance-templates', { name: 'Interdit', items: [{ maintenanceTypeId: vidangeId, intervalKm: '1000' }] })).status).toBe(403);

    const ignored = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [vehicleId, v2] });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    const r1 = ignored.body.vehicles.find((x: { vehicleId: string }) => x.vehicleId === vehicleId);
    const r2 = ignored.body.vehicles.find((x: { vehicleId: string }) => x.vehicleId === v2);
    expect(r1).toMatchObject({ created: ['Batterie'], ignored: ['Vidange moteur'], updated: [] });
    expect(r2.created.sort()).toEqual(['Batterie', 'Vidange moteur']);
    // Plan inchangé (intervalle 10 000 conservé).
    expect((await chefA.get(`/maintenance-plans/${existing.id}`)).body.intervalKm).toBe('10000');
    // Nouveau plan sans historique : INCOMPLET, pas d'échéance inventée.
    const created = await chefA.get(`/maintenance-plans?vehicleId=${v2}`);
    expect(created.body.items.every((p: { status: string; templateId: string }) => p.status === 'INCOMPLET' && p.templateId === tpl.body.id)).toBe(true);

    const updated = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [vehicleId], onExisting: 'METTRE_A_JOUR' });
    expect(updated.body.vehicles[0].updated.sort()).toEqual(['Batterie', 'Vidange moteur']);
    const after = (await chefA.get(`/maintenance-plans/${existing.id}`)).body;
    expect(after).toMatchObject({ intervalKm: '15000', intervalMonths: 12, baseKm: '80000', nextDueKm: '95000' });

    // Modifier le modèle ne change pas les plans déjà copiés.
    const t2 = await admin.patch(`/maintenance-templates/${tpl.body.id}`, { items: [{ maintenanceTypeId: vidangeId, intervalKm: '20000' }], expectedVersion: 1 });
    expect(t2.status).toBe(200);
    expect((await chefA.get(`/maintenance-plans/${existing.id}`)).body.intervalKm).toBe('15000');

    // Le chef B ne peut pas appliquer le modèle aux véhicules de A.
    expect((await chefB.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [vehicleId] })).status).toBe(404);
  });

  it('plan limité aux relevés manuels ou CAN (MANUEL_OU_CAN) et désactivation', async () => {
    await reading('89000', '2026-09-20T08:00:00Z');
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, intervalKm: '10000', acceptedSources: 'MANUEL_OU_CAN', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } });
    expect(plan.body).toMatchObject({ status: 'A_JOUR', acceptedSources: 'MANUEL_OU_CAN', baseKm: '80000' });
    await reading('89600', '2026-09-21T08:00:00Z');
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body.status).toBe('A_PREVOIR');
    const deact = await chefA.post(`/maintenance-plans/${plan.body.id}/deactivate`, { reason: 'Véhicule sous contrat constructeur', expectedVersion: 1 });
    expect(deact.status).toBe(200);
    expect(deact.body.active).toBe(false);
    expect(await t.prisma.client.alert.count({ where: { objectId: plan.body.id, status: 'ACTIVE' } })).toBe(0);
    expect((await chefA.get('/maintenance-plans')).body.total).toBe(0);
    expect((await chefA.get('/maintenance-plans?includeInactive=true')).body.total).toBe(1);
    const audit = await t.prisma.client.auditEvent.findMany({ where: { objectId: plan.body.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['plan_entretien.creation', 'plan_entretien.desactivation']);
  });
});
