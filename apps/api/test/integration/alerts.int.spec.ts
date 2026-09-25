import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertsService } from '../../src/modules/alerts/alerts.service.js';
import { MaintenancePlansService } from '../../src/modules/maintenance/maintenance-plans.service.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

interface Scenario {
  t: TestApp;
  f: Fixture;
  admin: Agent;
  chefA: Agent;
  chefB: Agent;
  operateurA: Agent;
  lecteurA: Agent;
  conducteurA: Agent;
  vidangeId: string;
}

async function prepare(t: TestApp): Promise<Scenario> {
  t.clock.set(NOW);
  await resetDatabase(t.prisma);
  const f = await seedFixture(t.prisma);
  const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
  const vidange = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
  expect(vidange.status, JSON.stringify(vidange.body)).toBe(201);
  return {
    t,
    f,
    admin,
    chefA: await login(t.server, f.emails.chefA, DEFAULT_PASSWORD),
    chefB: await login(t.server, f.emails.chefB, DEFAULT_PASSWORD),
    operateurA: await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD),
    lecteurA: await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD),
    conducteurA: await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD),
    vidangeId: vidange.body.id as string,
  };
}

async function reading(agent: Agent, vehicleId: string, physicalKm: string, observedAt: string): Promise<void> {
  const res = await agent.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.outcome).toBe('ACCEPTE');
}

