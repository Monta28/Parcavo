import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/** Nombre d'instructions SQL envoyées à PostgreSQL pendant `work` (tous clients du pool). */
async function countSql<T>(work: () => Promise<T>): Promise<{ result: T; count: number }> {
  const original = pg.Client.prototype.query;
  let count = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    count += 1;
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    const result = await work();
    return { result, count };
  } finally {
    pg.Client.prototype.query = original;
  }
}

interface PlanItem {
  id: string;
  vehicleId: string;
  vehicleCode: string;
  maintenanceTypeLabel: string;
  status: string;
  remainingKm: string | null;
  remainingDays: number | null;
  nextDueKm: string | null;
  nextDueDate: string | null;
  currentKm: string | null;
  baseKm: string | null;
}

describe('Liste des plans d’entretien : statut unique, chargement en lot, tri et recherche (CDC 6.2, 10.1, 13.1)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let vidangeId: string;
  let batterieId: string;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-25T20:00:00.000Z' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set('2026-09-25T20:00:00.000Z');
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    vidangeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id;
    batterieId = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id;
  });

  async function reading(vehicleId: string, physicalKm: string, observedAt = '2026-09-25T08:00:00Z') {
    const res = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function plan(body: Record<string, unknown>): Promise<PlanItem> {
    const res = await chefA.post('/maintenance-plans', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PlanItem;
  }

  async function list(query: string): Promise<{ items: PlanItem[]; total: number }> {
    const res = await chefA.get(`/maintenance-plans${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { items: PlanItem[]; total: number };
  }

  it('statut filtré = statut affiché : l’échéance en date passe A_FAIRE au jour local sans événement, filtre et alerte suivent', async () => {
    const v = await createVehicle(t.prisma, f, 'A');
    // Échéance le 26/09 (préavis 30 j) : A_PREVOIR le 25/09 local.
    const p = await plan({ vehicleId: v, maintenanceTypeId: vidangeId, intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2025-09-26' } });
    expect(p).toMatchObject({ status: 'A_PREVOIR', nextDueDate: '2026-09-26', remainingDays: 1 });
    expect((await list('?status=A_PREVOIR')).items.map((x) => x.id)).toEqual([p.id]);

    // 25/09 23:30 UTC = 26/09 00:30 à Tunis : jour de l'échéance, aucun rattrapage ni relevé entre-temps.
    t.clock.set('2026-09-25T23:30:00.000Z');
    const due = await list('?status=A_FAIRE');
    expect(due.items.map((x) => x.id)).toEqual([p.id]);
    expect(due.items[0]).toMatchObject({ status: 'A_FAIRE', remainingDays: 0 });
    expect((await list('?status=A_PREVOIR')).total).toBe(0);
    expect((await list('?urgent=true')).items.map((x) => x.status)).toEqual(['A_FAIRE']);
    const stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.computedStatus).toBe('A_FAIRE');
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: p.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
    expect(alert.severity).toBe('URGENT');
    // Fiche du plan : même valeur que la liste.
    expect((await chefA.get(`/maintenance-plans/${p.id}`)).body.status).toBe('A_FAIRE');

    // Lendemain local : EN_RETARD, la fiche seule suffit à rafraîchir la valeur matérialisée.
    t.clock.set('2026-09-26T23:00:00.000Z');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await chefA.get(`/maintenance-plans/${p.id}`)).body.status).toBe('EN_RETARD');
    expect((await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: p.id } })).computedStatus).toBe('EN_RETARD');
    expect((await list('?status=EN_RETARD')).items.map((x) => x.id)).toEqual([p.id]);
  });

  it('modification au changement de jour : l’état « avant » (prévisualisation, audit) porte le statut du jour local, comme la liste', async () => {
    const v = await createVehicle(t.prisma, f, 'A');
    const p = await plan({ vehicleId: v, maintenanceTypeId: vidangeId, intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2025-09-26' } });
    expect(p.status).toBe('A_PREVOIR');
    // 26/09 local (jour de l'échéance) : aucune lecture, aucun rattrapage depuis la veille.
    t.clock.set('2026-09-25T23:30:00.000Z');
    const preview = await chefA.patch(`/maintenance-plans/${p.id}`, { noticeDays: 10, reason: 'Préavis réduit', expectedVersion: 1, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.before.status).toBe('A_FAIRE');
    expect(preview.body).toMatchObject({ preview: true, status: 'A_FAIRE', version: 1 });
    const saved = await chefA.patch(`/maintenance-plans/${p.id}`, { noticeDays: 10, reason: 'Préavis réduit', expectedVersion: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ status: 'A_FAIRE', version: 2 });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { objectId: p.id, action: 'plan_entretien.modification' } });
    expect(audit.before).toMatchObject({ status: 'A_FAIRE' });
    expect((await list('?status=A_FAIRE')).items.map((x) => x.id)).toEqual([p.id]);
  });

  it('lectures concurrentes au changement de jour : un seul recalcul, une seule alerte, réponses identiques', async () => {
    const vehicles = await Promise.all([createVehicle(t.prisma, f, 'A'), createVehicle(t.prisma, f, 'A'), createVehicle(t.prisma, f, 'A')]);
    for (const v of vehicles) await plan({ vehicleId: v, maintenanceTypeId: vidangeId, intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2025-09-26' } });
    t.clock.set('2026-09-25T23:30:00.000Z');
    const responses = await Promise.all([chefA.get('/maintenance-plans?status=A_FAIRE'), chefA.get('/maintenance-plans?urgent=true'), admin.get('/maintenance-plans?status=A_FAIRE'), chefA.get('/maintenance-plans')]);
    for (const r of responses) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(responses.map((r) => r.body.total)).toEqual([3, 3, 3, 3]);
    expect(responses[3]?.body.items.every((x: PlanItem) => x.status === 'A_FAIRE')).toBe(true);
    expect(await t.prisma.client.alert.count({ where: { type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE', severity: 'URGENT' } })).toBe(3);
    expect(await t.prisma.client.alert.count({ where: { type: 'ENTRETIEN_ECHEANCE' } })).toBe(3);
  });

  it('pageSize=100 : données d’évaluation chargées en lot (nombre de requêtes SQL borné, indépendant du nombre de plans)', async () => {
    const typeIds: string[] = [];
    for (const code of ['T1', 'T2', 'T3', 'T4', 'T5']) typeIds.push((await admin.post('/maintenance-types', { code, label: `Opération ${code}` })).body.id);
    const tpl = await admin.post('/maintenance-templates', { name: 'Cinq opérations', items: typeIds.map((id) => ({ maintenanceTypeId: id, intervalKm: '10000', intervalMonths: 12 })) });
    expect(tpl.status).toBe(201);
    const vehicleIds: string[] = [];
    for (let i = 0; i < 20; i += 1) vehicleIds.push(await createVehicle(t.prisma, f, 'A'));
    expect((await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds })).status).toBe(200);
    for (const v of vehicleIds.slice(0, 10)) await reading(v, '50000');
    const small = await countSql(() => chefA.get('/maintenance-plans?pageSize=5'));
    const large = await countSql(() => chefA.get('/maintenance-plans?pageSize=100'));
    expect(large.result.status).toBe(200);
    expect(large.result.body.items).toHaveLength(100);
    expect(large.result.body.total).toBe(100);
    // Avant correction : 609 instructions pour 100 plans (6 par plan). Après : constant.
    expect(large.count).toBeLessThanOrEqual(20);
    expect(large.count).toBe(small.count);
    const urgency = await countSql(() => chefA.get('/maintenance-plans?pageSize=100&sort=urgence&order=desc'));
    expect(urgency.result.body.items).toHaveLength(100);
    expect(urgency.count).toBeLessThanOrEqual(20);
    // Changement de jour local : 100 plans recalculés en lot, sans requête par plan.
    t.clock.set('2026-09-25T23:30:00.000Z');
    const refresh = await countSql(() => chefA.get('/maintenance-plans?pageSize=100'));
    expect(refresh.result.status).toBe(200);
    expect(refresh.count).toBeLessThanOrEqual(40);
    process.stderr.write(`SQL liste pageSize=5 : ${small.count} ; pageSize=100 : ${large.count} ; tri urgence : ${urgency.count} ; rafraîchissement de 100 plans : ${refresh.count}\n`);
  });

  it('tri urgence / reste km / reste jours / échéance / véhicule / opération, ordre asc|desc, tri inconnu refusé', async () => {
    const [v1, v2, v3, v4] = [await createVehicle(t.prisma, f, 'A', { code: 'A-001' }), await createVehicle(t.prisma, f, 'A', { code: 'A-002' }), await createVehicle(t.prisma, f, 'A', { code: 'A-003' }), await createVehicle(t.prisma, f, 'A', { code: 'A-004' })];
    for (const v of [v1, v2, v3, v4] as string[]) await reading(v, '89800');
    const late = await plan({ vehicleId: v1, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '79000' } }); // 89 000 : dépassée de 800
    const soon = await plan({ vehicleId: v2, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } }); // reste 200
    const ok = await plan({ vehicleId: v3, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '85000' } }); // reste 5 200
    const incomplete = await plan({ vehicleId: v4, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } });
    const dated = await plan({ vehicleId: v1, maintenanceTypeId: batterieId, intervalMonths: 24, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2024-10-05' } }); // 05/10/2026 : A_PREVOIR, dans 10 j
    expect([late.status, soon.status, ok.status, incomplete.status, dated.status]).toEqual(['EN_RETARD', 'A_PREVOIR', 'A_JOUR', 'INCOMPLET', 'A_PREVOIR']);

    const ids = async (query: string) => (await list(query)).items.map((x) => x.id);
    expect(await ids('?sort=urgence&order=desc')).toEqual([late.id, dated.id, soon.id, incomplete.id, ok.id]);
    // Sens inverse ; à rang égal, un reste inconnu reste en fin de groupe.
    expect(await ids('?sort=urgence&order=asc')).toEqual([ok.id, incomplete.id, dated.id, soon.id, late.id]);
    expect(await ids('?sort=resteKm&order=asc')).toEqual([late.id, soon.id, ok.id, dated.id, incomplete.id]);
    expect(await ids('?sort=resteKm&order=desc')).toEqual([ok.id, soon.id, late.id, dated.id, incomplete.id]);
    expect((await ids('?sort=resteJours&order=asc'))[0]).toBe(dated.id);
    expect(await ids('?sort=echeance&order=asc')).toEqual([dated.id, late.id, soon.id, ok.id, incomplete.id]);
    expect((await list('?sort=vehicule&order=desc')).items.map((x) => x.vehicleCode)).toEqual(['A-004', 'A-003', 'A-002', 'A-001', 'A-001']);
    expect((await list('?sort=operation&order=asc')).items[0]?.maintenanceTypeLabel).toBe('Batterie');
    // Pagination stable sur un tri calculé : total inchangé, pages disjointes.
    const p1 = await list('?sort=urgence&order=desc&pageSize=2&page=1');
    const p2 = await list('?sort=urgence&order=desc&pageSize=2&page=2');
    expect(p1.total).toBe(5);
    expect([...p1.items, ...p2.items].map((x) => x.id)).toEqual([late.id, dated.id, soon.id, incomplete.id]);
    // Tri combiné au filtre de statut.
    expect(await ids('?sort=resteKm&status=A_PREVOIR')).toEqual([soon.id, dated.id]);
    const bad = await chefA.get('/maintenance-plans?sort=couleur');
    expect(bad.status).toBe(422);
  });

  it('recherche q : code ou immatriculation du véhicule, libellé d’opération, dans le périmètre seulement', async () => {
    const v1 = await createVehicle(t.prisma, f, 'A', { code: 'CIT-01', registration: '123 TU 4567' });
    const v2 = await createVehicle(t.prisma, f, 'A', { code: 'UTI-02', registration: '999 TU 1111' });
    const vb = await createVehicle(t.prisma, f, 'B', { code: 'CIT-99', registration: '555 TU 5555' });
    const p1 = await plan({ vehicleId: v1, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } });
    const p2 = await plan({ vehicleId: v2, maintenanceTypeId: batterieId, intervalMonths: 24, base: { baseMode: 'AUCUNE' } });
    const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    expect((await chefB.post('/maintenance-plans', { vehicleId: vb, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } })).status).toBe(201);
    expect((await list('?q=cit')).items.map((x) => x.id)).toEqual([p1.id]);
    expect((await list('?q=123%20tu%204567')).items.map((x) => x.id)).toEqual([p1.id]);
    expect((await list('?q=123tu-4567')).items.map((x) => x.id)).toEqual([p1.id]);
    expect((await list('?q=batt')).items.map((x) => x.id)).toEqual([p2.id]);
    expect((await list('?q=vidange')).total).toBe(1);
    expect((await admin.get('/maintenance-plans?q=vidange')).body.total).toBe(2);
    expect((await list('?q=introuvable')).total).toBe(0);
  });

  it('kilomètres affichés tronqués, jamais arrondis (13.1)', async () => {
    const v = await createVehicle(t.prisma, f, 'A');
    await reading(v, '89000');
    const p = await plan({ vehicleId: v, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000.6' } });
    expect(p).toMatchObject({ baseKm: '80000', nextDueKm: '90000', remainingKm: '1000', status: 'A_JOUR' });
    const listed = (await list('')).items[0];
    expect(listed).toMatchObject({ baseKm: '80000', nextDueKm: '90000', remainingKm: '1000' });
  });
});
