import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/** Réplique de toQuery (apps/web/lib/api-client.ts) : paramètres vides ou nuls omis. */
function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Écrans F11 (/administration/telematique, /telematique) : chaque appel est émis ici avec la forme exacte
 * des requêtes de l'interface (paramètres de liste, corps des formulaires), pour que l'API les accepte
 * (liste blanche de validation) et que les droits correspondent aux boutons affichés (D-112).
 */
describe('Connecteur télématique — requêtes des écrans F11', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
  });

  it('administration : types, création et modification par type, liste filtrée, secret en écriture seule, suppression d’un brouillon', async () => {
    const kinds = await admin.get('/telemetry/provider-kinds');
    expect(kinds.status).toBe(200);
    expect(kinds.body.find((k: { kind: string }) => k.kind === 'RPA')).toMatchObject({ available: false });
    expect(kinds.body.find((k: { kind: string }) => k.kind === 'SIMULATEUR')).toMatchObject({ available: true, label: 'SIMULATEUR — données fictives' });
    expect((await chefA.get('/telemetry/provider-kinds')).status).toBe(403);

    // ProviderDialog, type TRACCAR : URL de base, paramètres du formulaire, intervalle, reprise, sociétés.
    const created = await admin.post('/telemetry/providers', {
      name: 'Traccar du groupe',
      baseUrl: 'https://traccar.exemple.tn',
      settings: { registrationSource: 'attribute:immatriculation', fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE', canOdometerAttribute: null },
      syncIntervalMinutes: 15,
      backfillDays: 7,
      companyIds: [f.companies.A],
      kind: 'TRACCAR',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'BROUILLON', channel: 'API', configurationVisible: true, credentials: [{ kind: 'JETON_API', configured: false }, { kind: 'IDENTIFIANTS_API', configured: false }] });
    const patched = await admin.patch(`/telemetry/providers/${created.body.id}`, {
      name: 'Traccar du groupe',
      baseUrl: 'https://traccar.exemple.tn',
      settings: { registrationSource: 'name' },
      syncIntervalMinutes: 30,
      backfillDays: 14,
      companyIds: [f.companies.A, f.companies.B],
      expectedVersion: created.body.version,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ syncIntervalMinutes: 30, backfillDays: 14, settings: { registrationSource: 'name' } });
    const invalid = await admin.patch(`/telemetry/providers/${created.body.id}`, { settings: { registrationSource: 'plaque' }, expectedVersion: patched.body.version });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.fieldErrors)).toContain('settings');
    const secretKey = await admin.patch(`/telemetry/providers/${created.body.id}`, { settings: { apiToken: 'x' }, expectedVersion: patched.body.version });
    expect(secretKey.status).toBe(422);
    expect(secretKey.body.code).toBe('SECRET_DANS_PARAMETRES');

    // ProviderDialog, type RAPPORT_GENERIQUE : pas d'URL de base, paramètres de la source et du fichier.
    const report = await admin.post('/telemetry/providers', {
      name: 'Rapports SFTP',
      settings: {
        source: 'SFTP',
        sftp: { host: 'sftp.fournisseur.tn', directory: '/rapports', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
        columns: { unit: 'Unité', timestamp: 'Date', odometer: 'Compteur (km)' },
        timestampFormat: 'dd/MM/yyyy HH:mm:ss',
        decimalSeparator: ',',
        odometerUnit: 'km',
        odometerKind: 'COMPTEUR_CAN',
        engineOnValues: ['1', 'on'],
      },
      companyIds: [f.companies.A],
      kind: 'RAPPORT_GENERIQUE',
    });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    expect(report.body).toMatchObject({ channel: 'RAPPORT', baseUrl: null });

    // Liste des fournisseurs (filtres de l'écran) ; lecture du chef sans configuration.
    const listed = await admin.get(`/telemetry/providers${toQuery({ q: 'Traccar', status: 'BROUILLON', page: 1, pageSize: 25 })}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((p: { name: string }) => p.name)).toEqual(['Traccar du groupe']);
    const chefView = await chefA.get(`/telemetry/providers${toQuery({ companyId: f.companies.A, pageSize: 100 })}`);
    expect(chefView.status).toBe(200);
    expect(chefView.body.items.every((p: Record<string, unknown>) => p['configurationVisible'] === false && !('settings' in p) && !('credentials' in p) && !('baseUrl' in p))).toBe(true);

    // Secret en écriture seule : la réponse et la fiche ne donnent que l'état « configuré le … ».
    const secret = 'jeton-ecran-ne-doit-jamais-revenir';
    const put = await admin.put(`/telemetry/providers/${created.body.id}/credentials/JETON_API`, { secret });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ kind: 'JETON_API', configured: true, rotatedAt: NOW });
    const detail = await admin.get(`/telemetry/providers/${created.body.id}`);
    expect(detail.body.credentials).toContainEqual({ kind: 'JETON_API', configured: true, rotatedAt: NOW });
    expect(JSON.stringify(detail.body)).not.toContain(secret);
    const revoked = await admin.delete(`/telemetry/providers/${created.body.id}/credentials/JETON_API`);
    expect(revoked.body).toEqual({ kind: 'JETON_API', configured: false, rotatedAt: null });

    // ProviderDialog en modification : sociétés renvoyées seulement si elles changent. Une société
    // couverte puis archivée ne bloque pas les autres modifications ; la renvoyer est refusé.
    const covering = await admin.patch(`/telemetry/providers/${report.body.id}`, { companyIds: [f.companies.A, f.companies.C], expectedVersion: report.body.version });
    expect(covering.status, JSON.stringify(covering.body)).toBe(200);
    const companyC = await admin.get(`/companies/${f.companies.C}`);
    expect(companyC.status, JSON.stringify(companyC.body)).toBe(200);
    const archived = await admin.post(`/companies/${f.companies.C}/archive`, { expectedVersion: companyC.body.version });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const resent = await admin.patch(`/telemetry/providers/${report.body.id}`, { name: 'Rapports SFTP groupe', companyIds: [f.companies.A, f.companies.C], expectedVersion: covering.body.version });
    expect(resent.status).toBe(422);
    const unchanged = await admin.patch(`/telemetry/providers/${report.body.id}`, { name: 'Rapports SFTP groupe', settings: covering.body.settings, expectedVersion: covering.body.version });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    expect(unchanged.body.name).toBe('Rapports SFTP groupe');
    expect([...(unchanged.body.companyIds as string[])].sort()).toEqual([f.companies.A, f.companies.C].sort());

    // Suppression d'un brouillon (DELETE ?expectedVersion=…).
    const current = await admin.get(`/telemetry/providers/${report.body.id}`);
    const deleted = await admin.delete(`/telemetry/providers/${report.body.id}?expectedVersion=${current.body.version}`);
    expect(deleted.status).toBe(204);
  });

  it('page Télématique : activation avec motif, catégories d’unités, confirmation datée, sélecteurs, changement de boîtier, exécutions, synchronisation et carburant', async () => {
    // Activation par société (CompanyTelemetryDialog) : motif et version attendue.
    const companies = await admin.get('/telemetry/companies');
    const companyA = companies.body.find((c: { companyId: string }) => c.companyId === f.companies.A);
    const enabled = await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11', expectedVersion: companyA.version });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect((await chefA.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Tentative du chef' })).status).toBe(403);

    const v1 = await createVehicle(t.prisma, f, 'A', { code: 'V-ECR-1', registration: '101 TU 1001' });
    const v2 = await createVehicle(t.prisma, f, 'A', { code: 'V-ECR-2', registration: '102 TU 1002' });
    const created = await admin.post('/telemetry/providers', {
      name: 'Simulateur écrans',
      settings: {
        scenario: {
          units: [
            { externalId: 'E-1', label: 'Boîtier 1', declaredRegistration: '101 TU 1001', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
            { externalId: 'E-2', label: 'Boîtier 2', declaredRegistration: '102-tu-1002', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
            { externalId: 'E-3', label: 'Boîtier neuf', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
          ],
        },
      },
      companyIds: [f.companies.A],
      kind: 'SIMULATEUR',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    // Découverte par le chef (carte fournisseur de l'onglet Synchronisation).
    const discovered = await chefA.post(`/telemetry/providers/${created.body.id}/discover`);
    expect(discovered.status, JSON.stringify(discovered.body)).toBe(200);
    expect(discovered.body).toMatchObject({ proposalsCreated: 2, unmapped: 1 });

    // Onglet Associations : catégorie, société de l'en-tête, fournisseur, recherche, pagination.
    const proposed = await chefA.get(`/telemetry/units${toQuery({ category: 'PROPOSEES', companyId: f.companies.A, providerId: created.body.id, q: '', page: 1, pageSize: 25 })}`);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body.counts).toEqual({ nonAssociees: 1, proposees: 2, associees: 0, vehiculesSansUnite: 2, ignorees: 0 });
    const searched = await chefA.get(`/telemetry/units${toQuery({ category: 'PROPOSEES', companyId: f.companies.A, q: 'V-ECR-2', page: 1, pageSize: 25 })}`);
    expect(searched.body.items.map((r: { vehicle: { id: string } }) => r.vehicle.id)).toEqual([v2]);
    const p1 = proposed.body.items.find((r: { vehicle: { id: string } }) => r.vehicle.id === v1).mapping;

    // Lecture seule de l'opérateur : liste 200, décision 403 (boutons masqués côté écran).
    expect((await operateurA.get(`/telemetry/units${toQuery({ category: 'PROPOSEES', page: 1, pageSize: 25 })}`)).status).toBe(200);
    expect((await operateurA.post(`/telemetry/mappings/${p1.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: p1.version })).status).toBe(403);

    // ConfirmMappingDialog : nature choisie, date d'effet saisie en heure locale convertie en ISO UTC.
    const confirmed = await chefA.post(`/telemetry/mappings/${p1.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: ['NIVEAU_CAN'], validFrom: '2026-09-23T07:30:00.000Z', expectedVersion: p1.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRME', validFrom: '2026-09-23T07:30:00.000Z', fuelKinds: ['NIVEAU_CAN'] });

    // Sélecteurs : unités non associées (UnitPicker) et véhicules actifs (VehiclePicker).
    const picker = await chefA.get(`/telemetry/units${toQuery({ category: 'NON_ASSOCIEES', q: '', pageSize: 20 })}`);
    expect(picker.status).toBe(200);
    const spare = picker.body.items.find((r: { unit: { externalId: string } }) => r.unit.externalId === 'E-3').unit;
    expect(spare).toBeDefined();
    const vehicles = await chefA.get(`/vehicles${toQuery({ companyId: f.companies.A, q: 'V-ECR', lifecycleStatus: 'ACTIF', pageSize: 20, sort: 'code' })}`);
    expect(vehicles.status, JSON.stringify(vehicles.body)).toBe(200);
    expect(vehicles.body.items.map((v: { code: string }) => v.code)).toEqual(['V-ECR-1', 'V-ECR-2']);

    // CloseMappingDialog : changement de boîtier, instant saisi, nouvelle unité et natures.
    const associated = await chefA.get(`/telemetry/units${toQuery({ category: 'ASSOCIEES', companyId: f.companies.A, page: 1, pageSize: 25 })}`);
    const open = associated.body.items[0].mapping;
    const closed = await chefA.post(`/telemetry/mappings/${open.id}/close`, {
      reason: 'Boîtier défectueux remplacé',
      closedAt: '2026-09-24T09:00:00.000Z',
      replacement: { unitId: spare.id, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] },
      expectedVersion: open.version,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.closed).toMatchObject({ status: 'CLOTURE', validTo: '2026-09-24T09:00:00.000Z' });
    expect(closed.body.replacement).toMatchObject({ status: 'CONFIRME', unitExternalId: 'E-3', validFrom: '2026-09-24T09:00:00.000Z' });

    // Panneau véhicule : l'association courante est celle du nouveau boîtier.
    const panel = await chefA.get(`/telemetry/vehicles/${v1}`);
    expect(panel.body.mapping).toMatchObject({ unitExternalId: 'E-3' });

    // Onglet Synchronisation : synchronisation manuelle du chef (202), reprise réservée à l'administrateur.
    const sync = await chefA.post(`/telemetry/providers/${created.body.id}/sync`, { companyId: f.companies.A });
    expect(sync.status, JSON.stringify(sync.body)).toBe(202);
    expect(sync.body.runs).toHaveLength(1);
    expect(sync.body.runs[0]).toMatchObject({ companyId: f.companies.A });
    expect((await chefA.post(`/telemetry/providers/${created.body.id}/sync`, { companyId: f.companies.A, reprise: true })).status).toBe(403);
    expect((await operateurA.post(`/telemetry/providers/${created.body.id}/sync`, {})).status).toBe(403);
    const runs = await chefA.get(`/telemetry/sync-runs${toQuery({ companyId: f.companies.A, providerId: created.body.id, status: '', page: 1, pageSize: 10 })}`);
    expect(runs.status, JSON.stringify(runs.body)).toBe(200);
    expect(runs.body.total).toBeGreaterThanOrEqual(1);
    expect((await chefA.get(`/telemetry/sync-runs${toQuery({ status: 'ECHEC', page: 1, pageSize: 10 })}`)).status).toBe(200);

    // Onglet Événements carburant : filtres de l'écran.
    const fuel = await chefA.get(`/telemetry/fuel-events${toQuery({ companyId: f.companies.A, status: 'A_QUALIFIER', type: 'BAISSE_ANORMALE', page: 1, pageSize: 25 })}`);
    expect(fuel.status, JSON.stringify(fuel.body)).toBe(200);
    expect(fuel.body).toMatchObject({ items: [], total: 0 });
    expect((await chefA.get(`/telemetry/fuel-events${toQuery({ page: 1, pageSize: 25 })}`)).status).toBe(200);
  });
});