/** Vidange en retard (base 80 000, intervalle 10 000, compteur 90 200) : plan EN_RETARD et alerte CRITIQUE. */
async function overdueOilChange(s: Scenario, company: 'A' | 'B' = 'A', options: { stopAtDue?: boolean } = {}): Promise<{ vehicleId: string; vehicleCode: string; planId: string; alertId: string }> {
  const agent = company === 'A' ? s.chefA : s.chefB;
  const vehicleId = await createVehicle(s.t.prisma, s.f, company);
  const vehicle = await s.t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  await reading(agent, vehicleId, '89500', '2026-09-20T08:00:00Z');
  const plan = await agent.post('/maintenance-plans', {
    vehicleId,
    maintenanceTypeId: s.vidangeId,
    intervalKm: '10000',
    noticeKm: '500',
    responsibleUserId: company === 'A' ? s.f.users.chefA : s.f.users.chefB,
    base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-03-01' },
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  await reading(agent, vehicleId, options.stopAtDue ? '90000' : '90200', '2026-09-23T08:00:00Z');
  const alert = await s.t.prisma.client.alert.findFirstOrThrow({ where: { objectId: plan.body.id, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } });
  return { vehicleId, vehicleCode: vehicle.code, planId: plan.body.id as string, alertId: alert.id };
}

describe('Centre d’alertes et notifications e-mail (CDC 9.1, 9.2, 9.4 — T19, T20, T29)', () => {
  describe('canal e-mail configuré (SMTP)', () => {
    let t: TestApp;
    let s: Scenario;

    beforeAll(async () => {
      t = await startTestApp({ now: NOW, smtp: true });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      s = await prepare(t);
    });

    it('T19 — dix recalculs de la même occurrence : une seule alerte active, aucune ligne d’outbox dupliquée', async () => {
      const { planId, alertId, vehicleCode } = await overdueOilChange(s);
      const alert = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } });
      expect(alert.severity).toBe('CRITIQUE');
      expect(alert.emailNotifiedSeverity).toBe('CRITIQUE');

      // E-mails immédiats : chef de parc de A et administrateur ; ni opérateur, ni lecteur, ni conducteur, ni chef B.
      const initial = await t.prisma.client.notificationOutbox.findMany({ where: { alertId }, orderBy: { recipientUserId: 'asc' } });
      expect(initial.map((o) => o.recipientUserId).sort()).toEqual([s.f.users.admin, s.f.users.chefA].sort());
      for (const o of initial) {
        expect(o.kind).toBe('ALERTE_CRITIQUE');
        expect(o.status).toBe('EN_ATTENTE');
        expect(o.attempts).toBe(0);
        expect(o.companyId).toBe(s.f.companies.A);
        expect(o.nextAttemptAt.toISOString()).toBe(NOW);
        expect(o.subject).toBe(`[Parc Auto] Alerte critique — Échéance d’entretien — ${vehicleCode}`);
        expect(o.bodyText).toContain(`Action à mener : ${TEST_ORIGIN}/entretiens?plan=${planId}`);
        expect(o.bodyText).toContain('Société : Société A');
        // Aucun montant, aucune donnée personnelle de conducteur, aucune pièce jointe (D-261).
        expect(o.bodyText).not.toMatch(/TND|Karim|Conducteur-A|\.pdf/);
      }

      const plans = t.app.get(MaintenancePlansService);
      for (let i = 0; i < 10; i += 1) await plans.syncAlerts(planId);
      await Promise.all(Array.from({ length: 10 }, () => plans.syncAlerts(planId)));
      for (let i = 0; i < 3; i += 1) await plans.recomputeAll(s.f.organizationId);
      const notifications = t.app.get(NotificationsService);
      for (let i = 0; i < 10; i += 1) expect(await notifications.enqueueCriticalAlert(alertId)).toBe(0);

      expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE' } })).toBe(1);
      expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE', status: 'ACTIVE' } })).toBe(1);
      const after = await t.prisma.client.notificationOutbox.findMany({ where: { alertId } });
      expect(after).toHaveLength(2);
      expect(new Set(after.map((o) => o.dedupeKey)).size).toBe(2);
      expect(await t.prisma.client.notificationOutbox.count({ where: { organizationId: s.f.organizationId } })).toBe(2);

      // Création concurrente de la même occurrence par le service unique : une seule ligne, sans erreur.
      const alerts = t.app.get(AlertsService);
      const condition = {
        organizationId: s.f.organizationId,
        companyId: s.f.companies.A,
        type: 'INCIDENT_CRITIQUE' as const,
        severity: 'CRITIQUE' as const,
        objectType: 'Incident',
        objectId: planId,
        occurrenceKey: 'ouvert',
        title: 'Incident critique non traité',
        message: 'Test de concurrence',
        condition: {},
        actionPath: '/incidents',
      };
      const ids = await Promise.all(Array.from({ length: 10 }, () => alerts.raise(condition)));
      expect(new Set(ids).size).toBe(1);
      expect(await t.prisma.client.alert.count({ where: { type: 'INCIDENT_CRITIQUE', objectId: planId } })).toBe(1);
      expect(await t.prisma.client.notificationOutbox.count({ where: { alertId: ids[0] } })).toBe(2);
    });

    it('escalade A_FAIRE → EN_RETARD sur la même alerte : e-mail à la seule gravité critique, lecture et report remis à zéro (D-246, D-252)', async () => {
      const { vehicleId, planId, alertId } = await overdueOilChange(s, 'A', { stopAtDue: true });
      let alert = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } });
      expect(alert.severity).toBe('URGENT');
      // URGENT : pas d'e-mail immédiat (récapitulatif seulement).
      expect(await t.prisma.client.notificationOutbox.count({ where: { alertId } })).toBe(0);
      expect((await s.chefA.post(`/alerts/${alertId}/read`)).status).toBe(200);
      const snoozed = await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-10-05', reason: 'Rendez-vous garage le 5 octobre' });
      expect(snoozed.status, JSON.stringify(snoozed.body)).toBe(200);

      await reading(s.chefA, vehicleId, '90200', '2026-09-24T08:00:00Z');
      alert = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } });
      expect(alert.severity).toBe('CRITIQUE');
      expect(alert.status).toBe('ACTIVE');
      expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE' } })).toBe(1);
      const view = (await s.chefA.get(`/alerts/${alertId}`)).body;
      expect(view.readAt).toBeNull();
      expect(view.snoozedUntil).toBeNull();
      expect(view.snoozes).toEqual([]);
      // Le report annulé par l'escalade ne bloque plus l'e-mail : chef A et administrateur.
      const rows = await t.prisma.client.notificationOutbox.findMany({ where: { alertId } });
      expect(rows.map((r) => r.recipientUserId).sort()).toEqual([s.f.users.admin, s.f.users.chefA].sort());
      expect(rows.every((r) => r.dedupeKey.endsWith(':CRITIQUE'))).toBe(true);
    });

    it('T20 — « lu » sur une vidange en retard : l’alerte reste ACTIVE et le plan EN_RETARD ; report motivé visible, statut inchangé', async () => {
      const { planId, alertId, vehicleCode } = await overdueOilChange(s);
      const list = await s.chefA.get('/alerts');
      expect(list.status).toBe(200);
      const item = list.body.items.find((a: { id: string }) => a.id === alertId);
      expect(item).toMatchObject({
        status: 'ACTIVE',
        severity: 'CRITIQUE',
        type: 'ENTRETIEN_ECHEANCE',
        typeLabel: 'Échéance d’entretien',
        companyId: s.f.companies.A,
        companyName: 'Société A',
        vehicleCode,
        objectType: 'VehicleMaintenancePlan',
        objectId: planId,
        actionPath: `/entretiens?plan=${planId}`,
        responsibleUserId: s.f.users.chefA,
        responsibleName: 'Chaima Chef-A',
        readAt: null,
        snoozedUntil: null,
        snoozeReason: null,
        canSnooze: true,
      });
      expect(item.condition).toMatchObject({ status: 'EN_RETARD', nextDueKm: '90000' });
      const unreadBefore = (await s.chefA.get('/alerts/counts')).body.unread as number;

      const read = await s.chefA.post(`/alerts/${alertId}/read`);
      expect(read.status).toBe(200);
      expect(read.body.readAt).toBe(NOW);
      expect(read.body.status).toBe('ACTIVE');
      // Lire ne résout pas l'alerte et ne retire pas le retard.
      const plan = await s.chefA.get(`/maintenance-plans/${planId}`);
      expect(plan.body.status).toBe('EN_RETARD');
      expect((await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId } })).computedStatus).toBe('EN_RETARD');
      const stored = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } });
      expect(stored.status).toBe('ACTIVE');
      expect(stored.resolvedAt).toBeNull();
      expect((await s.chefA.get('/alerts/counts')).body.unread).toBe(unreadBefore - 1);
      // « Lu » est propre à l'utilisateur : l'administrateur ne l'a pas lue.
      expect((await s.admin.get(`/alerts/${alertId}`)).body.readAt).toBeNull();
      expect((await s.chefA.get('/alerts?unread=true')).body.items.map((a: { id: string }) => a.id)).not.toContain(alertId);
      // Relire conserve la première date de lecture ; « non lu » la retire.
      t.clock.advance(60_000);
      expect((await s.chefA.post(`/alerts/${alertId}/read`)).body.readAt).toBe(NOW);
      expect((await s.chefA.post(`/alerts/${alertId}/unread`)).body.readAt).toBeNull();
      expect((await s.chefA.post(`/alerts/${alertId}/read`)).body.readAt).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());

      // Report motivé : visible avec motif, l'alerte reste ACTIVE, CRITIQUE, et le plan EN_RETARD.
      const reason = 'Garage indisponible avant le 1er octobre';
      const snooze = await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-10-01', reason });
      expect(snooze.status, JSON.stringify(snooze.body)).toBe(200);
      expect(snooze.body).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE', snoozedUntil: '2026-10-01', snoozeReason: reason });
      expect(snooze.body.snoozes).toEqual([{ userId: s.f.users.chefA, userName: 'Chaima Chef-A', until: '2026-10-01', reason }]);
      expect((await s.chefA.get(`/maintenance-plans/${planId}`)).body.status).toBe('EN_RETARD');
      expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('ACTIVE');
      // Les autres destinataires voient le report (motif et auteur), sans être reportés eux-mêmes.
      const adminView = (await s.admin.get(`/alerts/${alertId}`)).body;
      expect(adminView.snoozedUntil).toBeNull();
      expect(adminView.snoozes).toEqual([{ userId: s.f.users.chefA, userName: 'Chaima Chef-A', until: '2026-10-01', reason }]);
      // Filtre « Reportées ».
      expect((await s.chefA.get('/alerts?snoozed=only')).body.items.map((a: { id: string }) => a.id)).toEqual([alertId]);
      expect((await s.chefA.get('/alerts?snoozed=exclude')).body.items.map((a: { id: string }) => a.id)).not.toContain(alertId);
      expect((await s.admin.get('/alerts?snoozed=only')).body.items).toEqual([]);
      expect((await s.chefA.get('/alerts/counts')).body.snoozed).toBe(1);
      // Le recalcul ne résout pas l'alerte et ne retire pas le report (pas d'escalade).
      await t.app.get(MaintenancePlansService).recomputeAll(s.f.organizationId);
      expect((await s.chefA.get(`/alerts/${alertId}`)).body).toMatchObject({ status: 'ACTIVE', snoozedUntil: '2026-10-01' });
      const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'alerte.report', objectId: alertId } });
      expect(audit.actorUserId).toBe(s.f.users.chefA);
      expect(audit.reason).toBe(reason);

      // Validation du report : date future bornée (D-252), motif obligatoire.
      const today = await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-09-24', reason });
      expect(today.status).toBe(422);
      expect(today.body.code).toBe('REPORT_DATE_NON_FUTURE');
      const tooLong = await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-12-24', reason });
      expect(tooLong.status).toBe(422);
      expect(tooLong.body.code).toBe('REPORT_TROP_LONG');
      expect((await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-10-01' })).status).toBe(422);
      const blank = await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-10-01', reason: '     ' });
      expect(blank.status).toBe(422);
      expect(blank.body.code).toBe('MOTIF_REQUIS');
      expect((await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '01/10/2026', reason })).status).toBe(422);

      // Le lecteur voit et marque « lu » pour lui-même, mais ne reporte pas.
      expect((await s.lecteurA.get(`/alerts/${alertId}`)).body.canSnooze).toBe(false);
      expect((await s.lecteurA.post(`/alerts/${alertId}/read`)).status).toBe(200);
      expect((await s.lecteurA.post(`/alerts/${alertId}/snooze`, { until: '2026-10-01', reason })).status).toBe(403);
      // L'opérateur peut reporter une alerte d'entretien de sa société.
      expect((await s.operateurA.post(`/alerts/${alertId}/snooze`, { until: '2026-09-30', reason: 'Pièce commandée' })).status).toBe(200);

      const unsnoozed = await s.chefA.post(`/alerts/${alertId}/unsnooze`);
      expect(unsnoozed.status).toBe(200);
      expect(unsnoozed.body).toMatchObject({ status: 'ACTIVE', snoozedUntil: null, snoozeReason: null });
      expect(unsnoozed.body.snoozes.map((x: { userId: string }) => x.userId)).toEqual([s.f.users.operateurA]);
      expect((await s.chefA.get(`/maintenance-plans/${planId}`)).body.status).toBe('EN_RETARD');
    });

    it('cloisonnement et visibilité par rôle : le chef B ne voit ni ne compte les alertes de A ; 404 hors périmètre ; conducteur 403', async () => {
      const a = await overdueOilChange(s, 'A');
      const b = await overdueOilChange(s, 'B');
      const fuel = await t.app.get(AlertsService).raise({
        organizationId: s.f.organizationId,
        companyId: s.f.companies.A,
        type: 'CARBURANT_BAISSE_ANORMALE',
        severity: 'URGENT',
        objectType: 'FuelEvent',
        objectId: a.vehicleId,
        vehicleId: a.vehicleId,
        occurrenceKey: 'evenement-1',
        title: 'Baisse anormale de carburant',
        message: 'Baisse de niveau à l’arrêt.',
        condition: { liters: '12.5' },
        actionPath: '/carburant',
      });
      // D-248 : unité non mappée (libellé potentiellement nominatif, fournisseur partagé) réservée à l'administrateur.
      const unmapped = await t.app.get(AlertsService).raise({
        organizationId: s.f.organizationId,
        companyId: s.f.companies.A,
        type: 'GPS_UNITE_NON_MAPPEE',
        severity: 'INFO',
        objectType: 'TelemetryUnit',
        objectId: a.planId,
        occurrenceKey: 'non-associee',
        title: 'Unité télématique non associée',
        message: 'L’unité « Karim B. — camion 3 » n’est associée à aucun véhicule.',
        condition: {},
        actionPath: '/telematique/unites',
      });

      const chefBList = await s.chefB.get('/alerts');
      expect(chefBList.status).toBe(200);
      const chefBIds = chefBList.body.items.map((x: { id: string; companyId: string }) => x.id);
      expect(chefBIds).toContain(b.alertId);
      expect(chefBIds).not.toContain(a.alertId);
      expect(chefBIds).not.toContain(fuel);
      expect(chefBList.body.items.every((x: { companyId: string }) => x.companyId === s.f.companies.B)).toBe(true);
      const chefBCounts = (await s.chefB.get('/alerts/counts')).body;
      const bActive = await t.prisma.client.alert.count({ where: { organizationId: s.f.organizationId, companyId: s.f.companies.B, status: 'ACTIVE' } });
      expect(chefBCounts.total).toBe(bActive);
      expect(chefBCounts.total).toBe(chefBList.body.total);
      expect(chefBCounts.bySeverity).toEqual({ CRITIQUE: 1, URGENT: 0, ATTENTION: 0, INFO: 0 });
      // Non lues et reportées : comptées dans le seul périmètre de B.
      expect(chefBCounts.unread).toBe(bActive);
      expect(chefBCounts.snoozed).toBe(0);
      // L'identifiant d'une alerte de A est introuvable pour le chef B, en lecture comme en action.
      for (const res of [
        await s.chefB.get(`/alerts/${a.alertId}`),
        await s.chefB.post(`/alerts/${a.alertId}/read`),
        await s.chefB.post(`/alerts/${a.alertId}/unread`),
        await s.chefB.post(`/alerts/${a.alertId}/snooze`, { until: '2026-10-01', reason: 'Hors périmètre' }),
        await s.chefB.post(`/alerts/${a.alertId}/unsnooze`),
        await s.chefB.get(`/alerts?companyId=${s.f.companies.A}`),
        await s.chefB.get(`/alerts/counts?companyId=${s.f.companies.A}`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('INTROUVABLE');
      }
      expect(await t.prisma.client.alertRecipientState.count({ where: { userId: s.f.users.chefB } })).toBe(0);

      // Chef A : ses alertes, y compris carburant, sauf l'unité non mappée ; filtre société courante et véhicule.
      const chefACounts = (await s.chefA.get('/alerts/counts')).body;
      expect(chefACounts.bySeverity).toEqual({ CRITIQUE: 1, URGENT: 1, ATTENTION: 0, INFO: 0 });
      expect(chefACounts.total).toBe(2);
      for (const agent of [s.chefA, s.lecteurA, s.operateurA]) {
        expect((await agent.get(`/alerts/${unmapped}`)).status).toBe(404);
        expect((await agent.post(`/alerts/${unmapped}/read`)).status).toBe(404);
        expect((await agent.get('/alerts?type=GPS_UNITE_NON_MAPPEE')).body.total).toBe(0);
        expect((await agent.get('/alerts/counts')).body.bySeverity.INFO).toBe(0);
      }
      expect((await s.admin.get(`/alerts/${unmapped}`)).status).toBe(200);
      expect((await s.admin.get('/alerts/counts')).body.bySeverity.INFO).toBe(1);
      const byVehicle = await s.chefA.get(`/alerts?vehicleId=${a.vehicleId}&companyId=${s.f.companies.A}`);
      expect(byVehicle.body.items.map((x: { id: string }) => x.id)).toEqual([a.alertId, fuel]);
      expect((await s.chefA.get('/alerts?severity=URGENT')).body.items.map((x: { id: string }) => x.id)).toEqual([fuel]);
      expect((await s.chefA.get('/alerts?type=CARBURANT_BAISSE_ANORMALE')).body.total).toBe(1);
      expect((await s.lecteurA.get(`/alerts/${fuel}`)).status).toBe(200);
      // Opérateur : ni GPS ni carburant (D-244), y compris dans les compteurs.
      expect((await s.operateurA.get(`/alerts/${fuel}`)).status).toBe(404);
      const opList = (await s.operateurA.get('/alerts')).body.items.map((x: { id: string }) => x.id);
      expect(opList).toContain(a.alertId);
      expect(opList).not.toContain(fuel);
      expect((await s.operateurA.get('/alerts/counts')).body.bySeverity.URGENT).toBe(0);
      // Administrateur : toute l'organisation, tri gravité puis date.
      const adminList = (await s.admin.get('/alerts')).body.items as Array<{ id: string; severity: string }>;
      expect(adminList.map((x) => x.id)).toEqual(expect.arrayContaining([a.alertId, b.alertId, fuel, unmapped]));
      const ranks = adminList.map((x) => ['INFO', 'ATTENTION', 'URGENT', 'CRITIQUE'].indexOf(x.severity));
      expect([...ranks].sort((x, y) => y - x)).toEqual(ranks);
      // Conducteur : aucune alerte (403).
      expect((await s.conducteurA.get('/alerts')).status).toBe(403);
      expect((await s.conducteurA.get('/alerts/counts')).status).toBe(403);
      expect((await s.conducteurA.get(`/alerts/${a.alertId}`)).status).toBe(403);
      expect((await s.conducteurA.post(`/alerts/${a.alertId}/read`)).status).toBe(403);
      // Alertes résolues : filtre explicite ; un report est refusé sur une alerte résolue.
      await t.app.get(AlertsService).resolve({ organizationId: s.f.organizationId, type: 'CARBURANT_BAISSE_ANORMALE', objectType: 'FuelEvent', objectId: a.vehicleId }, 'anomalie qualifiée');
      expect((await s.chefA.get('/alerts?status=RESOLUE')).body.items.map((x: { id: string }) => x.id)).toEqual([fuel]);
      const resolvedSnooze = await s.chefA.post(`/alerts/${fuel}/snooze`, { until: '2026-10-01', reason: 'Trop tard' });
      expect(resolvedSnooze.status).toBe(409);
      expect(resolvedSnooze.body.code).toBe('ALERTE_RESOLUE');
    });

    it('préférences respectées : e-mail critique désactivé, rôles sans e-mail, version optimiste', async () => {
      const defaults = await s.chefA.get('/me/notification-preferences');
      expect(defaults.status).toBe(200);
      expect(defaults.body).toMatchObject({
        emailCritical: true,
        emailDailyDigest: true,
        minimumSeverity: 'CRITIQUE',
        version: 0,
        isDefault: true,
        emailChannelConfigured: true,
        receivesEmails: true,
        immediateSeverities: ['CRITIQUE'],
        dailyDigestLocalTime: '08:00',
      });
      expect((await s.operateurA.get('/me/notification-preferences')).body.receivesEmails).toBe(false);
      expect((await s.conducteurA.get('/me/notification-preferences')).status).toBe(403);
      expect((await s.conducteurA.put('/me/notification-preferences', { emailCritical: true, emailDailyDigest: true, minimumSeverity: 'CRITIQUE', expectedVersion: 0 })).status).toBe(403);

      const updated = await s.chefA.put('/me/notification-preferences', { emailCritical: false, emailDailyDigest: false, minimumSeverity: 'CRITIQUE', expectedVersion: 0 });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body).toMatchObject({ emailCritical: false, emailDailyDigest: false, version: 1, isDefault: false });
      const stale = await s.chefA.put('/me/notification-preferences', { emailCritical: true, emailDailyDigest: true, minimumSeverity: 'CRITIQUE', expectedVersion: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_OBSOLETE');
      expect((await s.chefA.put('/me/notification-preferences', { emailCritical: 'oui', emailDailyDigest: true, minimumSeverity: 'GRAVE', expectedVersion: 1 })).status).toBe(422);
      expect(await t.prisma.client.auditEvent.count({ where: { action: 'notifications.preferences.modification', actorUserId: s.f.users.chefA } })).toBe(1);
      expect(updated.body.immediateSeverities).toEqual([]);

      // Chef A a refusé l'e-mail critique : seul l'administrateur est mis en file.
      const { alertId } = await overdueOilChange(s, 'A');
      const rows = await t.prisma.client.notificationOutbox.findMany({ where: { alertId } });
      expect(rows.map((r) => r.recipientUserId)).toEqual([s.f.users.admin]);

      // Gravité minimale configurable (D-245, R-9.4-04) : chef A abaisse à URGENT et réactive l'e-mail immédiat.
      const urgentPref = await s.chefA.put('/me/notification-preferences', { emailCritical: true, emailDailyDigest: false, minimumSeverity: 'URGENT', expectedVersion: 1 });
      expect(urgentPref.status, JSON.stringify(urgentPref.body)).toBe(200);
      expect(urgentPref.body).toMatchObject({ minimumSeverity: 'URGENT', version: 2, immediateSeverities: ['CRITIQUE', 'URGENT'] });
      const due = await overdueOilChange(s, 'A', { stopAtDue: true });
      expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: due.alertId } })).severity).toBe('URGENT');
      // URGENT : chef A seulement ; l'administrateur (défaut CRITIQUE) n'est pas notifié immédiatement.
      const urgentRows = await t.prisma.client.notificationOutbox.findMany({ where: { alertId: due.alertId } });
      expect(urgentRows.map((r) => [r.recipientUserId, r.subject])).toEqual([[s.f.users.chefA, `[Parc Auto] Alerte urgente — Échéance d’entretien — ${due.vehicleCode}`]]);
      expect(urgentRows[0]?.dedupeKey.endsWith(':URGENT')).toBe(true);
      const notifications = t.app.get(NotificationsService);
      expect(await notifications.authorizeDelivery(urgentRows[0]?.id ?? '')).toEqual({ allowed: true });
      // Escalade en CRITIQUE : une ligne de plus pour chef A (nouvelle gravité) et une pour l'administrateur.
      await reading(s.chefA, due.vehicleId, '90200', '2026-09-24T08:00:00Z');
      const escalated = await t.prisma.client.notificationOutbox.findMany({ where: { alertId: due.alertId } });
      expect(escalated).toHaveLength(3);
      expect(escalated.filter((r) => r.recipientUserId === s.f.users.chefA).map((r) => r.dedupeKey.split(':').pop()).sort()).toEqual(['CRITIQUE', 'URGENT']);
      expect(escalated.filter((r) => r.recipientUserId === s.f.users.admin).map((r) => r.dedupeKey.split(':').pop())).toEqual(['CRITIQUE']);
      // La ligne URGENT non encore envoyée est remplacée par celle de la nouvelle gravité (contenu revérifié, D-261).
      expect(await notifications.authorizeDelivery(urgentRows[0]?.id ?? '')).toEqual({ allowed: false, reason: 'Gravité de l’alerte modifiée depuis la mise en file.' });
      const chefCritical = escalated.find((r) => r.recipientUserId === s.f.users.chefA && r.dedupeKey.endsWith(':CRITIQUE'));
      expect(await notifications.authorizeDelivery(chefCritical?.id ?? '')).toEqual({ allowed: true });
      // E-mail immédiat désactivé avant l'envoi : la ligne CRITIQUE de chef A est refusée à la revérification.
      expect((await s.chefA.put('/me/notification-preferences', { emailCritical: false, emailDailyDigest: false, minimumSeverity: 'URGENT', expectedVersion: 2 })).status).toBe(200);
      expect(await notifications.authorizeDelivery(chefCritical?.id ?? '')).toEqual({ allowed: false, reason: 'Préférence du destinataire ou gravité incompatible avec un envoi immédiat.' });

      // Récapitulatif : chef A l'a désactivé ; l'administrateur le reçoit.
      t.clock.set('2026-09-25T07:05:00.000Z');
      const digest = await notifications.buildDailyDigest(s.f.organizationId, '2026-09-25');
      expect(digest).toMatchObject({ outcome: 'TRAITE', created: 1, optedOut: 1 });
      const digests = await t.prisma.client.notificationOutbox.findMany({ where: { kind: 'RECAPITULATIF_QUOTIDIEN' } });
      expect(digests.map((d) => d.recipientUserId)).toEqual([s.f.users.admin]);
    });

    it('récapitulatif quotidien : une ligne par utilisateur et date locale, jamais avant l’heure ni pour un autre jour, sans alerte reportée', async () => {
      const a = await overdueOilChange(s, 'A');
      const b = await overdueOilChange(s, 'B');
      // L'administrateur reporte l'alerte de B : elle sort de son récapitulatif, pas de celui du chef B.
      expect((await s.admin.post(`/alerts/${b.alertId}/snooze`, { until: '2026-10-01', reason: 'Véhicule en attente de cession' })).status).toBe(200);
      const notifications = t.app.get(NotificationsService);

      t.clock.set('2026-09-25T06:30:00.000Z'); // 07:30 à Tunis
      expect(await notifications.buildDailyDigest(s.f.organizationId, '2026-09-25')).toMatchObject({ outcome: 'TROP_TOT', created: 0 });
      expect(await t.prisma.client.notificationOutbox.count({ where: { kind: 'RECAPITULATIF_QUOTIDIEN' } })).toBe(0);

      t.clock.set('2026-09-25T07:05:00.000Z'); // 08:05 à Tunis
      const first = await notifications.buildDailyDigest(s.f.organizationId, '2026-09-25');
      expect(first).toMatchObject({ outcome: 'TRAITE', created: 3, alreadyQueued: 0 });
      const again = await Promise.all(Array.from({ length: 5 }, () => notifications.buildDailyDigest(s.f.organizationId, '2026-09-25')));
      expect(again.reduce((n, r) => n + r.created, 0)).toBe(0);
      for (let i = 0; i < 5; i += 1) expect((await notifications.buildDailyDigest(s.f.organizationId, '2026-09-25')).alreadyQueued).toBe(3);

      const rows = await t.prisma.client.notificationOutbox.findMany({ where: { kind: 'RECAPITULATIF_QUOTIDIEN' } });
      expect(rows).toHaveLength(3);
      const byUser = new Map(rows.map((r) => [r.recipientUserId, r]));
      expect([...byUser.keys()].sort()).toEqual([s.f.users.admin, s.f.users.chefA, s.f.users.chefB].sort());
      for (const r of rows) {
        expect(r.dedupeKey).toBe(`digest:${r.recipientUserId}:2026-09-25`);
        expect(r.companyId).toBeNull();
        expect(r.status).toBe('EN_ATTENTE');
        expect(r.subject).toContain('Récapitulatif du 25/09/2026');
        expect(r.bodyText).toContain(`Centre d’alertes : ${TEST_ORIGIN}/alertes`);
        expect(r.bodyText).not.toMatch(/TND|Karim|Nour|\.pdf/);
      }
      const chefABody = byUser.get(s.f.users.chefA)?.bodyText ?? '';
      expect(chefABody).toContain(a.vehicleCode);
      expect(chefABody).not.toContain(b.vehicleCode);
      const chefBBody = byUser.get(s.f.users.chefB)?.bodyText ?? '';
      expect(chefBBody).toContain(b.vehicleCode);
      expect(chefBBody).not.toContain(a.vehicleCode);
      const adminBody = byUser.get(s.f.users.admin)?.bodyText ?? '';
      expect(adminBody).toContain(a.vehicleCode);
      expect(adminBody).not.toContain(b.vehicleCode);

      // Jour passé : abandonné ; jour futur : jamais anticipé.
      expect(await notifications.buildDailyDigest(s.f.organizationId, '2026-09-24')).toMatchObject({ outcome: 'JOUR_PASSE', created: 0 });
      expect(await notifications.buildDailyDigest(s.f.organizationId, '2026-09-26')).toMatchObject({ outcome: 'JOUR_FUTUR', created: 0 });
      // Envoyable le jour qu'il couvre ; le lendemain, un récapitulatif resté en file est abandonné (D-262).
      const adminDigest = byUser.get(s.f.users.admin);
      expect(await notifications.authorizeDelivery(adminDigest?.id ?? '')).toEqual({ allowed: true });
      // Le lendemain : une nouvelle ligne par destinataire.
      t.clock.set('2026-09-26T09:00:00.000Z');
      expect(await notifications.authorizeDelivery(adminDigest?.id ?? '')).toEqual({ allowed: false, reason: 'Récapitulatif d’un autre jour : abandonné (D-262).' });
      expect(await notifications.buildDailyDigest(s.f.organizationId, '2026-09-26')).toMatchObject({ outcome: 'TRAITE', created: 3 });
      expect(await t.prisma.client.notificationOutbox.count({ where: { kind: 'RECAPITULATIF_QUOTIDIEN' } })).toBe(6);
    });

    it('état de l’outbox (administrateur) : compteurs exacts, tentatives, prochaine tentative, erreur expurgée, corps jamais exposé', async () => {
      const { alertId } = await overdueOilChange(s, 'A');
      const adminRow = await t.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId, recipientUserId: s.f.users.admin } });
      // État laissé par une tentative d'envoi en échec (panne SMTP) : reprise programmée.
      await t.prisma.client.notificationOutbox.update({
        where: { id: adminRow.id },
        data: { status: 'ECHEC', attempts: 1, nextAttemptAt: new Date('2026-09-24T10:01:00.000Z'), lastError: 'Invalid login: 535 5.7.8 for smtp://relay:hunter2@mail.example AUTH PLAIN AGFsaWNlAHNlY3JldA==' },
      });

      const status = await s.admin.get('/notifications/status');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        emailChannelConfigured: true,
        message: 'Canal e-mail configuré',
        outbox: { EN_ATTENTE: 1, EN_COURS: 0, ENVOYE: 0, ECHEC: 1, ABANDONNE: 0, ANNULE: 0 },
        lastSentAt: null,
      });
      const failed = await s.admin.get('/notifications/outbox?status=ECHEC');
      expect(failed.status).toBe(200);
      expect(failed.body.total).toBe(1);
      const entry = failed.body.items[0];
      expect(entry).toMatchObject({ id: adminRow.id, kind: 'ALERTE_CRITIQUE', status: 'ECHEC', attempts: 1, maxAttempts: 8, nextAttemptAt: '2026-09-24T10:01:00.000Z', alertId, sentAt: null });
      expect(entry.lastError).toContain('[expurgé]');
      expect(entry.lastError).not.toContain('hunter2');
      expect(entry.lastError).not.toContain('AGFsaWNlAHNlY3JldA==');
      expect(entry).not.toHaveProperty('bodyText');
      const all = await s.admin.get('/notifications/outbox?page=1&pageSize=1');
      expect(all.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(all.body.items).toHaveLength(1);

      expect((await s.chefA.get('/notifications/status')).status).toBe(403);
      expect((await s.chefA.get('/notifications/outbox')).status).toBe(403);
      expect((await s.chefB.get('/notifications/outbox')).status).toBe(403);
    });

    it('revérification avant envoi (D-261) : report, habilitation retirée, compte désactivé ou alerte résolue → refus motivé', async () => {
      const { alertId, planId } = await overdueOilChange(s, 'A');
      const notifications = t.app.get(NotificationsService);
      const adminRow = await t.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId, recipientUserId: s.f.users.admin } });
      const chefRow = await t.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId, recipientUserId: s.f.users.chefA } });
      expect(await notifications.authorizeDelivery(adminRow.id)).toEqual({ allowed: true });
      expect(await notifications.authorizeDelivery(chefRow.id)).toEqual({ allowed: true });

      // Report du chef A : son e-mail n'est plus dû ; celui de l'administrateur l'est toujours.
      expect((await s.chefA.post(`/alerts/${alertId}/snooze`, { until: '2026-09-30', reason: 'Vidange prévue le 30' })).status).toBe(200);
      expect(await notifications.authorizeDelivery(chefRow.id)).toEqual({ allowed: false, reason: 'Alerte reportée par le destinataire.' });
      expect(await notifications.authorizeDelivery(adminRow.id)).toEqual({ allowed: true });
      expect((await s.chefA.post(`/alerts/${alertId}/unsnooze`)).status).toBe(200);
      expect(await notifications.authorizeDelivery(chefRow.id)).toEqual({ allowed: true });

      // Habilitation retirée (chef A devient lecteur de A), puis compte désactivé.
      await t.prisma.client.membership.updateMany({ where: { userId: s.f.users.chefA, companyId: s.f.companies.A }, data: { role: 'LECTEUR' } });
      expect(await notifications.authorizeDelivery(chefRow.id)).toEqual({ allowed: false, reason: 'Droits révoqués : le destinataire n’est plus chef de parc ni administrateur.' });
      expect((await s.admin.post(`/users/${s.f.users.chefA}/disable`, { reason: 'Départ de l’entreprise' })).status).toBe(200);
      expect(await notifications.authorizeDelivery(chefRow.id)).toEqual({ allowed: false, reason: 'Droits révoqués : compte du destinataire désactivé.' });

      // Alerte résolue avant l'envoi : plus d'e-mail d'alerte critique.
      await t.app.get(AlertsService).resolve({ organizationId: s.f.organizationId, type: 'ENTRETIEN_ECHEANCE', objectType: 'VehicleMaintenancePlan', objectId: planId }, 'entretien réalisé');
      expect(await notifications.authorizeDelivery(adminRow.id)).toEqual({ allowed: false, reason: 'Alerte résolue avant l’envoi.' });

      // Condition revenue (réactivation de la même ligne, D-251) : l'ancien message est obsolète, un nouveau
      // est mis en file pour la nouvelle activation (chef A, désactivé, n'en reçoit plus).
      t.clock.advance(5 * 60_000);
      await t.app.get(MaintenancePlansService).syncAlerts(planId);
      expect(await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } })).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE' });
      expect(await notifications.authorizeDelivery(adminRow.id)).toEqual({ allowed: false, reason: 'Alerte réactivée depuis la mise en file : un nouveau message la remplace.' });
      const renewed = await t.prisma.client.notificationOutbox.findMany({ where: { alertId, id: { notIn: [adminRow.id, chefRow.id] } } });
      expect(renewed.map((r) => r.recipientUserId)).toEqual([s.f.users.admin]);
      expect(await notifications.authorizeDelivery(renewed[0]?.id ?? '')).toEqual({ allowed: true });
    });
  });

  describe('sans SMTP (T29, D-263)', () => {
    let t: TestApp;
    let s: Scenario;

    beforeAll(async () => {
      t = await startTestApp({ now: NOW });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      s = await prepare(t);
    });

    it('alertes internes disponibles, aucune ligne d’outbox, statut exact « Canal e-mail non configuré »', async () => {
      const { alertId } = await overdueOilChange(s, 'A');
      const list = await s.chefA.get('/alerts');
      expect(list.status).toBe(200);
      expect(list.body.items.map((x: { id: string }) => x.id)).toContain(alertId);
      expect((await s.chefA.get('/alerts/counts')).body.bySeverity.CRITIQUE).toBe(1);
      expect((await s.chefA.post(`/alerts/${alertId}/read`)).status).toBe(200);

      const notifications = t.app.get(NotificationsService);
      expect(notifications.emailChannelConfigured()).toBe(false);
      expect(await notifications.enqueueCriticalAlert(alertId)).toBe(0);
      t.clock.set('2026-09-25T07:05:00.000Z');
      expect(await notifications.buildDailyDigest(s.f.organizationId, '2026-09-25')).toMatchObject({ outcome: 'CANAL_NON_CONFIGURE', created: 0 });
      expect(await t.prisma.client.notificationOutbox.count()).toBe(0);
      expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } })).emailNotifiedSeverity).toBeNull();

      const admin = await login(t.server, s.f.emails.admin, DEFAULT_PASSWORD);
      const status = await admin.get('/notifications/status');
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        emailChannelConfigured: false,
        message: 'Canal e-mail non configuré',
        outbox: { EN_ATTENTE: 0, EN_COURS: 0, ENVOYE: 0, ECHEC: 0, ABANDONNE: 0, ANNULE: 0 },
        oldestPendingAt: null,
        lastSentAt: null,
      });
      expect((await admin.get('/notifications/outbox')).body).toMatchObject({ items: [], total: 0 });
      expect((await admin.get('/me/notification-preferences')).body.emailChannelConfigured).toBe(false);
    });
  });
});
