import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

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
    expect(byKey['odometer.staleAfterDays'].editable).toBe(true);
  });

  it('versionne et audite chaque modification ; surcharge société explicite ; réservé à l’administrateur', async () => {
    expect((await chefA.put('/settings/odometer.staleAfterDays', { value: 10, reason: 'essai' })).status).toBe(403);
    const invalid = await admin.put('/settings/odometer.staleAfterDays', { value: 0, reason: 'valeur hors bornes' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.fieldErrors).toEqual({ value: ['valeur minimale 1 jours.'] });
    // Champs absents ou trop courts : messages par champ en français, jamais ceux de class-validator (CDC 10.1).
    const missing = await admin.put('/settings/odometer.staleAfterDays', { reason: 'x' });
    expect(missing.status).toBe(422);
    expect(missing.body.fieldErrors).toEqual({ value: ['Ce champ est obligatoire.'], reason: ['Longueur minimale non respectée.'] });
    const v1 =await admin.put('/settings/odometer.staleAfterDays', { value: 10, reason: 'politique groupe' });
    expect(v1.body).toMatchObject({ value: 10, source: 'groupe', settingVersion: 1 });
    const v2 = await admin.put('/settings/odometer.staleAfterDays', { value: 14, reason: 'révision' });
    expect(v2.body.settingVersion).toBe(2);
    const override = await admin.put('/settings/odometer.staleAfterDays', { value: 3, companyId: f.companies.A, reason: 'parc urbain' });
    expect(override.body).toMatchObject({ value: 3, source: 'societe' });
    expect((await admin.put('/settings/session.ttlHours', { value: 8, companyId: f.companies.A, reason: 'x y z' })).status).toBe(422);
    // Montant en TND : trois décimales au plus (17.1) ; refus par champ, rien n'est enregistré.
    const tooPrecise = await admin.put('/settings/fuel.amountToleranceTnd', { value: 0.1255, reason: 'part fixe trop précise' });
    expect(tooPrecise.status).toBe(422);
    expect(tooPrecise.body.fieldErrors).toEqual({ value: ['3 décimales au plus.'] });
    expect(await t.prisma.client.settingValue.count({ where: { organizationId: f.organizationId, key: 'fuel.amountToleranceTnd' } })).toBe(0);
    expect((await admin.put('/settings/fuel.amountToleranceTnd', { value: 0.125, reason: 'part fixe au millime' })).body).toMatchObject({ value: 0.125, source: 'groupe' });
    const history = await admin.get('/settings/odometer.staleAfterDays/history');
    expect(history.body).toHaveLength(3);
    // Trois versions du kilométrage ancien et une de la part fixe en TND ; aucun refus n'est tracé.
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'parametre.modification' } })).toBe(4);
    // la surcharge société s'applique réellement à la fraîcheur (synthèse véhicule et compteur courant)
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const segment = await t.prisma.client.odometerSegment.create({ data: { organizationId: f.organizationId, vehicleId, sequence: 1, startedAt: new Date('2026-01-01T00:00:00Z'), startPhysicalKm: '0', startCumulativeKm: '0' } });
    await t.prisma.client.odometerReading.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, segmentId: segment.id, source: 'MANUAL', context: 'RELEVE_LIBRE', status: 'ACCEPTE', physicalKm: '1000', cumulativeKm: '1000', observedAt: new Date('2026-09-20T08:00:00Z') } });
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.freshness).toBe('A_ACTUALISER');
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.freshness).toBe('A_ACTUALISER');
    await admin.delete('/settings/odometer.staleAfterDays/override').send({ companyId: f.companies.A, reason: 'retour au groupe' });
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.freshness).toBe('A_JOUR');
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.freshness).toBe('A_JOUR');
  });

  it('audit avant/après : acteur, motif, valeur remplacée et nouvelle version ; retrait de surcharge : valeur qui s’applique ensuite ; verrou optimiste', async () => {
    const auditOf = async (action: string) => t.prisma.client.auditEvent.findMany({ where: { organizationId: f.organizationId, action }, orderBy: { createdAt: 'asc' } });

    // Valeur groupe : avant = défaut du produit (7), après = 10, version 1.
    const group = await admin.put('/settings/odometer.staleAfterDays', { value: 10, reason: 'politique groupe', expectedVersion: 0 });
    expect(group.status).toBe(200);
    expect(group.body).toMatchObject({ value: 10, source: 'groupe', settingVersion: 1, editable: true });
    let events = await auditOf('parametre.modification');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'UTILISATEUR', actorUserId: f.users.admin, objectType: 'Setting', companyId: null, reason: 'politique groupe', before: { key: 'odometer.staleAfterDays', value: 7, settingVersion: null }, after: { key: 'odometer.staleAfterDays', value: 10, settingVersion: 1 } });

    // Surcharge société : avant = valeur groupe qui s'appliquait à la société (10), pas le défaut.
    const override = await admin.put('/settings/odometer.staleAfterDays', { value: 3, companyId: f.companies.A, reason: 'parc urbain', expectedVersion: 0 });
    expect(override.body).toMatchObject({ value: 3, source: 'societe', settingVersion: 1 });
    events = await auditOf('parametre.modification');
    expect(events[1]).toMatchObject({ actorUserId: f.users.admin, companyId: f.companies.A, reason: 'parc urbain', before: { value: 10, settingVersion: null }, after: { value: 3, settingVersion: 1 } });

    // Verrou optimiste : version attendue périmée → 409, rien n'est écrit.
    const stale = await admin.put('/settings/odometer.staleAfterDays', { value: 12, reason: 'révision concurrente', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');
    expect(await t.prisma.client.settingValue.count({ where: { organizationId: f.organizationId, key: 'odometer.staleAfterDays', companyId: null } })).toBe(1);
    const v2 = await admin.put('/settings/odometer.staleAfterDays', { value: 14, reason: 'révision', expectedVersion: 1 });
    expect(v2.body).toMatchObject({ value: 14, settingVersion: 2 });

    // Deux écritures simultanées du même niveau : une seule aboutit, l'autre reçoit 409 (jamais 500).
    const concurrent = await Promise.all([
      admin.put('/settings/maintenance.noticeKm', { value: 800, reason: 'écriture simultanée 1', expectedVersion: 0 }),
      admin.put('/settings/maintenance.noticeKm', { value: 900, reason: 'écriture simultanée 2', expectedVersion: 0 }),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.client.settingValue.count({ where: { organizationId: f.organizationId, key: 'maintenance.noticeKm', isCurrent: true } })).toBe(1);

    // Retrait de la surcharge : version attendue vérifiée, audit avec la valeur groupe qui s'applique désormais.
    expect((await admin.delete('/settings/odometer.staleAfterDays/override').send({ companyId: f.companies.A, reason: 'retour au groupe', expectedVersion: 2 })).status).toBe(409);
    const cleared = await admin.delete('/settings/odometer.staleAfterDays/override').send({ companyId: f.companies.A, reason: 'retour au groupe', expectedVersion: 1 });
    expect(cleared.status).toBe(200);
    const removal = await auditOf('parametre.surcharge_retiree');
    expect(removal).toHaveLength(1);
    expect(removal[0]).toMatchObject({
      actorType: 'UTILISATEUR',
      actorUserId: f.users.admin,
      companyId: f.companies.A,
      reason: 'retour au groupe',
      before: { key: 'odometer.staleAfterDays', value: 3, source: 'societe', settingVersion: 1 },
      after: { key: 'odometer.staleAfterDays', value: 14, source: 'groupe', settingVersion: 2 },
    });
    const effectiveA = ((await admin.get(`/settings?companyId=${f.companies.A}`)).body as Array<{ key: string; value: unknown; source: string }>).find((x) => x.key === 'odometer.staleAfterDays');
    expect(effectiveA).toMatchObject({ value: 14, source: 'groupe' });

    // Sans surcharge en vigueur : 404, rien n'est tracé ; société d'une autre organisation : 404 ; paramètre sans surcharge société : 422.
    const again = await admin.delete('/settings/odometer.staleAfterDays/override').send({ companyId: f.companies.A, reason: 'retour au groupe' });
    expect(again.status).toBe(404);
    expect(await auditOf('parametre.surcharge_retiree')).toHaveLength(1);
    const foreign = await seedFixture(t.prisma);
    expect((await admin.put('/settings/odometer.staleAfterDays', { value: 5, companyId: foreign.companies.A, reason: 'hors organisation' })).status).toBe(404);
    expect((await admin.delete('/settings/alerts.catchUpIntervalMinutes/override').send({ companyId: f.companies.A, reason: 'non surchargeable' })).status).toBe(422);

    // Retrait sans valeur groupe : la société revient au défaut du produit, tracé comme tel.
    await admin.put('/settings/usage.lateReturnToleranceMinutes', { value: 20, companyId: f.companies.B, reason: 'tolérance B' });
    await admin.delete('/settings/usage.lateReturnToleranceMinutes/override').send({ companyId: f.companies.B, reason: 'fin de tolérance' });
    const toDefault = (await auditOf('parametre.surcharge_retiree')).at(-1);
    expect(toDefault).toMatchObject({ companyId: f.companies.B, before: { value: 20 }, after: { value: 0, source: 'defaut', settingVersion: null } });

    // Historique : auteur nommé, motif, version courante signalée, par niveau.
    const history = (await admin.get('/settings/odometer.staleAfterDays/history')).body as Array<{ companyId: string | null; settingVersion: number; isCurrent: boolean; reason: string; createdByName: string }>;
    expect(history).toHaveLength(3);
    expect(history.every((h) => h.createdByName === 'Alice Admin')).toBe(true);
    expect(history.filter((h) => h.companyId === null).map((h) => [h.settingVersion, h.isCurrent, h.reason])).toEqual([
      [2, true, 'révision'],
      [1, false, 'politique groupe'],
    ]);
    expect(history.find((h) => h.companyId === f.companies.A)).toMatchObject({ settingVersion: 1, isCurrent: false });
    expect((await chefA.get('/settings/odometer.staleAfterDays/history')).status).toBe(403);
    expect((await admin.get('/settings/inconnu.parametre/history')).status).toBe(404);

    // Le journal d'audit restitue ces événements (acteur, motif, avant/après) à l'administrateur.
    const journal = await admin.get('/audit?action=parametre.&pageSize=100');
    expect(journal.status).toBe(200);
    expect(journal.body.items.filter((e: { action: string }) => e.action.startsWith('parametre.')).length).toBe((await auditOf('parametre.modification')).length + (await auditOf('parametre.surcharge_retiree')).length);
  });

  it('pagination : bornes fixes du contrat de l’API, affichées mais non modifiables et sans effet si une ligne existe en base', async () => {
    const list = (await admin.get('/settings')).body as Array<{ key: string; value: number; source: string; editable: boolean }>;
    expect(list.find((s) => s.key === 'pagination.defaultPageSize')).toMatchObject({ value: 25, source: 'defaut', editable: false });
    expect(list.find((s) => s.key === 'pagination.maxPageSize')).toMatchObject({ value: 100, source: 'defaut', editable: false });
    const refused = await admin.put('/settings/pagination.maxPageSize', { value: 50, reason: 'réduction des pages' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('PARAMETRE_NON_MODIFIABLE');
    expect(refused.body.message).toContain('CDC 15.1');
    expect(await t.prisma.client.auditEvent.count({ where: { organizationId: f.organizationId, action: { startsWith: 'parametre.' } } })).toBe(0);
    // Une valeur écrite par un autre chemin (version antérieure) n'a aucun effet : l'API borne toujours à 100.
    await t.prisma.client.settingValue.create({ data: { organizationId: f.organizationId, key: 'pagination.maxPageSize', value: 50, settingVersion: 1, isCurrent: true, reason: 'ancienne valeur' } });
    expect(((await admin.get('/settings')).body as Array<{ key: string; value: number; source: string }>).find((s) => s.key === 'pagination.maxPageSize')).toMatchObject({ value: 100, source: 'defaut' });
    expect((await admin.get('/audit?pageSize=100')).status).toBe(200);
    expect((await admin.get('/audit?pageSize=101')).status).toBe(422);
  });

  it('durée de session : le paramètre session.ttlHours fixe l’échéance des nouvelles connexions ; les sessions ouvertes gardent la leur', async () => {
    const before = await chefA.get('/auth/session');
    expect(before.body.sessionExpiresAt).toBe('2026-09-24T22:00:00.000Z'); // 12 h par défaut (CDC 16.1)
    expect((await admin.put('/settings/session.ttlHours', { value: 0, reason: 'hors bornes' })).status).toBe(422);
    const changed = await admin.put('/settings/session.ttlHours', { value: 2, reason: 'postes partagés', expectedVersion: 0 });
    expect(changed.body).toMatchObject({ value: 2, source: 'groupe' });

    const res = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.lecteurA, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.find((c) => c.startsWith('pa_session='))).toMatch(/Max-Age=7200/);
    const lecteur = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    expect((await lecteur.get('/auth/session')).body.sessionExpiresAt).toBe('2026-09-24T12:00:00.000Z');

    // Deux heures et une minute plus tard : la nouvelle session a expiré, celle ouverte avant la modification reste valide.
    t.clock.set('2026-09-24T12:01:00.000Z');
    expect((await lecteur.get('/auth/session')).status).toBe(401);
    expect((await chefA.get('/auth/session')).status).toBe(200);
  });
});
