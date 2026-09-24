import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_DOCUMENT_TYPES, INITIAL_MAINTENANCE_TYPES } from '../../src/domain/initial-catalog.js';
import { DocumentsService } from '../../src/modules/documents/documents.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Catalogue initial livré (CDC 6.1, 7.1) : installation par l'administrateur, en production, idempotente et
 * auditée, sans rien forcer (les éléments existants ne sont jamais modifiés ; rien n'est rendu requis ou
 * bloquant d'office).
 */
describe('Catalogue initial des opérations d’entretien et des types de documents (CDC 6.1, 7.1)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;

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
  });

  it('opérations d’entretien : installées par l’administrateur, auditées, puis rejouables sans effet ; chef refusé', async () => {
    expect((await chefA.post('/maintenance-types/initial-catalog')).status).toBe(403);
    expect(await t.prisma.client.maintenanceType.count()).toBe(0);

    const first = await admin.post('/maintenance-types/initial-catalog');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.skipped).toEqual([]);
    expect(first.body.created.map((c: { code: string }) => c.code).sort()).toEqual(INITIAL_MAINTENANCE_TYPES.map((c) => c.code).sort());
    const labels = (await chefA.get('/maintenance-types')).body.map((c: { label: string }) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Vidange moteur', 'Filtres', 'Freins', 'Pneus', 'Courroie', 'Batterie', 'Contrôle technique interne', 'Autre opération']));
    // Aucun intervalle universel n'est imposé : ce sont des opérations, pas des plans.
    expect(await t.prisma.client.vehicleMaintenancePlan.count()).toBe(0);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'type_entretien.creation', reason: 'Installation du catalogue initial' } })).toBe(INITIAL_MAINTENANCE_TYPES.length);
    const summary = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'type_entretien.catalogue_initial' } });
    expect(summary.actorUserId).toBe(f.users.admin);

    const again = await admin.post('/maintenance-types/initial-catalog');
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toHaveLength(INITIAL_MAINTENANCE_TYPES.length);
    expect(new Set(again.body.skipped.map((s: { reason: string }) => s.reason))).toEqual(new Set(['CODE_EXISTANT']));
    expect(await t.prisma.client.maintenanceType.count()).toBe(INITIAL_MAINTENANCE_TYPES.length);
  });

  it('sans rien forcer : une opération existante (même libellé, même code, archivée) n’est ni modifiée ni réactivée', async () => {
    const vidange = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'VIDANGE  moteur', description: 'Consigne du client' });
    const pneus = await admin.post('/maintenance-types', { code: 'PNEUS', label: 'Pneumatiques' });
    expect((await admin.patch(`/maintenance-types/${pneus.body.id}`, { status: 'ARCHIVE', expectedVersion: 1 })).status).toBe(200);

    const res = await admin.post('/maintenance-types/initial-catalog');
    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { code: 'VIDANGE_MOTEUR', label: 'Vidange moteur', reason: 'LIBELLE_EXISTANT' },
        { code: 'PNEUS', label: 'Pneus', reason: 'CODE_EXISTANT' },
      ]),
    );
    expect(res.body.created).toHaveLength(INITIAL_MAINTENANCE_TYPES.length - 2);
    const keptVidange = await t.prisma.client.maintenanceType.findUniqueOrThrow({ where: { id: vidange.body.id } });
    expect(keptVidange).toMatchObject({ code: 'VIDANGE', label: 'VIDANGE  moteur', description: 'Consigne du client', version: 1, status: 'ACTIF' });
    const keptPneus = await t.prisma.client.maintenanceType.findUniqueOrThrow({ where: { id: pneus.body.id } });
    expect(keptPneus).toMatchObject({ label: 'Pneumatiques', status: 'ARCHIVE', version: 2 });
    expect(await t.prisma.client.maintenanceType.count({ where: { label: { in: ['Vidange moteur', 'Pneus'] } } })).toBe(0);
  });

  it('installations simultanées : chaque opération n’existe qu’une fois ; même Idempotency-Key → réponse rejouée', async () => {
    const results = await Promise.all([admin.post('/maintenance-types/initial-catalog'), admin.post('/maintenance-types/initial-catalog'), admin.post('/maintenance-types/initial-catalog')]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(results.reduce((sum, r) => sum + (r.body.created as unknown[]).length, 0)).toBe(INITIAL_MAINTENANCE_TYPES.length);
    expect(await t.prisma.client.maintenanceType.count()).toBe(INITIAL_MAINTENANCE_TYPES.length);

    const key = randomUUID();
    const once = await admin.post('/document-types/initial-catalog').set('Idempotency-Key', key);
    const replay = await admin.post('/document-types/initial-catalog').set('Idempotency-Key', key);
    expect(once.status).toBe(200);
    expect(replay.body).toEqual(once.body);
    expect(once.body.created).toHaveLength(INITIAL_DOCUMENT_TYPES.length);
  });

  it('types de documents usuels véhicule et conducteur : facultatifs, non bloquants, aucun type existant modifié, aucune alerte inventée', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const assurance = await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance flotte', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, noticeDays: [60] });
    expect(assurance.status).toBe(201);
    expect((await chefA.post('/document-types/initial-catalog')).status).toBe(403);
    const alerts = async () => (await t.prisma.client.alert.findMany({ orderBy: { id: 'asc' } })).map((a) => ({ id: a.id, type: a.type, objectId: a.objectId, status: a.status, severity: a.severity, condition: a.condition }));
    const alertsBefore = await alerts();
    // Le type existant requis produit son alerte « manquant » : c'est la seule attendue.
    expect(alertsBefore.map((a) => a.type)).toEqual(['DOCUMENT_MANQUANT']);

    const res = await admin.post('/document-types/initial-catalog');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.skipped).toEqual([{ code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', reason: 'CODE_EXISTANT' }]);
    expect(res.body.created).toHaveLength(INITIAL_DOCUMENT_TYPES.length - 1);
    for (const created of res.body.created) expect(created).toMatchObject({ required: false, blocksCheckout: false, visibleToDriver: false, noticeDays: [30, 15, 7], status: 'ACTIF' });
    const owners = new Set(res.body.created.map((c: { ownerType: string }) => c.ownerType));
    expect(owners).toEqual(new Set(['VEHICULE', 'CONDUCTEUR']));
    expect(res.body.created.find((c: { code: string }) => c.code === 'CARTE_GRISE')).toMatchObject({ hasExpiry: false, ownerType: 'VEHICULE' });
    expect(res.body.created.find((c: { code: string }) => c.code === 'VISITE_TECHNIQUE')).toMatchObject({ hasExpiry: true, ownerType: 'VEHICULE' });
    // Le type existant garde son paramétrage (requis, bloquant, préavis) et sa version.
    expect(await t.prisma.client.documentType.findUniqueOrThrow({ where: { id: assurance.body.id } })).toMatchObject({ label: 'Assurance flotte', required: true, blocksCheckout: true, noticeDays: [60], version: 1 });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'type_document.creation', reason: 'Installation du catalogue initial' } })).toBe(INITIAL_DOCUMENT_TYPES.length - 1);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'type_document.catalogue_initial' } })).toBe(1);

    // Rien n'est exigé d'office : aucune ligne MANQUANT ni alerte pour les types installés.
    const compliance = (await chefA.get(`/documents/compliance?vehicleId=${vehicleId}`)).body.items as Array<{ documentTypeId: string; status: string }>;
    const installedIds = new Set(res.body.created.map((c: { id: string }) => c.id));
    expect(compliance.filter((row) => installedIds.has(row.documentTypeId) && row.status === 'MANQUANT')).toEqual([]);
    // Même après une réévaluation complète des échéances documentaires : aucune alerte nouvelle (types facultatifs).
    await t.app.get(DocumentsService).evaluateAll(f.organizationId);
    expect(await alerts()).toEqual(alertsBefore);

    // Types par objet : un type conducteur s'enregistre sur un conducteur, jamais sur un véhicule.
    const driverType = res.body.created.find((c: { code: string }) => c.code === 'AUTORISATION_CONDUCTEUR');
    const onDriver = await chefA.post('/documents', { documentTypeId: driverType.id, driverId: f.drivers.a1, number: 'AUT-1', validFrom: '2026-01-01', validTo: '2027-01-01' });
    expect(onDriver.status, JSON.stringify(onDriver.body)).toBe(201);
    expect(onDriver.body).toMatchObject({ ownerType: 'CONDUCTEUR', driverId: f.drivers.a1 });
    const onVehicle = await chefA.post('/documents', { documentTypeId: driverType.id, vehicleId, number: 'AUT-2' });
    expect(onVehicle.status).toBe(422);
    expect(onVehicle.body.code).toBe('TYPE_INCOMPATIBLE');

    const again = await admin.post('/document-types/initial-catalog');
    expect(again.body.created).toEqual([]);
    expect(await t.prisma.client.documentType.count()).toBe(INITIAL_DOCUMENT_TYPES.length);
  });
});
