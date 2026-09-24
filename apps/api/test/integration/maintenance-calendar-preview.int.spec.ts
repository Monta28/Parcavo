import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Calendrier des échéances de /entretiens (CDC 10.2) et prévisualisation de l'impact d'une application de
 * modèle en mode METTRE_A_JOUR (6.1, 17.1). Toutes les valeurs viennent de l'API (règle unique).
 */
describe('Calendrier des échéances et prévisualisation d’un modèle (CDC 6.1, 10.2, 17.1)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
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
    vidangeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id;
    batterieId = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id;
  });

  describe('calendrier mensuel', () => {
    it('échéances en date du mois (statut matérialisé, identique à la liste) et interventions planifiées ; brouillons, km seuls et autres sociétés exclus', async () => {
      const vA = await createVehicle(t.prisma, f, 'A', { code: 'V-A' });
      const vB = await createVehicle(t.prisma, f, 'B', { code: 'V-B' });
      // Échéance 2026-10-15 (base 2026-07-15 + 3 mois), préavis 30 j → A_PREVOIR au 24/09 (21 j restants).
      const inOctober = await chefA.post('/maintenance-plans', { vehicleId: vA, maintenanceTypeId: batterieId, intervalMonths: 3, noticeDays: 30, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-07-15' } });
      expect(inOctober.status, JSON.stringify(inOctober.body)).toBe(201);
      // Intervalle en jours : base 2026-08-02 + 90 j = 2026-10-31.
      const inDays = await chefA.post('/maintenance-plans', { vehicleId: vA, maintenanceTypeId: vidangeId, intervalDays: 90, noticeDays: 10, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-08-02' } });
      expect(inDays.body.nextDueDate).toBe('2026-10-31');
      // Autre société : invisible du chef A.
      await chefB.post('/maintenance-plans', { vehicleId: vB, maintenanceTypeId: batterieId, intervalMonths: 3, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-07-20' } });

      const planned = await chefA.post('/interventions', { vehicleId: vA, kind: 'PREVENTIF', tasks: [{ planId: inOctober.body.id }], plannedStartAt: '2026-10-14T07:00:00.000Z', plannedEndAt: '2026-10-14T12:00:00.000Z' });
      expect(planned.status, JSON.stringify(planned.body)).toBe(201);
      expect(planned.body.status).toBe('PLANIFIEE');
      // 31/10 23:30 UTC = 01/11 00:30 à Tunis : appartient à novembre.
      const lateNight = await chefA.post('/interventions', { vehicleId: vA, kind: 'CORRECTIF', tasks: [{ label: 'Contrôle bruit' }], plannedStartAt: '2026-10-31T23:30:00.000Z' });
      expect(lateNight.body.status).toBe('PLANIFIEE');
      // Brouillon (sans date prévue) : pas dans le calendrier.
      await chefA.post('/interventions', { vehicleId: vA, kind: 'CORRECTIF', tasks: [{ label: 'Diagnostic' }] });

      const october = await chefA.get('/maintenance-calendar?month=2026-10');
      expect(october.status, JSON.stringify(october.body)).toBe(200);
      expect(october.body).toMatchObject({ month: '2026-10', from: '2026-10-01', to: '2026-10-31', timezone: 'Africa/Tunis', overdueBeforeCount: 0, truncated: false });
      expect(october.body.dueItems).toEqual([
        expect.objectContaining({ planId: inOctober.body.id, vehicleCode: 'V-A', maintenanceTypeLabel: 'Batterie', date: '2026-10-15', status: 'A_PREVOIR' }),
        expect.objectContaining({ planId: inDays.body.id, maintenanceTypeLabel: 'Vidange moteur', date: '2026-10-31', status: 'A_JOUR' }),
      ]);
      // Même statut que la liste des échéances (une seule source).
      const list = (await chefA.get('/maintenance-plans')).body.items as Array<{ id: string; status: string }>;
      for (const item of october.body.dueItems) expect(list.find((p) => p.id === item.planId)?.status).toBe(item.status);
      expect(october.body.interventions).toEqual([expect.objectContaining({ id: planned.body.id, reference: planned.body.reference, date: '2026-10-14', kind: 'PREVENTIF', tasks: ['Batterie'] })]);

      const november = (await chefA.get('/maintenance-calendar?month=2026-11')).body;
      expect(november.interventions.map((i: { id: string; date: string }) => [i.id, i.date])).toEqual([[lateNight.body.id, '2026-11-01']]);
      expect(november.dueItems).toEqual([]);

      // Le chef B ne voit que sa société ; filtre par véhicule ; société hors périmètre → 403/404.
      const bView = (await chefB.get('/maintenance-calendar?month=2026-10')).body;
      expect(bView.dueItems.map((d: { vehicleCode: string }) => d.vehicleCode)).toEqual(['V-B']);
      expect(bView.interventions).toEqual([]);
      expect((await chefA.get(`/maintenance-calendar?month=2026-10&vehicleId=${vB}`)).body.dueItems).toEqual([]);
      // Société hors périmètre : 404 (existence non révélée).
      expect((await chefA.get(`/maintenance-calendar?month=2026-10&companyId=${f.companies.B}`)).status).toBe(404);
      expect((await chefA.get('/maintenance-calendar?month=2026-13')).status).toBe(422);
    });

    it('bascule au jour local : échéance du jour A_FAIRE puis EN_RETARD le lendemain ; retards antérieurs comptés à part', async () => {
      const v = await createVehicle(t.prisma, f, 'A', { code: 'V-J' });
      const plan = await chefA.post('/maintenance-plans', { vehicleId: v, maintenanceTypeId: batterieId, intervalDays: 30, noticeDays: 5, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-08-25' } });
      expect(plan.body.nextDueDate).toBe('2026-09-24');
      const today = (await chefA.get('/maintenance-calendar?month=2026-09')).body;
      expect(today.dueItems).toEqual([expect.objectContaining({ date: '2026-09-24', status: 'A_FAIRE' })]);
      // 25/09 00:30 à Tunis (24/09 23:30 UTC) : le statut matérialisé est rafraîchi avant lecture.
      t.clock.set('2026-09-24T23:30:00.000Z');
      // Nouvelle session : la précédente a expiré par inactivité avec l'avance de l'horloge.
      chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
      const tomorrow = (await chefA.get('/maintenance-calendar?month=2026-09')).body;
      expect(tomorrow.dueItems).toEqual([expect.objectContaining({ date: '2026-09-24', status: 'EN_RETARD' })]);
      expect((await chefA.get('/maintenance-calendar?month=2026-10')).body.overdueBeforeCount).toBe(1);
    });
  });

  describe('application d’un modèle : prévisualisation de l’impact (METTRE_A_JOUR)', () => {
    it('prévisualisation sans aucun effet (plan, version, audit, alerte, clé d’idempotence), puis application conforme à l’aperçu', async () => {
      const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-1' });
      const v2 = await createVehicle(t.prisma, f, 'A', { code: 'V-2' });
      expect((await chefA.post(`/vehicles/${v1}/readings`, { physicalKm: '89700', observedAt: '2026-09-20T08:00:00Z' })).status).toBe(201);
      const p1 = (await chefA.post('/maintenance-plans', { vehicleId: v1, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } })).body;
      expect(p1).toMatchObject({ nextDueKm: '90000', status: 'A_PREVOIR', version: 1 });
      const tpl = await admin.post('/maintenance-templates', { name: 'Utilitaire', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000', noticeKm: '800' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }] });
      expect(tpl.status).toBe(201);
      const auditBefore = await t.prisma.client.auditEvent.count();
      const alertsBefore = await t.prisma.client.alert.findMany({ orderBy: { id: 'asc' } });
      const key = randomUUID();
      const body = { vehicleIds: [v1, v2], onExisting: 'METTRE_A_JOUR' };

      const preview = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, preview: true }).set('Idempotency-Key', key);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.preview).toBe(true);
      const vidangeV1 = preview.body.impacts.find((i: { vehicleCode: string; maintenanceTypeLabel: string }) => i.vehicleCode === 'V-1' && i.maintenanceTypeLabel === 'Vidange moteur');
      expect(vidangeV1).toMatchObject({
        planId: p1.id,
        action: 'MISE_A_JOUR',
        planVersion: 1,
        before: { intervalKm: '10000', noticeKm: '500', nextDueKm: '90000', status: 'A_PREVOIR', remainingKm: '300' },
        after: { intervalKm: '15000', noticeKm: '800', nextDueKm: '95000', status: 'A_JOUR', remainingKm: '5300' },
      });
      const created = preview.body.impacts.filter((i: { action: string }) => i.action === 'CREATION');
      // V-1 : batterie créée ; V-2 : vidange et batterie créées, INCOMPLET faute de base (aucune fausse vidange).
      expect(created).toHaveLength(3);
      for (const c of created) expect(c).toMatchObject({ planId: null, planVersion: null, before: null, after: { status: 'INCOMPLET' } });

      // Rien n'a été enregistré.
      const stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: p1.id } });
      expect(stored.version).toBe(1);
      expect(stored.intervalKm?.toString()).toBe('10000');
      expect(stored.nextDueKm?.toString()).toBe('90000');
      expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(1);
      expect(await t.prisma.client.auditEvent.count()).toBe(auditBefore);
      expect(await t.prisma.client.alert.findMany({ orderBy: { id: 'asc' } })).toEqual(alertsBefore);
      expect(await t.prisma.client.idempotencyRecord.count({ where: { key } })).toBe(0);

      // Application réelle avec la même clé, en confirmant les plans et versions de l'aperçu : résultat conforme, auditée.
      const applied = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, expectedPlanVersions: [{ planId: p1.id, version: 1 }] }).set('Idempotency-Key', key);
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body.preview).toBe(false);
      const appliedV1 = applied.body.impacts.find((i: { planId: string | null }) => i.planId === p1.id);
      expect(appliedV1.after).toEqual(vidangeV1.after);
      expect(appliedV1.before).toEqual(vidangeV1.before);
      expect(applied.body.impacts.filter((i: { action: string; planId: string | null }) => i.action === 'CREATION' && i.planId !== null)).toHaveLength(3);
      expect((await chefA.get(`/maintenance-plans/${p1.id}`)).body).toMatchObject({ intervalKm: '15000', nextDueKm: '95000', status: 'A_JOUR', version: 2 });
      expect(await t.prisma.client.auditEvent.count({ where: { action: 'modele_entretien.application' } })).toBe(1);
      // Historique : aucune intervention ni dépense créée par la copie.
      expect(await t.prisma.client.intervention.count()).toBe(0);
      expect(await t.prisma.client.expense.count()).toBe(0);
    });

    it('confirmation d’un aperçu périmé : plan modifié ou créé entre-temps → 409 VERSION_OBSOLETE, rien n’est enregistré ; nouvel aperçu puis confirmation', async () => {
      const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-1' });
      const v2 = await createVehicle(t.prisma, f, 'A', { code: 'V-2' });
      const p1 = (await chefA.post('/maintenance-plans', { vehicleId: v1, maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } })).body;
      const tpl = await admin.post('/maintenance-templates', { name: 'Utilitaire', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000', noticeKm: '800' }] });
      const body = { vehicleIds: [v1, v2], onExisting: 'METTRE_A_JOUR' };
      const preview = (await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, preview: true })).body;
      const confirmed = preview.impacts
        .filter((i: { action: string }) => i.action === 'MISE_A_JOUR')
        .map((i: { planId: string; planVersion: number }) => ({ planId: i.planId, version: i.planVersion }));
      expect(confirmed).toEqual([{ planId: p1.id, version: 1 }]);

      // 1. Le plan présenté est modifié par un autre utilisateur avant la confirmation.
      const edited = await admin.patch(`/maintenance-plans/${p1.id}`, { intervalKm: '12000', reason: 'Consigne constructeur', expectedVersion: 1 });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const auditBefore = await t.prisma.client.auditEvent.count();
      const key = randomUUID();
      const stale = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, expectedPlanVersions: confirmed }).set('Idempotency-Key', key);
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      expect(stale.body.code).toBe('VERSION_OBSOLETE');
      expect(stale.body.details.current).toEqual([{ planId: p1.id, version: 2 }]);
      // Rien n'est enregistré : ni mise à jour, ni plan créé pour V-2, ni audit ; la clé reste disponible.
      expect((await chefA.get(`/maintenance-plans/${p1.id}`)).body).toMatchObject({ intervalKm: '12000', version: 2 });
      expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(1);
      expect(await t.prisma.client.auditEvent.count()).toBe(auditBefore);
      expect(await t.prisma.client.idempotencyRecord.count({ where: { key } })).toBe(0);

      // 2. Nouvel aperçu (version 2), mais un plan est créé entre-temps sur V-2 : la création annoncée deviendrait une mise à jour.
      const again = (await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, preview: true })).body;
      const confirmedAgain = again.impacts.filter((i: { action: string }) => i.action === 'MISE_A_JOUR').map((i: { planId: string; planVersion: number }) => ({ planId: i.planId, version: i.planVersion }));
      expect(confirmedAgain).toEqual([{ planId: p1.id, version: 2 }]);
      const p2 = await chefA.post('/maintenance-plans', { vehicleId: v2, maintenanceTypeId: vidangeId, intervalKm: '9000', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '1000' } });
      expect(p2.status, JSON.stringify(p2.body)).toBe(201);
      const created = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, expectedPlanVersions: confirmedAgain }).set('Idempotency-Key', key);
      expect(created.status).toBe(409);
      expect(created.body.code).toBe('VERSION_OBSOLETE');
      expect((await chefA.get(`/maintenance-plans/${p2.body.id}`)).body).toMatchObject({ intervalKm: '9000', version: 1 });

      // 3. Aperçu à jour puis confirmation : appliquée, conforme à l'aperçu.
      const last = (await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, preview: true })).body;
      const expected = last.impacts.map((i: { planId: string; planVersion: number }) => ({ planId: i.planId, version: i.planVersion }));
      expect(expected).toEqual(expect.arrayContaining([{ planId: p1.id, version: 2 }, { planId: p2.body.id, version: 1 }]));
      const ok = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body, expectedPlanVersions: expected }).set('Idempotency-Key', key);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      for (const impact of ok.body.impacts) expect(impact.after).toEqual(last.impacts.find((i: { planId: string }) => i.planId === impact.planId).after);
      expect((await chefA.get(`/maintenance-plans/${p1.id}`)).body).toMatchObject({ intervalKm: '15000', version: 3 });
    });

    it('paramètre de préavis d’entretien par défaut : sans effet sur les plans existants (valeurs copiées), appliqué aux seuls plans créés ensuite', async () => {
      const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-1' });
      expect((await chefA.post(`/vehicles/${v1}/readings`, { physicalKm: '89300', observedAt: '2026-09-23T08:00:00Z' })).status).toBe(201);
      const existing = (await chefA.post('/maintenance-plans', { vehicleId: v1, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } })).body;
      expect(existing).toMatchObject({ noticeKm: '500', status: 'A_JOUR', version: 1 });
      const changed = await admin.put('/settings/maintenance.noticeKm', { value: 1000, reason: 'Préavis allongé pour le groupe' });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      // Le plan existant garde son préavis et son statut : aucun impact rétroactif, rien à prévisualiser.
      expect((await chefA.get(`/maintenance-plans/${existing.id}`)).body).toMatchObject({ noticeKm: '500', status: 'A_JOUR', version: 1 });
      const stored = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: existing.id } });
      expect(stored.noticeKm?.toString()).toBe('500');
      // Un plan créé ensuite reçoit la nouvelle valeur par défaut.
      const v2 = await createVehicle(t.prisma, f, 'A', { code: 'V-2' });
      const next = (await chefA.post('/maintenance-plans', { vehicleId: v2, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } })).body;
      expect(next.noticeKm).toBe('1000');
    });

    it('prévisualisation soumise aux mêmes droits que l’application : chef d’une autre société refusé', async () => {
      const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-1' });
      const tpl = await admin.post('/maintenance-templates', { name: 'Citadine', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000' }] });
      const res = await chefB.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [v1], onExisting: 'METTRE_A_JOUR', preview: true });
      expect(res.status).toBe(404);
      expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(0);
    });
  });
});
