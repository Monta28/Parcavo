import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rotateTelemetrySecrets } from '../../src/cli/rotate-telemetry-secrets.js';
import { AuditService } from '../../src/infra/audit.service.js';
import { loadEnv } from '../../src/infra/env.js';
import { SecretsCryptoService } from '../../src/infra/secrets-crypto.service.js';
import { assertNoActiveSimulatorInProduction } from '../../src/modules/telemetry/telemetry-adapter.registry.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';
const TEST_KEY_K1 = Buffer.alloc(32, 7).toString('base64');

interface Provider {
  id: string;
  version: number;
  status: string;
  [key: string]: unknown;
}

/** Échantillon odomètre CAN du scénario (jamais ingéré sans association confirmée). */
function canSample(unit: string, valueKm: string, observedAt = '2026-09-24T09:00:00Z') {
  return { unitExternalId: unit, kind: 'COMPTEUR_CAN', valueKm, observedAt, sourceReference: `${unit}-${observedAt}` };
}

describe('Connecteur télématique — cœur (CDC 14.3 à 14.6 ; D-101, D-112, D-292, D-300 à D-304 ; T35, T44)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;

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
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  });

  async function enable(company: 'A' | 'B'): Promise<void> {
    const res = await admin.post(`/telemetry/companies/${f.companies[company]}/enable`, { reason: 'Mise en service du module F11' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.telemetryEnabled).toBe(true);
  }

  async function createProvider(body: Record<string, unknown>): Promise<Provider> {
    const res = await admin.post('/telemetry/providers', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Provider;
  }

  async function activate(provider: Provider): Promise<Provider> {
    const res = await admin.post(`/telemetry/providers/${provider.id}/activate`, { expectedVersion: provider.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('ACTIF');
    return res.body as Provider;
  }

  async function simulator(scenario: Record<string, unknown>, companies: Array<'A' | 'B'> = ['A'], name = 'Simulateur de recette'): Promise<Provider> {
    return activate(await createProvider({ name, kind: 'SIMULATEUR', settings: { scenario }, companyIds: companies.map((c) => f.companies[c]) }));
  }

  async function activeUnitAlerts(): Promise<Array<{ objectId: string; companyId: string; severity: string }>> {
    return t.prisma.client.alert.findMany({ where: { type: 'GPS_UNITE_NON_MAPPEE', status: 'ACTIVE' }, select: { objectId: true, companyId: true, severity: true } });
  }

  async function ingestedData(): Promise<number[]> {
    return Promise.all([
      t.prisma.client.odometerReading.count(),
      t.prisma.client.telemetryOdometerSample.count(),
      t.prisma.client.fuelLevelSample.count(),
      t.prisma.client.telemetryUnitState.count(),
      t.prisma.client.fuelEvent.count(),
    ]);
  }

  it('T35 — 12 unités, 10 immatriculations reconnues, 2 inconnues : 10 propositions, 2 non associées, aucun relevé avant confirmation', async () => {
    await enable('A');
    const formats = (i: number) => {
      const [a, b] = [120 + i, 4500 + i];
      return [`${a} TU ${b}`, `${a}TU${b}`, `${a}-tu-${b}`, `${a} تونس ${b}`][i % 4] as string;
    };
    const vehicles: string[] = [];
    for (let i = 0; i < 10; i += 1) vehicles.push(await createVehicle(t.prisma, f, 'A', { code: `V-T35-${i}`, registration: `${120 + i} TU ${4500 + i}` }));
    // Un véhicule de B porte l'immatriculation d'une unité : B n'est pas couverte, aucune proposition.
    await createVehicle(t.prisma, f, 'B', { code: 'V-B-HORS', registration: '999 TU 9999' });
    const units = [
      ...Array.from({ length: 10 }, (_, i) => ({ externalId: `U-${i + 1}`, label: `Boîtier ${i + 1}`, declaredRegistration: formats(i), odometerKinds: ['COMPTEUR_CAN'], fuelKinds: i === 0 ? ['NIVEAU_SONDE'] : [] })),
      { externalId: 'U-11', label: 'Boîtier 11', declaredRegistration: '999 TU 9999', odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] },
      { externalId: 'U-12', label: 'Remorque 12', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
    ];
    const provider = await simulator({
      units,
      odometerSamples: [...units.filter((u) => u.odometerKinds.includes('COMPTEUR_CAN')).map((u, i) => canSample(u.externalId, `${50000 + i}.500`)), { unitExternalId: 'U-11', kind: 'DISTANCE_GPS', valueKm: '12000', observedAt: '2026-09-24T09:00:00Z' }],
      fuelSamples: [{ unitExternalId: 'U-1', kind: 'NIVEAU_SONDE', liters: '60', engineOn: false, speedKmh: '0', observedAt: '2026-09-24T09:00:00Z' }],
    });
    expect(provider).toMatchObject({ kind: 'SIMULATEUR', kindLabel: 'SIMULATEUR — données fictives', isSimulator: true, channel: 'API' });

    const discovery = await admin.post(`/telemetry/providers/${provider.id}/discover`);
    expect(discovery.status, JSON.stringify(discovery.body)).toBe(200);
    expect(discovery.body).toMatchObject({ unitsSeen: 12, unitsCreated: 12, unitsUpdated: 0, unitsMissing: 0, proposalsCreated: 10, proposalsPending: 10, unmapped: 2, rejectedUnits: 0 });
    const byExternal = new Map((discovery.body.units as Array<{ externalId: string; outcome: string; unmappedReason: string | null; vehicleId: string | null; label: string; odometerKinds: string[] }>).map((u) => [u.externalId, u]));
    for (let i = 0; i < 10; i += 1) expect(byExternal.get(`U-${i + 1}`)).toMatchObject({ outcome: 'PROPOSEE', vehicleId: vehicles[i] });
    expect(byExternal.get('U-11')).toMatchObject({ outcome: 'NON_ASSOCIEE', unmappedReason: 'VEHICULE_NON_ELIGIBLE', odometerKinds: ['DISTANCE_GPS'] });
    expect(byExternal.get('U-12')).toMatchObject({ outcome: 'NON_ASSOCIEE', unmappedReason: 'IMMATRICULATION_ABSENTE' });
    expect(byExternal.get('U-1')?.label).toBe('SIMULATEUR — Boîtier 1');

    // Aucune donnée ingérée avant confirmation : ni relevé, ni échantillon, ni état d'unité, ni événement.
    expect(await ingestedData()).toEqual([0, 0, 0, 0, 0]);
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { status: 'PROPOSE' } })).toBe(10);
    const runs = await chefA.get('/telemetry/sync-runs');
    expect(runs.status).toBe(200);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]).toMatchObject({ trigger: 'MANUEL', status: 'SUCCES', unitsSeen: 12, companyId: null, errorSummary: null });

    // Alerte « unité non associée » (INFO) pour les deux unités, société A seulement.
    const alerts = await activeUnitAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts.every((a) => a.companyId === f.companies.A && a.severity === 'INFO')).toBe(true);

    // Listes du chef : propositions, non associées (motif), véhicules sans unité active.
    const proposed = await chefA.get('/telemetry/units?category=PROPOSEES&pageSize=100');
    expect(proposed.status).toBe(200);
    expect(proposed.body.total).toBe(10);
    expect(proposed.body.counts).toEqual({ nonAssociees: 2, proposees: 10, associees: 0, vehiculesSansUnite: 10, ignorees: 0 });
    expect(proposed.body.items[0].mapping).toMatchObject({ status: 'PROPOSE', isSimulator: true, odometerKind: 'AUCUN', validFrom: null });
    const unmapped = await chefA.get('/telemetry/units?category=NON_ASSOCIEES');
    expect(unmapped.body.items.map((r: { unit: { externalId: string }; unmappedReason: string }) => [r.unit.externalId, r.unmappedReason]).sort()).toEqual([
      ['U-11', 'INCONNUE'],
      ['U-12', 'IMMATRICULATION_ABSENTE'],
    ]);
    const withoutUnit = await chefA.get('/telemetry/units?category=VEHICULES_SANS_UNITE&pageSize=100');
    expect(withoutUnit.body.total).toBe(10);

    // Découverte rejouée : idempotente (aucun doublon de proposition ni d'alerte).
    const again = await chefA.post(`/telemetry/providers/${provider.id}/discover`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ unitsSeen: 12, unitsCreated: 0, unitsUpdated: 12, proposalsCreated: 0, proposalsPending: 10 });
    expect(await t.prisma.client.telemetryVehicleMapping.count()).toBe(10);
    expect(await activeUnitAlerts()).toHaveLength(2);

    // Le chef confirme : date d'effet par défaut = maintenant − reprise initiale (7 jours).
    const list = proposed.body.items as Array<{ mapping: { id: string; version: number; vehicle: { id: string } } }>;
    const first = list.find((r) => r.mapping.vehicle.id === vehicles[0])?.mapping as { id: string; version: number };
    const confirmed = await chefA.post(`/telemetry/mappings/${first.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: ['NIVEAU_SONDE'], expectedVersion: first.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRME', odometerKind: 'COMPTEUR_CAN', fuelKinds: ['NIVEAU_SONDE'], validFrom: '2026-09-17T10:00:00.000Z', validTo: null, decidedById: f.users.chefA });
    expect((await chefA.post(`/telemetry/mappings/${first.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: first.version })).status).toBe(409);
    // La confirmation n'ingère rien (la synchronisation est le travail du worker, via l'ingestion unique).
    expect(await ingestedData()).toEqual([0, 0, 0, 0, 0]);

    // Date d'effet bornée (D-301) : ni future, ni avant la reprise initiale.
    const second = list.find((r) => r.mapping.vehicle.id === vehicles[1])?.mapping as { id: string; version: number };
    const tooOld = await chefA.post(`/telemetry/mappings/${second.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-01T00:00:00Z', expectedVersion: second.version });
    expect(tooOld.status).toBe(422);
    expect(tooOld.body.code).toBe('DATE_EFFET_TROP_ANCIENNE');
    const future = await chefA.post(`/telemetry/mappings/${second.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-25T00:00:00Z', expectedVersion: second.version });
    expect(future.body.code).toBe('DATE_EFFET_FUTURE');
    const invalidKind = await chefA.post(`/telemetry/mappings/${second.id}/confirm`, { odometerKind: 'ESTIMATION', fuelKinds: [], expectedVersion: second.version });
    expect(invalidKind.status).toBe(422);

    // Rejet : l'unité redevient non associée (alerte INFO), la paire n'est plus reproposée.
    const rejected = await chefA.post(`/telemetry/mappings/${second.id}/reject`, { reason: 'Boîtier installé sur un autre véhicule', expectedVersion: second.version });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJETE', closedReason: 'Boîtier installé sur un autre véhicule' });
    expect(await activeUnitAlerts()).toHaveLength(3);
    const rediscovery = await admin.post(`/telemetry/providers/${provider.id}/discover`);
    expect(rediscovery.body.proposalsCreated).toBe(0);
    const unmappedAfter = await chefA.get('/telemetry/units?category=NON_ASSOCIEES');
    expect(unmappedAfter.body.items.find((r: { unit: { externalId: string } }) => r.unit.externalId === 'U-2')?.unmappedReason).toBe('PROPOSITION_REJETEE');

    // Association manuelle (remorque sans immatriculation déclarée) sur le véhicule resté sans unité.
    const unitU12 = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId: 'U-12' } });
    const manual = await chefA.post('/telemetry/mappings', { unitId: unitU12.id, vehicleId: vehicles[1], odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect(manual.body).toMatchObject({ status: 'CONFIRME', unitExternalId: 'U-12', proposalReason: 'Association manuelle par le chef de parc.' });
    expect((await activeUnitAlerts()).map((a) => a.objectId).sort()).toEqual(
      (await t.prisma.client.telemetryUnit.findMany({ where: { externalId: { in: ['U-11', 'U-2'] } }, select: { id: true } })).map((u) => u.id).sort(),
    );
    // Un véhicule déjà équipé ne reçoit pas une seconde unité active (changement de boîtier = clôture).
    const unitU11 = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId: 'U-11' } });
    const twice = await chefA.post('/telemetry/mappings', { unitId: unitU11.id, vehicleId: vehicles[0], odometerKind: 'DISTANCE_GPS', fuelKinds: [] });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('VEHICULE_DEJA_EQUIPE');
    const counts = (await chefA.get('/telemetry/units')).body.counts;
    expect(counts).toEqual({ nonAssociees: 2, proposees: 8, associees: 2, vehiculesSansUnite: 8, ignorees: 0 });
    expect(await ingestedData()).toEqual([0, 0, 0, 0, 0]);
  });

  it('D-112 — droits : seul l’administrateur configure ; le chef B ne voit rien de A (404) ; lecture sans configuration', async () => {
    await enable('A');
    const vehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-DROITS', registration: '400 TU 4000' });
    const provider = await simulator({
      units: [{ externalId: 'D-1', label: 'Boîtier', declaredRegistration: '400 TU 4000', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }],
      odometerSamples: [canSample('D-1', '1000')],
    });
    expect((await admin.post(`/telemetry/providers/${provider.id}/discover`)).status).toBe(200);
    const mapping = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle } });

    // Le chef ne configure pas.
    expect((await chefA.post('/telemetry/providers', { name: 'Chef', kind: 'SIMULATEUR', settings: { scenario: { units: [] } }, companyIds: [f.companies.A] })).status).toBe(403);
    expect((await chefA.patch(`/telemetry/providers/${provider.id}`, { name: 'Renommé', expectedVersion: provider.version })).status).toBe(403);
    expect((await chefA.put(`/telemetry/providers/${provider.id}/credentials/JETON_API`, { secret: 'jeton-du-chef' })).status).toBe(403);
    expect((await chefA.post(`/telemetry/providers/${provider.id}/health`)).status).toBe(403);
    expect((await chefA.post(`/telemetry/providers/${provider.id}/suspend`, { reason: 'test', expectedVersion: provider.version })).status).toBe(403);
    expect((await chefA.post(`/telemetry/companies/${f.companies.A}/disable`, { reason: 'Essai du chef' })).status).toBe(403);
    expect((await chefA.get('/telemetry/provider-kinds')).status).toBe(403);

    // Le chef consulte l'état de ses sociétés, sans configuration ni secret.
    const seen = await chefA.get(`/telemetry/providers/${provider.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ id: provider.id, status: 'ACTIF', configurationVisible: false, companyIds: [f.companies.A] });
    for (const key of ['settings', 'baseUrl', 'credentials', 'backfillDays']) expect(seen.body).not.toHaveProperty(key);
    const reader = await lecteurA.get('/telemetry/providers');
    expect(reader.status).toBe(200);
    expect(reader.body.items[0]).not.toHaveProperty('settings');
    expect((await lecteurA.get('/telemetry/units')).status).toBe(200);
    expect((await conducteurA.get('/telemetry/units')).status).toBe(403);
    expect((await conducteurA.get('/telemetry/providers')).status).toBe(403);

    // Le chef B ne voit ni le fournisseur, ni les associations, ni les exécutions de A.
    expect((await chefB.get(`/telemetry/providers/${provider.id}`)).status).toBe(404);
    expect((await chefB.get(`/telemetry/mappings/${mapping.id}`)).status).toBe(404);
    expect((await chefB.post(`/telemetry/mappings/${mapping.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: mapping.version })).status).toBe(404);
    expect((await chefB.post(`/telemetry/mappings/${mapping.id}/reject`, { reason: 'Intrusion', expectedVersion: mapping.version })).status).toBe(404);
    expect((await chefB.post(`/telemetry/providers/${provider.id}/discover`)).status).toBe(404);
    expect((await chefB.get(`/telemetry/units?companyId=${f.companies.A}`)).status).toBe(404);
    const unitsB = await chefB.get('/telemetry/units?category=PROPOSEES');
    expect(unitsB.body.total).toBe(0);
    expect(unitsB.body.counts).toEqual({ nonAssociees: 0, proposees: 0, associees: 0, vehiculesSansUnite: 0, ignorees: 0 });
    expect((await chefB.get('/telemetry/mappings')).body.total).toBe(0);
    expect((await chefB.get('/telemetry/sync-runs')).body.total).toBe(0);
    expect((await chefB.get('/telemetry/providers')).body.total).toBe(0);

    // L'opérateur lit mais ne décide pas ; le chef de A confirme.
    expect((await operateurA.get(`/telemetry/mappings/${mapping.id}`)).status).toBe(200);
    expect((await operateurA.post(`/telemetry/mappings/${mapping.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: mapping.version })).status).toBe(403);
    expect((await operateurA.post(`/telemetry/providers/${provider.id}/discover`)).status).toBe(403);
    const ok = await chefA.post(`/telemetry/mappings/${mapping.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: mapping.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'telemetrie.association.confirmation', objectId: mapping.id } });
    expect(audit?.actorUserId).toBe(f.users.chefA);
  });

  it('D-300 — changement de boîtier : clôture et nouvelle association, kilométrage cumulé inchangé', async () => {
    await enable('A');
    const vehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-BOX', registration: '300 TU 3000' });
    const segment = await t.prisma.client.odometerSegment.create({
      data: { organizationId: f.organizationId, vehicleId: vehicle, sequence: 1, startedAt: new Date('2026-09-01T00:00:00Z'), startPhysicalKm: '50000', startCumulativeKm: '50000', cumulativeKnown: true },
    });
    const provider = await simulator({
      units: [
        { externalId: 'BOX-OLD', label: 'Ancien boîtier', declaredRegistration: '300 TU 3000', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
        { externalId: 'BOX-NEW', label: 'Nouveau boîtier', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
      ],
      odometerSamples: [canSample('BOX-OLD', '50100'), canSample('BOX-NEW', '120')],
    });
    await admin.post(`/telemetry/providers/${provider.id}/discover`);
    const proposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle, status: 'PROPOSE' } });
    const confirmed = await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: proposal.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    t.clock.advance(2 * 3_600_000);
    const newUnit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId: 'BOX-NEW' } });
    const future = await chefA.post(`/telemetry/mappings/${proposal.id}/close`, { reason: 'Boîtier remplacé', closedAt: '2026-09-25T00:00:00Z', expectedVersion: confirmed.body.version });
    expect(future.body.code).toBe('DATE_CLOTURE_FUTURE');
    const closed = await chefA.post(`/telemetry/mappings/${proposal.id}/close`, {
      reason: 'Boîtier défectueux remplacé par l’installateur',
      replacement: { unitId: newUnit.id, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] },
      expectedVersion: confirmed.body.version,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.closed).toMatchObject({ status: 'CLOTURE', validTo: '2026-09-24T12:00:00.000Z', closedReason: 'Boîtier défectueux remplacé par l’installateur' });
    expect(closed.body.replacement).toMatchObject({ status: 'CONFIRME', unitExternalId: 'BOX-NEW', validFrom: '2026-09-24T12:00:00.000Z', validTo: null, odometerKind: 'COMPTEUR_CAN' });
    expect(closed.body.replacement.proposalReason).toContain('Changement de boîtier');

    // Le compteur (segment) n'est jamais touché ; aucun relevé n'est créé par la clôture.
    const after = await t.prisma.client.odometerSegment.findMany({ where: { vehicleId: vehicle } });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: segment.id, startPhysicalKm: segment.startPhysicalKm, startCumulativeKm: segment.startCumulativeKm, endedAt: null, version: segment.version });
    expect(await t.prisma.client.odometerReading.count()).toBe(0);
    expect((await chefA.post(`/telemetry/mappings/${proposal.id}/close`, { reason: 'Encore', expectedVersion: closed.body.closed.version })).body.code).toBe('TRANSITION_INVALIDE');
    // L'ancienne unité, toujours présente chez le fournisseur, redevient « non associée ».
    const oldUnit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId: 'BOX-OLD' } });
    expect((await activeUnitAlerts()).map((a) => a.objectId)).toEqual([oldUnit.id]);
    // Réassocier l'ancienne unité au véhicule, désormais équipé du nouveau boîtier, est refusé.
    const back = await chefA.post('/telemetry/mappings', { unitId: oldUnit.id, vehicleId: vehicle, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
    expect(back.body.code).toBe('VEHICULE_DEJA_EQUIPE');
  });

  it('D-175 — cession du véhicule : l’association ouverte est clôturée à la date de l’opération et ses alertes résolues', async () => {
    await enable('A');
    const vehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-CEDE', registration: '600 TU 6000' });
    const provider = await simulator({ units: [{ externalId: 'C-1', label: 'Boîtier', declaredRegistration: '600 TU 6000', odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] }] });
    await admin.post(`/telemetry/providers/${provider.id}/discover`);
    const proposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle } });
    expect((await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'DISTANCE_GPS', fuelKinds: [], expectedVersion: proposal.version })).status).toBe(200);
    const drift = await t.prisma.client.alert.create({
      data: {
        organizationId: f.organizationId,
        companyId: f.companies.A,
        type: 'GPS_DERIVE',
        severity: 'ATTENTION',
        objectType: 'TelemetryVehicleMapping',
        objectId: proposal.id,
        vehicleId: vehicle,
        occurrenceKey: 'derive',
        title: 'Dérive GPS',
        message: 'Écart 4,2 %.',
        condition: {},
        actionPath: '/telematique',
        triggeredAt: new Date(NOW),
        lastEvaluatedAt: new Date(NOW),
      },
    });
    t.clock.advance(3_600_000);
    const v = await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicle } });
    const sold = await chefA.post(`/vehicles/${vehicle}/lifecycle`, { lifecycleStatus: 'CEDE', reason: 'Vente du véhicule', expectedVersion: v.version });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'CLOTURE', validTo: new Date('2026-09-24T11:00:00.000Z'), closedReason: 'Véhicule cédé.' });
    expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: drift.id } })).status).toBe('RESOLUE');
    // L'unité, toujours présente chez le fournisseur, redevient « non associée ».
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId: 'C-1' } });
    const byCategory = await chefA.get('/telemetry/units?category=NON_ASSOCIEES');
    expect(byCategory.body.items.map((r: { unit: { id: string } }) => r.unit.id)).toEqual([unit.id]);
    const closure = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.association.cloture', objectId: proposal.id } });
    expect(closure).toMatchObject({ actorUserId: f.users.chefA, companyId: f.companies.A, reason: 'Véhicule cédé.' });
  });

  it('D-249 — unité volontairement sans véhicule : ignorée (alerte résolue, plus de proposition), 409 si associée, reprise', async () => {
    await enable('A');
    const spareVehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-IGN', registration: '910 TU 9100' });
    const tractor = await createVehicle(t.prisma, f, 'A', { code: 'V-TRACT', registration: '930 TU 9300' });
    const provider = await simulator({
      units: [
        { externalId: 'REM-1', label: 'Remorque frigorifique', declaredRegistration: null, odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] },
        { externalId: 'SPARE-1', label: 'Boîtier de rechange', declaredRegistration: '910 TU 9100', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
        { externalId: 'TR-1', label: 'Tracteur', declaredRegistration: '930 TU 9300', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
      ],
    });
    const first = await admin.post(`/telemetry/providers/${provider.id}/discover`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ proposalsCreated: 2, unmapped: 1, ignored: 0 });
    const unit = async (externalId: string) => t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { externalId } });
    const trailer = await unit('REM-1');
    const spare = await unit('SPARE-1');
    // Unité non associée : alerte INFO (société couverte A).
    expect(await activeUnitAlerts()).toEqual([{ objectId: trailer.id, companyId: f.companies.A, severity: 'INFO' }]);

    // Droits : hors périmètre (chef B, fournisseur ne couvrant que A) → 404 ; opérateur → 403 ; motif vide → 422.
    expect((await chefB.post(`/telemetry/units/${trailer.id}/ignore`, { reason: 'Remorque de B' })).status).toBe(404);
    expect((await chefB.post(`/telemetry/units/${trailer.id}/unignore`, {})).status).toBe(404);
    expect((await operateurA.post(`/telemetry/units/${trailer.id}/ignore`, { reason: 'Remorque sans tracteur' })).status).toBe(403);
    expect((await conducteurA.post(`/telemetry/units/${trailer.id}/ignore`, { reason: 'Remorque sans tracteur' })).status).toBe(403);
    const blank = await chefA.post(`/telemetry/units/${trailer.id}/ignore`, { reason: '  ab  ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('MOTIF_REQUIS');
    expect((await chefA.post(`/telemetry/units/${trailer.id}/ignore`, {})).status).toBe(422);

    // Ignorer : état porté par l'unité, alerte résolue avec le motif, audit.
    const ignored = await chefA.post(`/telemetry/units/${trailer.id}/ignore`, { reason: ' Remorque sans boîtier de traction ' });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    expect(ignored.body).toMatchObject({ id: trailer.id, ignoredAt: NOW, ignoredById: f.users.chefA, ignoredReason: 'Remorque sans boîtier de traction' });
    expect(await activeUnitAlerts()).toEqual([]);
    expect(await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'GPS_UNITE_NON_MAPPEE', objectId: trailer.id } })).toMatchObject({
      status: 'RESOLUE',
      resolutionReason: 'Unité ignorée : Remorque sans boîtier de traction',
    });
    expect(await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.unite.ignoree', objectId: trailer.id } })).toMatchObject({
      actorUserId: f.users.chefA,
      objectType: 'TelemetryUnit',
      reason: 'Remorque sans boîtier de traction',
    });
    expect((await chefA.post(`/telemetry/units/${trailer.id}/ignore`, { reason: 'Encore une fois' })).body.code).toBe('TRANSITION_INVALIDE');
    // Contrôle en base (migration) : une unité ignorée porte un motif non vide.
    await expect(t.prisma.client.telemetryUnit.update({ where: { id: trailer.id }, data: { ignoredReason: '   ' } })).rejects.toThrow();

    // Ignorer une unité proposée rejette la proposition avec le motif.
    const pendingSpare = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { unitId: spare.id, status: 'PROPOSE' } });
    expect(pendingSpare.vehicleId).toBe(spareVehicle);
    expect((await admin.post(`/telemetry/units/${spare.id}/ignore`, { reason: 'Boîtier de rechange en stock' })).status).toBe(200);
    expect(await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: pendingSpare.id } })).toMatchObject({
      status: 'REJETE',
      closedReason: 'Unité ignorée : Boîtier de rechange en stock',
      decidedById: f.users.admin,
      version: pendingSpare.version + 1,
    });

    // Listes : absentes des unités non associées, présentes dans IGNOREES (motif IGNOREE).
    const unmapped = await chefA.get('/telemetry/units?category=NON_ASSOCIEES');
    expect(unmapped.status).toBe(200);
    expect(unmapped.body.items).toEqual([]);
    expect(unmapped.body.counts).toMatchObject({ nonAssociees: 0, proposees: 1, ignorees: 2 });
    const ignoredList = await chefA.get('/telemetry/units?category=IGNOREES');
    expect(ignoredList.status).toBe(200);
    expect(ignoredList.body.total).toBe(2);
    expect(ignoredList.body.items.map((r: { category: string; unmappedReason: string; unit: { externalId: string; ignoredReason: string } }) => [r.category, r.unit.externalId, r.unmappedReason, r.unit.ignoredReason]).sort()).toEqual([
      ['IGNOREES', 'REM-1', 'IGNOREE', 'Remorque sans boîtier de traction'],
      ['IGNOREES', 'SPARE-1', 'IGNOREE', 'Boîtier de rechange en stock'],
    ]);
    expect((await chefB.get('/telemetry/units?category=IGNOREES')).body.total).toBe(0);

    // Découverte suivante : aucune proposition pour une unité ignorée, signalée avec le motif IGNOREE, aucune alerte.
    const next = await chefA.post(`/telemetry/providers/${provider.id}/discover`);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body).toMatchObject({ proposalsCreated: 0, proposalsPending: 1, unmapped: 0, ignored: 2 });
    const outcomes = new Map((next.body.units as Array<{ externalId: string; outcome: string; unmappedReason: string | null }>).map((u) => [u.externalId, [u.outcome, u.unmappedReason]]));
    expect(outcomes.get('REM-1')).toEqual(['NON_ASSOCIEE', 'IGNOREE']);
    expect(outcomes.get('SPARE-1')).toEqual(['NON_ASSOCIEE', 'IGNOREE']);
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { unitId: { in: [trailer.id, spare.id] }, status: 'PROPOSE' } })).toBe(0);
    expect(await activeUnitAlerts()).toEqual([]);
    // Une unité ignorée ne s'associe pas (il faut d'abord ne plus l'ignorer).
    const blocked = await chefA.post('/telemetry/mappings', { unitId: trailer.id, vehicleId: spareVehicle, odometerKind: 'DISTANCE_GPS', fuelKinds: [] });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('UNITE_IGNOREE');

    // Association confirmée en cours : 409 (clôturer d'abord), rien n'est modifié.
    const tractorProposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: tractor, status: 'PROPOSE' } });
    expect((await chefA.post(`/telemetry/mappings/${tractorProposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: tractorProposal.version })).status).toBe(200);
    const tractorUnit = await unit('TR-1');
    const associated = await chefA.post(`/telemetry/units/${tractorUnit.id}/ignore`, { reason: 'Boîtier à retirer' });
    expect(associated.status).toBe(409);
    expect(associated.body.code).toBe('UNITE_ASSOCIEE');
    expect((await unit('TR-1')).ignoredAt).toBeNull();

    // Reprise : l'unité redevient à associer, l'alerte INFO est relevée de nouveau (même occurrence), audit.
    const resumed = await chefA.post(`/telemetry/units/${trailer.id}/unignore`, { reason: 'Remorque équipée d’un tracteur suivi' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ id: trailer.id, ignoredAt: null, ignoredById: null, ignoredReason: null });
    expect(await activeUnitAlerts()).toEqual([{ objectId: trailer.id, companyId: f.companies.A, severity: 'INFO' }]);
    expect(await t.prisma.client.alert.count({ where: { type: 'GPS_UNITE_NON_MAPPEE', objectId: trailer.id } })).toBe(1);
    expect(await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.unite.reprise', objectId: trailer.id } })).toMatchObject({
      actorUserId: f.users.chefA,
      reason: 'Remorque équipée d’un tracteur suivi',
    });
    const back = await chefA.get('/telemetry/units?category=NON_ASSOCIEES');
    expect(back.body.items.map((r: { unit: { id: string }; unmappedReason: string }) => [r.unit.id, r.unmappedReason])).toEqual([[trailer.id, 'IMMATRICULATION_ABSENTE']]);
    expect(back.body.counts).toMatchObject({ nonAssociees: 1, ignorees: 1 });
    expect((await chefA.post(`/telemetry/units/${trailer.id}/unignore`, {})).body.code).toBe('TRANSITION_INVALIDE');
  });

  it('D-101 / D-295 — désactivation par société : alertes F11 résolues, associations et données conservées ; réactivation', async () => {
    await enable('A');
    const vehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-OFF', registration: '500 TU 5000' });
    const provider = await simulator({
      units: [
        { externalId: 'OFF-1', label: 'Boîtier 1', declaredRegistration: '500 TU 5000', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
        { externalId: 'OFF-2', label: 'Boîtier orphelin', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
      ],
    });
    await admin.post(`/telemetry/providers/${provider.id}/discover`);
    const proposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle } });
    await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: proposal.version });
    const muteAlert = await t.prisma.client.alert.create({
      data: {
        organizationId: f.organizationId,
        companyId: f.companies.A,
        type: 'GPS_SOURCE_MUETTE',
        severity: 'ATTENTION',
        objectType: 'TelemetryVehicleMapping',
        objectId: proposal.id,
        vehicleId: vehicle,
        occurrenceKey: 'muette',
        title: 'Source GPS muette',
        message: 'Aucune donnée depuis 24 h.',
        condition: {},
        actionPath: '/telematique',
        triggeredAt: new Date(NOW),
        lastEvaluatedAt: new Date(NOW),
      },
    });
    expect(await activeUnitAlerts()).toHaveLength(1);

    const company = await t.prisma.client.company.findUniqueOrThrow({ where: { id: f.companies.A } });
    const stale = await admin.post(`/telemetry/companies/${f.companies.A}/disable`, { reason: 'Fin du contrat GPS', expectedVersion: company.version + 5 });
    expect(stale.status).toBe(409);
    const disabled = await admin.post(`/telemetry/companies/${f.companies.A}/disable`, { reason: 'Fin du contrat GPS', expectedVersion: company.version });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body).toMatchObject({ companyId: f.companies.A, telemetryEnabled: false, resolvedAlerts: 2 });
    expect(await activeUnitAlerts()).toHaveLength(0);
    expect(await t.prisma.client.alert.findUniqueOrThrow({ where: { id: muteAlert.id } })).toMatchObject({ status: 'RESOLUE', resolutionReason: 'Module télématique désactivé pour la société (D-101).' });
    // Associations conservées (suspendues de fait : l'ingestion exige telemetryEnabled), audit motivé.
    expect(await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'CONFIRME', validTo: null });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.societe.desactivation', objectId: f.companies.A } });
    expect(audit).toMatchObject({ reason: 'Fin du contrat GPS', actorUserId: f.users.admin });
    // Découverte sans société activée : refusée au chef (aucun appel externe) ; l'administrateur n'obtient ni proposition ni alerte.
    expect((await chefA.post(`/telemetry/providers/${provider.id}/discover`)).body.code).toBe('TELEMETRIE_DESACTIVEE');
    const discovery = await admin.post(`/telemetry/providers/${provider.id}/discover`);
    expect(discovery.body.proposalsCreated).toBe(0);
    expect(await activeUnitAlerts()).toHaveLength(0);
    const list = await admin.get('/telemetry/companies');
    expect(list.body.find((c: { companyId: string }) => c.companyId === f.companies.A)).toMatchObject({ telemetryEnabled: false, providers: [{ id: provider.id, kindLabel: 'SIMULATEUR — données fictives' }] });

    // La fiche société ne contourne pas l'activation motivée (ni alerte résolue, ni motif) : 422.
    const companyNow = await t.prisma.client.company.findUniqueOrThrow({ where: { id: f.companies.A } });
    const bypass = await admin.patch(`/companies/${f.companies.A}`, { telemetryEnabled: true, expectedVersion: companyNow.version });
    expect(bypass.status).toBe(422);
    expect(bypass.body.code).toBe('ACTIVATION_TELEMETRIE_DEDIEE');
    expect((await t.prisma.client.company.findUniqueOrThrow({ where: { id: f.companies.A } })).telemetryEnabled).toBe(false);
    const sameValue = await admin.patch(`/companies/${f.companies.A}`, { legalName: companyNow.legalName, telemetryEnabled: false, expectedVersion: companyNow.version });
    expect(sameValue.status, JSON.stringify(sameValue.body)).toBe(200);

    const enabled = await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Nouveau contrat' });
    expect(enabled.status).toBe(200);
    expect(await activeUnitAlerts()).toHaveLength(1);
  });

  it('Désactivation du fournisseur (état terminal) : associations clôturées, propositions rejetées ; un nouveau fournisseur peut équiper les véhicules', async () => {
    await enable('A');
    const vehicle = await createVehicle(t.prisma, f, 'A', { code: 'V-SWITCH', registration: '710 TU 7100' });
    const pending = await createVehicle(t.prisma, f, 'A', { code: 'V-PENDING', registration: '711 TU 7111' });
    const old = await simulator(
      {
        units: [
          { externalId: 'OLD-1', label: 'Ancien 1', declaredRegistration: '710 TU 7100', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
          { externalId: 'OLD-2', label: 'Ancien 2', declaredRegistration: '711 TU 7111', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
          { externalId: 'OLD-3', label: 'Ancien orphelin', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
        ],
      },
      ['A'],
      'Ancien fournisseur',
    );
    await admin.post(`/telemetry/providers/${old.id}/discover`);
    const proposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle } });
    const confirmed = await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: proposal.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await activeUnitAlerts()).toHaveLength(1);

    t.clock.advance(3_600_000);
    const current = (await admin.get(`/telemetry/providers/${old.id}`)).body as Provider;
    const deactivated = await admin.post(`/telemetry/providers/${old.id}/deactivate`, { reason: 'Changement de fournisseur', expectedVersion: current.version });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
    expect(await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({
      status: 'CLOTURE',
      validTo: new Date('2026-09-24T11:00:00.000Z'),
      closedReason: 'Fournisseur désactivé : Changement de fournisseur',
    });
    expect(await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: pending } })).toMatchObject({ status: 'REJETE' });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'telemetrie.association.cloture', objectId: proposal.id } })).toBe(1);
    expect(await activeUnitAlerts()).toHaveLength(0);
    // Les véhicules redeviennent « sans unité » ; les unités du fournisseur désactivé ne sont plus « à associer ».
    const counts = (await chefA.get('/telemetry/units')).body.counts;
    expect(counts).toEqual({ nonAssociees: 0, proposees: 0, associees: 0, vehiculesSansUnite: 2, ignorees: 0 });
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId: vehicle } })).toBe(0);

    // Le nouveau fournisseur propose et le chef confirme sans clôture manuelle préalable.
    const next = await simulator({ units: [{ externalId: 'NEW-1', label: 'Nouveau 1', declaredRegistration: '710-TU-7100', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }] }, ['A'], 'Nouveau fournisseur');
    const discovery = await chefA.post(`/telemetry/providers/${next.id}/discover`);
    expect(discovery.status, JSON.stringify(discovery.body)).toBe(200);
    expect(discovery.body).toMatchObject({ proposalsCreated: 1 });
    const fresh = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicle, status: 'PROPOSE' } });
    const reconfirmed = await chefA.post(`/telemetry/mappings/${fresh.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: fresh.version });
    expect(reconfirmed.status, JSON.stringify(reconfirmed.body)).toBe(200);
    // Date d'effet par défaut : jamais avant la fin de la précédente association du véhicule.
    expect(reconfirmed.body.validFrom).toBe('2026-09-24T11:00:00.000Z');
  });

  it('Découverte : périmètre du chef (rien de l’autre société) et exécutions concurrentes sans doublon', async () => {
    await enable('A');
    await enable('B');
    const vehicleA = await createVehicle(t.prisma, f, 'A', { code: 'V-SCOPE-A', registration: '810 TU 8100' });
    const vehicleB = await createVehicle(t.prisma, f, 'B', { code: 'V-SCOPE-B', registration: '820 TU 8200' });
    const provider = await simulator(
      {
        units: [
          { externalId: 'SC-A', label: 'Boîtier A', declaredRegistration: '810 TU 8100', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
          { externalId: 'SC-B', label: 'Boîtier B', declaredRegistration: '820 TU 8200', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
        ],
      },
      ['A', 'B'],
    );
    // Deux découvertes simultanées : unités et propositions créées une seule fois.
    const [first, second] = await Promise.all([admin.post(`/telemetry/providers/${provider.id}/discover`), admin.post(`/telemetry/providers/${provider.id}/discover`)]);
    expect([first.status, second.status], JSON.stringify([first.body, second.body])).toEqual([200, 200]);
    expect(first.body.proposalsCreated + second.body.proposalsCreated).toBe(2);
    expect(await t.prisma.client.telemetryUnit.count({ where: { providerId: provider.id } })).toBe(2);
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { providerId: provider.id, status: 'PROPOSE' } })).toBe(2);

    // Le chef de A relance la découverte : la proposition de B apparaît sans identifiant de véhicule ni d'association.
    const proposalB = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { vehicleId: vehicleB } });
    const scoped = await chefA.post(`/telemetry/providers/${provider.id}/discover`);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    const byExternal = new Map((scoped.body.units as Array<{ externalId: string; outcome: string; vehicleId: string | null; mappingId: string | null }>).map((u) => [u.externalId, u]));
    expect(byExternal.get('SC-A')).toMatchObject({ outcome: 'PROPOSEE', vehicleId: vehicleA });
    expect(byExternal.get('SC-B')).toMatchObject({ outcome: 'PROPOSEE', vehicleId: null, mappingId: null });
    expect(JSON.stringify(scoped.body)).not.toContain(vehicleB);
    expect(JSON.stringify(scoped.body)).not.toContain(proposalB.id);
    // L'administrateur voit tout.
    const full = await admin.post(`/telemetry/providers/${provider.id}/discover`);
    expect((full.body.units as Array<{ externalId: string; vehicleId: string | null }>).find((u) => u.externalId === 'SC-B')?.vehicleId).toBe(vehicleB);
  });

  it('Configuration fournisseur : validation, verrou optimiste, transitions, RPA refusé, suppression d’un brouillon', async () => {
    const rpa = await admin.post('/telemetry/providers', { name: 'Portail', kind: 'RPA', companyIds: [f.companies.A] });
    expect(rpa.status).toBe(422);
    expect(rpa.body).toMatchObject({ code: 'CANAL_RPA_INDISPONIBLE', message: 'Canal RPA non disponible en V1 : interface documentée, accord écrit du fournisseur requis (D-292)' });
    const kinds = await admin.get('/telemetry/provider-kinds');
    expect(kinds.body.find((k: { kind: string }) => k.kind === 'RPA')).toMatchObject({ available: false });
    expect(kinds.body.find((k: { kind: string }) => k.kind === 'SIMULATEUR')).toMatchObject({ available: true, label: 'SIMULATEUR — données fictives' });

    expect((await admin.post('/telemetry/providers', { name: 'Trop court', kind: 'TRACCAR', syncIntervalMinutes: 4, companyIds: [] })).status).toBe(422);
    const secretInSettings = await admin.post('/telemetry/providers', { name: 'Fuite', kind: 'TRACCAR', settings: { apiToken: 'abc' }, companyIds: [] });
    expect(secretInSettings.body.code).toBe('SECRET_DANS_PARAMETRES');
    expect((await admin.post('/telemetry/providers', { name: 'URL', kind: 'TRACCAR', baseUrl: 'https://gps.example.tn/api?token=abc', companyIds: [] })).body.code).toBe('VALIDATION');
    expect((await admin.post('/telemetry/providers', { name: 'Wialon HTTP', kind: 'WIALON', baseUrl: 'http://hst-api.wialon.com', settings: { odometerKind: 'DISTANCE_GPS' }, companyIds: [] })).body.code).toBe('PARAMETRES_INVALIDES');

    // Brouillon Wialon sans paramètres : accepté, mais activation refusée tant que la configuration est incomplète.
    const wialon = await createProvider({ name: 'Wialon', kind: 'WIALON', baseUrl: 'https://hst-api.wialon.com', companyIds: [f.companies.A] });
    expect(wialon).toMatchObject({ channel: 'API', status: 'BROUILLON', syncIntervalMinutes: 15, backfillDays: 7, credentials: [{ kind: 'JETON_API', configured: false, rotatedAt: null }] });
    const incomplete = await admin.post(`/telemetry/providers/${wialon.id}/activate`, { expectedVersion: wialon.version });
    expect(incomplete.body.code).toBe('PARAMETRES_INVALIDES');
    const patched = await admin.patch(`/telemetry/providers/${wialon.id}`, { settings: { odometerKind: 'DISTANCE_GPS' }, syncIntervalMinutes: 30, expectedVersion: wialon.version });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await admin.patch(`/telemetry/providers/${wialon.id}`, { name: 'Obsolète', expectedVersion: wialon.version })).status).toBe(409);
    const noToken = await admin.post(`/telemetry/providers/${wialon.id}/activate`, { expectedVersion: patched.body.version });
    expect(noToken.body.code).toBe('CONFIGURATION_INCOMPLETE');
    expect(noToken.body.details.problems).toEqual(['Jeton API non déposé.']);
    expect((await admin.put(`/telemetry/providers/${wialon.id}/credentials/IMAP`, { secret: 'u:p-secret' })).body.code).toBe('NATURE_SECRET_NON_ADMISE');
    expect((await admin.put(`/telemetry/providers/${wialon.id}/credentials/INCONNU`, { secret: 'secret-x' })).body.code).toBe('NATURE_SECRET_INCONNUE');
    const put = await admin.put(`/telemetry/providers/${wialon.id}/credentials/JETON_API`, { secret: 'jeton-wialon-lecture-seule' });
    expect(put.status).toBe(200);
    const active = await activate({ ...patched.body, version: patched.body.version } as Provider);
    const suspendNoReason = await admin.post(`/telemetry/providers/${wialon.id}/suspend`, { expectedVersion: active.version });
    expect(suspendNoReason.status).toBe(422);
    const suspended = await admin.post(`/telemetry/providers/${wialon.id}/suspend`, { reason: 'Maintenance fournisseur', expectedVersion: active.version });
    expect(suspended.body.status).toBe('SUSPENDU');
    expect((await admin.post(`/telemetry/providers/${wialon.id}/activate`, { expectedVersion: suspended.body.version })).body.status).toBe('ACTIF');
    const current = (await admin.get(`/telemetry/providers/${wialon.id}`)).body as Provider;
    const deactivated = await admin.post(`/telemetry/providers/${wialon.id}/deactivate`, { reason: 'Changement de fournisseur', expectedVersion: current.version });
    expect(deactivated.body.status).toBe('DESACTIVE');
    expect((await admin.post(`/telemetry/providers/${wialon.id}/activate`, { expectedVersion: deactivated.body.version })).body.code).toBe('TRANSITION_INVALIDE');
    expect((await admin.patch(`/telemetry/providers/${wialon.id}`, { name: 'Réveil', expectedVersion: deactivated.body.version })).body.code).toBe('FOURNISSEUR_DESACTIVE');
    expect((await admin.delete(`/telemetry/providers/${wialon.id}?expectedVersion=${deactivated.body.version}`)).status).toBe(409);

    expect((await admin.post('/telemetry/providers', { name: 'Wialon', kind: 'TRACCAR', companyIds: [] })).status).toBe(409);
    const draft = await createProvider({ name: 'Brouillon', kind: 'TRACCAR', baseUrl: 'https://traccar.example.tn', companyIds: [] });
    expect((await admin.post(`/telemetry/providers/${draft.id}/activate`, { expectedVersion: draft.version })).body.details.problems).toEqual(['Aucune société couverte par ce fournisseur.', 'Jeton API ou identifiants API non déposés.']);
    expect((await admin.delete(`/telemetry/providers/${draft.id}?expectedVersion=${draft.version}`)).status).toBe(204);
    expect((await admin.get(`/telemetry/providers/${draft.id}`)).status).toBe(404);
  });

  it('D-303 — simulateur : refusé si non activé sur l’instance ; démarrage du worker refusé en production avec un simulateur actif', async () => {
    const provider = await simulator({ units: [] });
    await expect(assertNoActiveSimulatorInProduction(t.prisma, { nodeEnv: 'production' })).rejects.toThrow(/SIMULATEUR — données fictives/);
    await expect(assertNoActiveSimulatorInProduction(t.prisma.client, { nodeEnv: 'test' })).resolves.toBeUndefined();
    const deactivated = await admin.post(`/telemetry/providers/${provider.id}/deactivate`, { reason: 'Fin de recette', expectedVersion: provider.version });
    expect(deactivated.status).toBe(200);
    await expect(assertNoActiveSimulatorInProduction(t.prisma, { nodeEnv: 'production' })).resolves.toBeUndefined();

    const other = await startTestApp({ now: NOW, telemetrySimulator: false });
    try {
      const otherAdmin = await login(other.server, f.emails.admin, DEFAULT_PASSWORD);
      const refused = await otherAdmin.post('/telemetry/providers', { name: 'Simulateur interdit', kind: 'SIMULATEUR', settings: { scenario: { units: [] } }, companyIds: [f.companies.A] });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('SIMULATEUR_NON_ACTIVE');
      const draft = await createProvider({ name: 'Simulateur brouillon', kind: 'SIMULATEUR', settings: { scenario: { units: [] } }, companyIds: [f.companies.A] });
      const activation = await otherAdmin.post(`/telemetry/providers/${draft.id}/activate`, { expectedVersion: draft.version });
      expect(activation.body.code).toBe('SIMULATEUR_NON_ACTIVE');
    } finally {
      await other.close();
    }
  });

  it('T44 — secrets : jamais restitués par l’API, uniquement chiffrés en base, absents des journaux (création, test de connexion en échec d’authentification)', async () => {
    await enable('A');
    const sentinel = `Sentinelle${randomUUID().replace(/-/g, '')}`;
    // Fragments : toute fenêtre de 8 caractères de la partie aléatoire du secret.
    const random = sentinel.slice('Sentinelle'.length);
    const fragments = Array.from({ length: random.length - 7 }, (_, i) => random.slice(i, i + 8));
    const variants = [sentinel, Buffer.from(sentinel).toString('base64'), Buffer.from(sentinel).toString('hex'), Buffer.from(`lecteur@parc.tn:${sentinel}`).toString('base64').slice(0, 24)];

    // Serveur Traccar local qui refuse l'authentification (HTTP 401) : appel réel de l'adaptateur.
    const authorizations: string[] = [];
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith('/api/server')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: '6.15.3' }));
        return;
      }
      authorizations.push(req.headers.authorization ?? '');
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end(`Unauthorized ${req.headers.authorization ?? ''}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // Capture des journaux : le journal Nest et la console écrivent tous deux sur process.stdout / process.stderr.
    const logs: string[] = [];
    const originals = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    const capture = (chunk: unknown) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };
    process.stdout.write = capture;
    process.stderr.write = capture;
    let sim: Provider;
    let traccar: Provider;
    const responses: string[] = [];
    try {
      sim = await createProvider({
        name: 'Simulateur T44',
        kind: 'SIMULATEUR',
        baseUrl: 'https://simulateur.test',
        settings: { scenario: { authRequired: true, echoRequestUrlInErrors: true, failures: [{ mode: 'AUTHENTIFICATION' }], units: [{ externalId: 'S-1', label: 'Unité', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'] }] } },
        companyIds: [f.companies.A],
      });
      const put = await admin.put(`/telemetry/providers/${sim.id}/credentials/JETON_API`, { secret: sentinel });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ kind: 'JETON_API', configured: true, rotatedAt: NOW });
      responses.push(JSON.stringify(put.body));
      sim = await activate((await admin.get(`/telemetry/providers/${sim.id}`)).body as Provider);

      const health = await admin.post(`/telemetry/providers/${sim.id}/health`);
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(false);
      expect(health.body.message).toMatch(/^SIMULATEUR — données fictives/);
      expect(health.body.message).toContain('authentification refusée');
      responses.push(JSON.stringify(health.body));

      // Découverte : l'erreur brute du client cite l'URL avec le jeton ; tout est assaini avant réponse et journal.
      const discovery = await admin.post(`/telemetry/providers/${sim.id}/discover`);
      expect(discovery.status).toBe(502);
      expect(discovery.body.code).toBe('FOURNISSEUR_EN_ECHEC');
      expect(discovery.body.details.errorKind).toBe('AUTHENTIFICATION');
      expect(discovery.body.message).toContain('token=[expurgé]');
      responses.push(JSON.stringify(discovery.body));

      traccar = await createProvider({ name: 'Traccar local', kind: 'TRACCAR', baseUrl: `http://127.0.0.1:${port}`, companyIds: [f.companies.A] });
      expect((await admin.put(`/telemetry/providers/${traccar.id}/credentials/IDENTIFIANTS_API`, { secret: sentinel })).body.code).toBe('VALIDATION');
      const creds = await admin.put(`/telemetry/providers/${traccar.id}/credentials/IDENTIFIANTS_API`, { secret: `lecteur@parc.tn:${sentinel}` });
      expect(creds.status).toBe(200);
      responses.push(JSON.stringify(creds.body));
      const traccarHealth = await admin.post(`/telemetry/providers/${traccar.id}/health`);
      expect(traccarHealth.status).toBe(200);
      expect(traccarHealth.body).toMatchObject({ ok: false });
      expect(traccarHealth.body.message).toContain('HTTP 401');
      responses.push(JSON.stringify(traccarHealth.body));
    } finally {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Le secret déchiffré a bien servi à l'appel réel (en mémoire uniquement).
    expect(authorizations).toEqual([`Basic ${Buffer.from(`lecteur@parc.tn:${sentinel}`).toString('base64')}`]);

    // Journaux capturés : les échecs sont tracés, sans secret ni jeton.
    const journal = logs.join('');
    expect(journal).toContain('Test de connexion en échec');
    expect(journal).toContain('Découverte des unités en échec');
    for (const v of [...variants, ...fragments]) expect(journal).not.toContain(v);

    // Lectures API : configuration, listes, exécutions, sociétés — aucun secret ni fragment.
    for (const path of ['/telemetry/providers', `/telemetry/providers/${sim.id}`, `/telemetry/providers/${traccar.id}`, '/telemetry/sync-runs', '/telemetry/companies', '/telemetry/units']) {
      const res = await admin.get(path);
      expect(res.status).toBe(200);
      responses.push(JSON.stringify(res.body));
    }
    const detail = (await admin.get(`/telemetry/providers/${traccar.id}`)).body as { credentials: Array<Record<string, unknown>> };
    expect(detail.credentials).toEqual([
      { kind: 'JETON_API', configured: false, rotatedAt: null },
      { kind: 'IDENTIFIANTS_API', configured: true, rotatedAt: NOW },
    ]);
    const all = responses.join('\n');
    for (const v of [...variants, ...fragments]) expect(all).not.toContain(v);

    // Base : le secret n'existe que chiffré (AES-256-GCM, identifiant de clé) ; aucune table ne le contient en clair.
    const stored = await t.prisma.client.telemetryCredential.findMany();
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.keyId).toBe('k1');
      expect(Buffer.from(row.iv)).toHaveLength(12);
      expect(Buffer.from(row.authTag)).toHaveLength(16);
      expect(Buffer.from(row.ciphertext).includes(Buffer.from(sentinel))).toBe(false);
    }
    const tables = await t.prisma.client.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    for (const { tablename } of tables) {
      const rows = await t.prisma.client.$queryRawUnsafe<Array<{ j: string }>>(`SELECT row_to_json(x)::text AS j FROM "${tablename}" x`);
      const dump = rows.map((r) => r.j).join('\n');
      for (const v of variants) expect(dump, `table ${tablename}`).not.toContain(v);
    }
    const runs = await t.prisma.client.telemetrySyncRun.findMany();
    expect(runs.map((r) => r.status)).toEqual(['ECHEC']);
    expect(runs[0]?.errorSummary).toContain('[expurgé]');
  });

  it('D-304 — rotation : l’ancienne clé reste déchiffrable, le script rechiffre sous la nouvelle (simulation par défaut)', async () => {
    const provider = await createProvider({ name: 'Rotation', kind: 'TRACCAR', baseUrl: 'https://traccar.example.tn', companyIds: [f.companies.A] });
    const secret = 'jeton-rotation-9c1e5d';
    expect((await admin.put(`/telemetry/providers/${provider.id}/credentials/JETON_API`, { secret })).status).toBe(200);
    const before = await t.prisma.client.telemetryCredential.findFirstOrThrow({ where: { providerId: provider.id } });
    expect(before.keyId).toBe('k1');

    const K2 = Buffer.alloc(32, 11).toString('base64');
    const rotatingEnv = loadEnv({ NODE_ENV: 'test', DATABASE_URL: t.env.databaseUrl, SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: 'k2', SECRETS_ENCRYPTION_PREVIOUS_KEYS: `k1:${TEST_KEY_K1}` });
    const rotating = new SecretsCryptoService(rotatingEnv);
    const toSecret = (row: typeof before) => ({ keyId: row.keyId, iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), ciphertext: Buffer.from(row.ciphertext) });
    expect(rotating.decrypt(toSecret(before))).toBe(secret);
    const deps = { prisma: t.prisma, crypto: rotating, audit: t.app.get(AuditService) };

    const dryRun = await rotateTelemetrySecrets(deps, { apply: false });
    expect(dryRun).toEqual({ activeKeyId: 'k2', dryRun: true, total: 1, byKeyId: { k1: 1 }, alreadyOnActiveKey: 0, toReencrypt: 1, reencrypted: 0, undecryptable: [] });
    expect((await t.prisma.client.telemetryCredential.findFirstOrThrow({ where: { id: before.id } })).keyId).toBe('k1');

    const applied = await rotateTelemetrySecrets(deps, { apply: true });
    expect(applied).toMatchObject({ dryRun: false, toReencrypt: 1, reencrypted: 1, undecryptable: [] });
    expect(JSON.stringify(applied)).not.toContain(secret);
    const after = await t.prisma.client.telemetryCredential.findFirstOrThrow({ where: { id: before.id } });
    expect(after.keyId).toBe('k2');
    expect(Buffer.from(after.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(false);
    const onlyNew = new SecretsCryptoService(loadEnv({ NODE_ENV: 'test', DATABASE_URL: t.env.databaseUrl, SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: 'k2' }));
    expect(onlyNew.decrypt(toSecret(after))).toBe(secret);
    expect(() => t.app.get(SecretsCryptoService).decrypt(toSecret(after))).toThrow(/clé absente du trousseau/);
    expect(await rotateTelemetrySecrets(deps, { apply: true })).toMatchObject({ alreadyOnActiveKey: 1, toReencrypt: 0, reencrypted: 0 });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.secrets.rechiffrement' } });
    expect(audit).toMatchObject({ actorType: 'SYSTEME', organizationId: f.organizationId });
    expect(JSON.stringify(audit.after)).not.toContain(secret);

    // Un secret sous une clé inconnue du trousseau est signalé, jamais perdu silencieusement.
    await t.prisma.client.telemetryCredential.update({ where: { id: before.id }, data: { keyId: 'k0' } });
    const unknown = await rotateTelemetrySecrets(deps, { apply: true });
    expect(unknown.undecryptable).toEqual([{ credentialId: before.id, providerId: provider.id, kind: 'JETON_API', keyId: 'k0', reason: 'Clé absente du trousseau (SECRETS_ENCRYPTION_PREVIOUS_KEYS).' }]);
  });
});
