import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Modèles, responsable et cycle de vie des plans d’entretien (CDC 6.1, D-197, D-198)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
  let vidangeId: string;
  let batterieId: string;
  let freinsId: string;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vidangeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id;
    batterieId = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id;
    freinsId = (await admin.post('/maintenance-types', { code: 'FREINS', label: 'Freins' })).body.id;
  });

  async function archive(typeId: string) {
    const current = (await admin.get('/maintenance-types?includeArchived=true')).body.find((x: { id: string }) => x.id === typeId);
    const res = await admin.patch(`/maintenance-types/${typeId}`, { status: 'ARCHIVE', expectedVersion: current.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  describe('modèles : erreurs par ligne', () => {
    it('erreurs d’intervalle renvoyées sous items.N.<champ>, toutes lignes confondues', async () => {
      const res = await admin.post('/maintenance-templates', {
        name: 'Erreurs',
        items: [
          { maintenanceTypeId: vidangeId, intervalKm: '10000' },
          { maintenanceTypeId: batterieId, intervalKm: '1000', noticeKm: '1000' },
          { maintenanceTypeId: freinsId, intervalMonths: 6, intervalDays: 180 },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PREAVIS_KM_TROP_GRAND');
      expect(res.body.fieldErrors['items.1.noticeKm']).toEqual(['Le préavis en km doit être inférieur à l’intervalle en km.']);
      expect(res.body.fieldErrors['items.2.intervalDays']).toEqual(['Choisissez un intervalle en mois ou en jours, pas les deux.']);
      expect(res.body.fieldErrors['noticeKm']).toBeUndefined();
      expect(Object.keys(res.body.fieldErrors).some((k) => k.startsWith('items.0.'))).toBe(false);
      const empty = await admin.post('/maintenance-templates', { name: 'Vide', items: [{ maintenanceTypeId: vidangeId }] });
      expect(empty.status).toBe(422);
      expect(empty.body.fieldErrors['items.0.intervalKm']).toHaveLength(1);
      const dup = await admin.post('/maintenance-templates', { name: 'Doublon', items: [{ maintenanceTypeId: vidangeId, intervalKm: '1000' }, { maintenanceTypeId: vidangeId, intervalKm: '2000' }] });
      expect(dup.status).toBe(422);
      expect(dup.body.code).toBe('TYPE_EN_DOUBLE');
      expect(dup.body.fieldErrors['items.1.maintenanceTypeId']).toHaveLength(1);
    });

    it('opération archivée : 422 TYPE_ARCHIVE signalé sur sa ligne avec son index', async () => {
      await archive(batterieId);
      const res = await admin.post('/maintenance-templates', { name: 'Avec archivée', items: [{ maintenanceTypeId: vidangeId, intervalKm: '10000' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TYPE_ARCHIVE');
      expect(res.body.message).toContain('ligne 2');
      expect(res.body.fieldErrors['items.1.maintenanceTypeId']).toHaveLength(1);
      expect(res.body.details.items).toEqual([{ index: 1, maintenanceTypeId: batterieId, label: 'Batterie' }]);
      expect(await t.prisma.client.maintenancePlanTemplate.count()).toBe(0);
    });

    it('PATCH : une ligne inchangée dont l’opération a été archivée depuis est acceptée ; modifiée, elle est refusée', async () => {
      const tpl = await admin.post('/maintenance-templates', { name: 'Utilitaire', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000', noticeKm: '800' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }] });
      expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
      await archive(batterieId);
      const got = (await admin.get(`/maintenance-templates/${tpl.body.id}`)).body;
      expect(got.items.find((i: { maintenanceTypeId: string }) => i.maintenanceTypeId === batterieId).maintenanceTypeStatus).toBe('ARCHIVE');
      // Ligne Batterie renvoyée telle quelle, Vidange modifiée : accepté.
      const ok = await admin.patch(`/maintenance-templates/${tpl.body.id}`, { name: 'Utilitaire diesel', items: [{ maintenanceTypeId: vidangeId, intervalKm: '20000', noticeKm: '800' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }], expectedVersion: 1 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.items.map((i: { maintenanceTypeLabel: string; intervalKm: string | null }) => [i.maintenanceTypeLabel, i.intervalKm])).toEqual([
        ['Batterie', null],
        ['Vidange moteur', '20000'],
      ]);
      // Ligne archivée modifiée : refusée sur sa ligne.
      const changed = await admin.patch(`/maintenance-templates/${tpl.body.id}`, { items: [{ maintenanceTypeId: vidangeId, intervalKm: '20000', noticeKm: '800' }, { maintenanceTypeId: batterieId, intervalMonths: 36 }], expectedVersion: 2 });
      expect(changed.status).toBe(422);
      expect(changed.body.code).toBe('TYPE_ARCHIVE');
      expect(changed.body.details.items[0].index).toBe(1);
      // Ajout d'une opération archivée absente du modèle : refusé.
      const added = await admin.patch(`/maintenance-templates/${tpl.body.id}`, { items: [{ maintenanceTypeId: vidangeId, intervalKm: '20000' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }], expectedVersion: 2 });
      expect(added.status).toBe(200);
      await archive(freinsId);
      const withNew = await admin.patch(`/maintenance-templates/${tpl.body.id}`, { items: [{ maintenanceTypeId: freinsId, intervalKm: '30000' }, { maintenanceTypeId: batterieId, intervalMonths: 48 }], expectedVersion: 3 });
      expect(withNew.status).toBe(422);
      expect(withNew.body.fieldErrors['items.0.maintenanceTypeId']).toHaveLength(1);
    });
  });

  describe('application d’un modèle (D-198)', () => {
    it('choix par véhicule prioritaire sur le défaut global ; mise à jour versionnée, auditée et recalculée ; opération archivée non copiée', async () => {
      const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-1' });
      const v2 = await createVehicle(t.prisma, f, 'A', { code: 'V-2' });
      const v3 = await createVehicle(t.prisma, f, 'A', { code: 'V-3' });
      const base = { maintenanceTypeId: vidangeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '80000' } };
      const p1 = (await chefA.post('/maintenance-plans', { ...base, vehicleId: v1 })).body;
      const p2 = (await chefA.post('/maintenance-plans', { ...base, vehicleId: v2 })).body;
      const tpl = await admin.post('/maintenance-templates', { name: 'Citadine', items: [{ maintenanceTypeId: vidangeId, intervalKm: '15000', noticeKm: '700' }, { maintenanceTypeId: freinsId, intervalKm: '40000' }] });
      expect(tpl.status).toBe(201);
      await archive(freinsId);

      const bad = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [v1], perVehicle: [{ vehicleId: v2, onExisting: 'METTRE_A_JOUR' }] });
      expect(bad.status).toBe(422);
      expect(bad.body.fieldErrors['perVehicle.0.vehicleId']).toHaveLength(1);

      const res = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { vehicleIds: [v1, v2, v3], onExisting: 'IGNORER', perVehicle: [{ vehicleId: v1, onExisting: 'METTRE_A_JOUR' }] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.archivedSkipped).toEqual(['Freins']);
      const byVehicle = Object.fromEntries(res.body.vehicles.map((r: { vehicleCode: string }) => [r.vehicleCode, r]));
      expect(byVehicle['V-1']).toMatchObject({ onExisting: 'METTRE_A_JOUR', updated: ['Vidange moteur'], created: [], ignored: [] });
      expect(byVehicle['V-2']).toMatchObject({ onExisting: 'IGNORER', updated: [], created: [], ignored: ['Vidange moteur'] });
      expect(byVehicle['V-3']).toMatchObject({ onExisting: 'IGNORER', created: ['Vidange moteur'] });

      const after1 = (await chefA.get(`/maintenance-plans/${p1.id}`)).body;
      expect(after1).toMatchObject({ intervalKm: '15000', noticeKm: '700', baseKm: '80000', nextDueKm: '95000', version: 2, templateId: tpl.body.id });
      const after2 = (await chefA.get(`/maintenance-plans/${p2.id}`)).body;
      expect(after2).toMatchObject({ intervalKm: '10000', nextDueKm: '90000', version: 1 });
      const stored1 = await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: p1.id } });
      expect(stored1.nextDueKm?.toString()).toBe('95000');
      const audit = await t.prisma.client.auditEvent.findMany({ where: { objectId: p1.id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['plan_entretien.creation', 'plan_entretien.modification']);
      expect(audit[1]?.reason).toBe('Application du modèle « Citadine »');
      expect(audit[1]?.before).toMatchObject({ intervalKm: '10000', noticeKm: '500' });
      expect(audit[1]?.after).toMatchObject({ intervalKm: '15000', noticeKm: '700', version: 2 });
      expect(await t.prisma.client.auditEvent.count({ where: { objectId: p2.id, action: 'plan_entretien.modification' } })).toBe(0);
      // Aucun plan créé pour l'opération archivée.
      expect(await t.prisma.client.vehicleMaintenancePlan.count({ where: { maintenanceTypeId: freinsId } })).toBe(0);

      // Défaut global METTRE_A_JOUR, exception IGNORER pour V-1 ; clé d'idempotence : un rejeu ne réapplique rien.
      const body2 = { vehicleIds: [v1, v2], onExisting: 'METTRE_A_JOUR', perVehicle: [{ vehicleId: v1, onExisting: 'IGNORER' }] };
      const res2 = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, body2).set('Idempotency-Key', 'application-modele-0001');
      expect(res2.status).toBe(200);
      expect((await chefA.get(`/maintenance-plans/${p1.id}`)).body.version).toBe(2);
      expect((await chefA.get(`/maintenance-plans/${p2.id}`)).body).toMatchObject({ intervalKm: '15000', version: 2 });
      const replay = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, body2).set('Idempotency-Key', 'application-modele-0001');
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(res2.body);
      expect((await chefA.get(`/maintenance-plans/${p2.id}`)).body.version).toBe(2);
      expect(await t.prisma.client.auditEvent.count({ where: { objectId: p2.id, action: 'plan_entretien.modification' } })).toBe(1);
      const otherBody = await chefA.post(`/maintenance-templates/${tpl.body.id}/apply`, { ...body2, onExisting: 'IGNORER' }).set('Idempotency-Key', 'application-modele-0001');
      expect(otherBody.status).toBe(409);
    });
  });

  describe('responsable du plan', () => {
    it('contrôlé : même organisation, compte actif, habilité sur la société du plan ; nom renvoyé', async () => {
      const v = await createVehicle(t.prisma, f, 'A');
      const body = { vehicleId: v, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } };
      for (const userId of [f.users.chefB, f.users.lecteurA, f.users.conducteurA, '01a0d40e-0000-7000-8000-000000000000']) {
        const res = await chefA.post('/maintenance-plans', { ...body, responsibleUserId: userId });
        expect(res.status, userId).toBe(422);
        expect(res.body.code).toBe('RESPONSABLE_INVALIDE');
        expect(res.body.fieldErrors.responsibleUserId).toHaveLength(1);
      }
      // Compte d'une autre organisation.
      const other = await seedFixture(t.prisma);
      expect((await chefA.post('/maintenance-plans', { ...body, responsibleUserId: other.users.admin })).body.code).toBe('RESPONSABLE_INVALIDE');
      expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(0);

      const created = await chefA.post('/maintenance-plans', { ...body, responsibleUserId: f.users.operateurA });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ responsibleUserId: f.users.operateurA, responsibleUserName: 'Omar Opérateur-A' });
      expect((await chefA.get('/maintenance-plans')).body.items[0].responsibleUserName).toBe('Omar Opérateur-A');
      // Administrateur groupe accepté ; compte désactivé refusé.
      const toAdmin = await chefA.patch(`/maintenance-plans/${created.body.id}`, { responsibleUserId: f.users.admin, reason: 'Suivi groupe', expectedVersion: 1 });
      expect(toAdmin.status, JSON.stringify(toAdmin.body)).toBe(200);
      expect(toAdmin.body.responsibleUserName).toBe('Alice Admin');
      await t.prisma.client.user.update({ where: { id: f.users.chefA }, data: { status: 'DESACTIVE' } });
      expect((await admin.patch(`/maintenance-plans/${created.body.id}`, { responsibleUserId: f.users.chefA, reason: 'Retour', expectedVersion: 2 })).body.code).toBe('RESPONSABLE_INVALIDE');
      // Responsable inchangé (compte désactivé depuis) : les autres modifications restent possibles.
      await t.prisma.client.user.update({ where: { id: f.users.admin }, data: { status: 'DESACTIVE' } });
      await t.prisma.client.user.update({ where: { id: f.users.chefA }, data: { status: 'ACTIF' } });
      const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
      const keep = await chef.patch(`/maintenance-plans/${created.body.id}`, { responsibleUserId: f.users.admin, noticeKm: '400', reason: 'Préavis', expectedVersion: 2 });
      expect(keep.status, JSON.stringify(keep.body)).toBe(200);
      expect(keep.body.version).toBe(3);
    });
  });

  describe('désactivation et réactivation', () => {
    it('désactiver un plan déjà inactif : 409 ; réactivation motivée, versionnée, auditée ; refus si un plan actif du même type existe', async () => {
      const v = await createVehicle(t.prisma, f, 'A');
      const plan = (await chefA.post('/maintenance-plans', { vehicleId: v, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } })).body;
      const off = await chefA.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Contrat constructeur', expectedVersion: 1 });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ active: false, version: 2 });
      const again = await chefA.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Encore', expectedVersion: 2 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ETAT_INVALIDE');
      expect(await t.prisma.client.auditEvent.count({ where: { objectId: plan.id, action: 'plan_entretien.desactivation' } })).toBe(1);

      expect((await operateurA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Fin du contrat', expectedVersion: 2 })).status).toBe(403);
      expect((await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Fin du contrat', expectedVersion: 1 })).status).toBe(409);
      expect((await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { expectedVersion: 2 })).status).toBe(422);
      const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
      expect((await chefB.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Hors périmètre', expectedVersion: 2 })).status).toBe(404);

      // Un nouveau plan actif du même type a été créé entre-temps : réactivation refusée.
      const replacement = (await chefA.post('/maintenance-plans', { vehicleId: v, maintenanceTypeId: vidangeId, intervalKm: '15000', base: { baseMode: 'AUCUNE' } })).body;
      const conflict = await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Fin du contrat', expectedVersion: 2 });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PLAN_EXISTANT');
      expect((await chefA.post(`/maintenance-plans/${replacement.id}/deactivate`, { reason: 'Doublon', expectedVersion: 1 })).status).toBe(200);

      const on = await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Fin du contrat constructeur', expectedVersion: 2 });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body).toMatchObject({ active: true, version: 3, deactivationReason: null, status: 'INCOMPLET' });
      expect(await t.prisma.client.alert.count({ where: { objectId: plan.id, type: 'ENTRETIEN_PLAN_INCOMPLET', status: 'ACTIVE' } })).toBe(1);
      const audit = await t.prisma.client.auditEvent.findMany({ where: { objectId: plan.id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['plan_entretien.creation', 'plan_entretien.desactivation', 'plan_entretien.reactivation']);
      expect(audit[2]?.reason).toBe('Fin du contrat constructeur');
      const twice = await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Encore', expectedVersion: 3 });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('ETAT_INVALIDE');

      // Réactivations concurrentes de deux plans du même type : une seule réussit.
      expect((await chefA.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Test', expectedVersion: 3 })).status).toBe(200);
      const race = await Promise.all([
        chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Course A', expectedVersion: 4 }),
        chefA.post(`/maintenance-plans/${replacement.id}/reactivate`, { reason: 'Course B', expectedVersion: 2 }),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await t.prisma.client.vehicleMaintenancePlan.count({ where: { vehicleId: v, maintenanceTypeId: vidangeId, active: true } })).toBe(1);
    });

    it('réactivation refusée pour une opération archivée', async () => {
      const v = await createVehicle(t.prisma, f, 'A');
      const plan = (await chefA.post('/maintenance-plans', { vehicleId: v, maintenanceTypeId: batterieId, intervalMonths: 48, base: { baseMode: 'AUCUNE' } })).body;
      expect((await chefA.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Test', expectedVersion: 1 })).status).toBe(200);
      await archive(batterieId);
      const res = await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Reprise', expectedVersion: 2 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TYPE_ARCHIVE');
    });

    it('réactivation refusée pour un véhicule cédé ou archivé ; plan inchangé, aucun audit', async () => {
      const v = await createVehicle(t.prisma, f, 'A');
      const plan = (await chefA.post('/maintenance-plans', { vehicleId: v, maintenanceTypeId: vidangeId, intervalKm: '10000', base: { baseMode: 'AUCUNE' } })).body;
      expect((await chefA.post(`/maintenance-plans/${plan.id}/deactivate`, { reason: 'Cession prévue', expectedVersion: 1 })).status).toBe(200);
      for (const lifecycleStatus of ['CEDE', 'ARCHIVE'] as const) {
        await t.prisma.client.vehicle.update({ where: { id: v }, data: { lifecycleStatus } });
        const res = await chefA.post(`/maintenance-plans/${plan.id}/reactivate`, { reason: 'Reprise', expectedVersion: 2 });
        expect(res.status, lifecycleStatus).toBe(422);
        expect(res.body.code).toBe('VEHICULE_INACTIF');
      }
      expect(await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ active: false, version: 2 });
      expect(await t.prisma.client.auditEvent.count({ where: { objectId: plan.id, action: 'plan_entretien.reactivation' } })).toBe(0);
    });
  });
});
