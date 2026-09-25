import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import SftpClient from 'ssh2-sftp-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sshHostKeyFingerprint } from '../../src/modules/telemetry/adapters/report-generic.adapter.js';
import { TelemetrySyncService } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';
const DATA_OPERATIONS = ['getOdometers', 'getOdometerHistory', 'getFuel'];

interface Provider {
  id: string;
  version: number;
  [key: string]: unknown;
}

function can(unit: string, valueKm: string, observedAt: string, sourceReference: string | null = null) {
  return { unitExternalId: unit, kind: 'COMPTEUR_CAN', valueKm, observedAt, ...(sourceReference ? { sourceReference } : {}) };
}

function gps(unit: string, valueKm: string, observedAt: string) {
  return { unitExternalId: unit, kind: 'DISTANCE_GPS', valueKm, observedAt };
}

function probe(unit: string, liters: string, observedAt: string, engineOn = false) {
  return { unitExternalId: unit, kind: 'NIVEAU_SONDE', liters, engineOn, speedKmh: '0', observedAt };
}

describe('Connecteur télématique — synchronisation et ingestion (CDC 5.6, 8.5, 14.4 ; T31, T36 à T43)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;
  let sleeps: number[];
  let loggedInAt = 0;

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
    loggedInAt = new Date(NOW).getTime();
    sleeps = [];
  });

  /** Sessions renouvelées quand l'horloge contrôlée avance de plusieurs heures (durée de session de 12 h). */
  async function ensureSessions(at: string): Promise<void> {
    const instant = new Date(at).getTime();
    if (Math.abs(instant - loggedInAt) < 6 * 3_600_000) return;
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    loggedInAt = instant;
  }

  // ---------------------------------------------------------------------------------------------
  // Aides
  // ---------------------------------------------------------------------------------------------

  /** Passage planifié du worker à l'instant donné (horloge contrôlée, attentes de reprise simulées et relevées). */
  async function runDue(at: string) {
    t.clock.set(at);
    await ensureSessions(at);
    return t.app.get(TelemetrySyncService).runDue(new Date(at), {
      holder: 'worker-test',
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
  }

  async function setCompany(enabled: boolean): Promise<void> {
    const res = await admin.post(`/telemetry/companies/${f.companies.A}/${enabled ? 'enable' : 'disable'}`, { reason: enabled ? 'Mise en service du module F11' : 'Suspension du module F11' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.telemetryEnabled).toBe(enabled);
  }

  /**
   * Véhicule de la société A (compteur initialisé), fournisseur SIMULATEUR actif, unité découverte et
   * association confirmée par le chef de parc à l'instant courant de l'horloge.
   */
  async function provision(options: {
    at: string;
    unit: string;
    scenario: Record<string, unknown>;
    odometerKind: 'COMPTEUR_CAN' | 'DISTANCE_GPS' | 'AUCUN';
    fuelKinds?: string[];
    init?: { km: string; at: string } | null;
    vehicle?: { energy?: string; tankCapacityLiters?: string };
    token?: string;
  }): Promise<{ provider: Provider; vehicleId: string; mappingId: string; unitId: string }> {
    t.clock.set(options.at);
    await setCompany(true);
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: `V-${options.unit}` });
    if (options.vehicle) {
      const patched = await chefA.patch(`/vehicles/${vehicleId}`, { ...options.vehicle, expectedVersion: 1 });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    }
    const init = options.init === undefined ? { km: '10000', at: '2026-09-01T08:00:00Z' } : options.init;
    if (init) {
      const seg = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: init.at, physicalKm: init.km });
      expect(seg.status, JSON.stringify(seg.body)).toBe(201);
    }
    const created = await admin.post('/telemetry/providers', { name: `Simulateur ${options.unit}`, kind: 'SIMULATEUR', settings: { scenario: options.scenario }, companyIds: [f.companies.A] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (options.token) {
      const secret = await admin.put(`/telemetry/providers/${created.body.id}/credentials/JETON_API`, { secret: options.token });
      expect(secret.status, JSON.stringify(secret.body)).toBe(200);
    }
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const discovered = await admin.post(`/telemetry/providers/${created.body.id}/discover`);
    expect(discovered.status, JSON.stringify(discovered.body)).toBe(200);
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: created.body.id, externalId: options.unit } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: options.odometerKind, fuelKinds: options.fuelKinds ?? [] });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    return { provider: activated.body as Provider, vehicleId, mappingId: mapping.body.id as string, unitId: unit.id };
  }

  function unitDef(externalId: string, odometerKinds: string[], fuelKinds: string[] = []) {
    return { externalId, label: `Boîtier ${externalId}`, declaredRegistration: null, odometerKinds, fuelKinds };
  }

  async function permits(): Promise<void> {
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
  }

  async function manualReading(vehicleId: string, physicalKm: string, observedAt: string) {
    t.clock.set(observedAt);
    await ensureSessions(observedAt);
    const res = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { outcome: string; reading: { id: string; status: string } };
  }

  async function checkout(vehicleId: string, km: string, at: string, expectedReturnAt: string) {
    t.clock.set(at);
    await ensureSessions(at);
    const res = await operateurA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: at, expectedReturnAt, purpose: 'Mission', reading: { physicalKm: km }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'DEMI', checklist: [{ label: 'Clés', present: true }] })
      .set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  async function giveBack(usage: { id: string; version: number }, km: string, at: string) {
    t.clock.set(at);
    await ensureSessions(at);
    const current = await operateurA.get(`/usages/${usage.id}`);
    const res = await operateurA.post(`/usages/${usage.id}/return`, { returnedAt: at, reading: { physicalKm: km }, location: { placeLabel: 'Dépôt' }, expectedVersion: current.body.version }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function telematicsReadings(vehicleId: string) {
    return t.prisma.client.odometerReading.findMany({ where: { vehicleId, source: 'TELEMATICS' }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }] });
  }

  async function activeAlerts(type: string) {
    return t.prisma.client.alert.findMany({ where: { type: type as never, status: 'ACTIVE' } });
  }

  async function waitRun(id: string) {
    for (let i = 0; i < 600; i += 1) {
      const run = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id } });
      if (run.status !== 'EN_COURS') return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Run ${id} toujours en cours.`);
  }

  // ---------------------------------------------------------------------------------------------
  // T31 — sans GPS, puis fournisseur injoignable (coupe-circuit et reprise)
  // ---------------------------------------------------------------------------------------------

  it('T31 — F11 désactivé : aucun appel, parcours manuels complets ; fournisseur injoignable : reprises 1-4-16 s, délai exponentiel, coupe-circuit, alertes distinctes, parcours manuels intacts, reprise au premier succès', async () => {
    await permits();
    const { provider, vehicleId, mappingId } = await provision({
      at: '2026-09-24T09:00:00Z',
      unit: 'U-31',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '30000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-31', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-31', '30150', '2026-09-25T11:50:00Z')],
        failures: [{ mode: 'INJOIGNABLE', from: '2026-09-24T09:30:00Z', until: '2026-09-25T12:00:00Z', operations: DATA_OPERATIONS }],
        supportsHistory: false,
      },
    });

    // Phase 1 — module désactivé pour la société : aucune synchronisation, aucun appel, parcours manuels complets.
    await setCompany(false);
    const idle = await runDue('2026-09-24T09:05:00Z');
    expect(idle.runs).toEqual([]);
    expect(await t.prisma.client.telemetrySyncRun.count({ where: { companyId: { not: null } } })).toBe(0);
    expect(await t.prisma.client.telemetryUnitState.count()).toBe(0);
    const refused = await chefA.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('TELEMETRIE_DESACTIVEE');
    const usage = await checkout(vehicleId, '30010', '2026-09-24T09:06:00Z', '2026-09-24T18:00:00Z');
    await giveBack(usage, '30020', '2026-09-24T09:08:00Z');
    expect((await manualReading(vehicleId, '30025', '2026-09-24T09:10:00Z')).outcome).toBe('ACCEPTE');

    // Phase 2 — module réactivé, fournisseur injoignable : run en échec après 3 reprises (1, 4, 16 s).
    t.clock.set('2026-09-24T09:30:00Z');
    await setCompany(true);
    const first = await runDue('2026-09-24T09:30:00Z');
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({ status: 'ECHEC', trigger: 'REPRISE_INITIALE', companyId: f.companies.A });
    expect(sleeps).toEqual([1000, 4000, 16000]);
    const failedRun = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: first.runs[0]?.runId as string } });
    expect(failedRun.errorSummary).toContain('Fournisseur injoignable');
    expect(failedRun.errorSummary).toContain('SIMULATEUR — données fictives');
    expect((await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } })).consecutiveFailures).toBe(1);
    // Parcours manuel pendant la panne.
    expect((await manualReading(vehicleId, '30030', '2026-09-24T09:35:00Z')).outcome).toBe('ACCEPTE');

    // Délai entre runs : intervalle × 2^n (30 min après 1 échec, puis plafonné à 60 min).
    expect((await runDue('2026-09-24T09:45:00Z')).runs).toEqual([]);
    for (const at of ['2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z', '2026-09-24T12:00:00Z']) {
      const r = await runDue(at);
      expect(r.runs.map((x) => x.status), at).toEqual(['ECHEC']);
    }
    expect((await runDue('2026-09-24T12:45:00Z')).runs).toEqual([]);
    expect(await activeAlerts('GPS_SYNCHRO_EN_ECHEC')).toHaveLength(0);

    // 5e échec : coupe-circuit ouvert 60 min, alerte GPS_SYNCHRO_EN_ECHEC levée à l'ouverture.
    expect((await runDue('2026-09-24T13:00:00Z')).runs.map((x) => x.status)).toEqual(['ECHEC']);
    let state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state.consecutiveFailures).toBe(5);
    expect(state.circuitOpenUntil?.toISOString()).toBe('2026-09-24T14:00:00.000Z');
    const circuit = await activeAlerts('GPS_SYNCHRO_EN_ECHEC');
    expect(circuit).toHaveLength(1);
    expect(circuit[0]).toMatchObject({ companyId: f.companies.A, objectType: 'TelemetryProvider', objectId: provider.id, severity: 'URGENT' });
    expect(await activeAlerts('GPS_SOURCE_MUETTE')).toHaveLength(0);

    // Coupe-circuit ouvert : créneaux tracés IGNORE sans appel ; la synchronisation manuelle aussi.
    const sleepsBefore = sleeps.length;
    const ignored = await runDue('2026-09-24T13:15:00Z');
    expect(ignored.runs.map((x) => x.status)).toEqual(['IGNORE']);
    expect(sleeps.length).toBe(sleepsBefore);
    t.clock.set('2026-09-24T13:20:00Z');
    const manualIgnored = await chefA.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(manualIgnored.status, JSON.stringify(manualIgnored.body)).toBe(202);
    expect(manualIgnored.body.runs).toEqual([expect.objectContaining({ status: 'IGNORE', alreadyRunning: false, companyId: f.companies.A })]);
    expect(manualIgnored.body.runs[0].message).toContain('Coupe-circuit ouvert');
    const ignoredRuns = await chefA.get(`/telemetry/sync-runs?providerId=${provider.id}&status=IGNORE`);
    expect(ignoredRuns.body.total).toBe(2);

    // Essai unique à l'expiration : pas de reprise dans le run ; nouvel échec → coupe-circuit rouvert.
    const halfOpen = await runDue('2026-09-24T14:00:00Z');
    expect(halfOpen.runs.map((x) => x.status)).toEqual(['ECHEC']);
    expect(sleeps.length).toBe(sleepsBefore);
    state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state.circuitOpenUntil?.toISOString()).toBe('2026-09-24T15:00:00.000Z');

    // Plus de 24 h sans synchronisation réussie : une alerte « source muette » agrégée par fournisseur
    // (distincte de GPS_SYNCHRO_EN_ECHEC), aucune alerte par unité ; saisie manuelle toujours possible.
    await runDue('2026-09-25T10:00:00Z');
    const silent = await activeAlerts('GPS_SOURCE_MUETTE');
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ objectType: 'TelemetryProvider', objectId: provider.id, companyId: f.companies.A });
    expect(silent[0]?.message).toContain('relevé manuel');
    expect(await activeAlerts('GPS_SYNCHRO_EN_ECHEC')).toHaveLength(1);
    expect((await manualReading(vehicleId, '30100', '2026-09-25T10:05:00Z')).outcome).toBe('ACCEPTE');
    const vehicleDuring = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(vehicleDuring.body.odometer).toMatchObject({ physicalKm: '30100.000', source: 'MANUAL', freshness: 'A_JOUR' });

    // Fournisseur rétabli : essai unique réussi, coupe-circuit fermé, alertes résolues, relevé CAN ingéré.
    expect((await runDue('2026-09-25T11:00:00Z')).runs.map((x) => x.status)).toEqual(['ECHEC']);
    const recovered = await runDue('2026-09-25T12:00:00Z');
    expect(recovered.runs.map((x) => x.status)).toEqual(['SUCCES']);
    state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state).toMatchObject({ consecutiveFailures: 0, circuitOpenUntil: null, lastErrorSummary: null });
    expect(await activeAlerts('GPS_SYNCHRO_EN_ECHEC')).toHaveLength(0);
    expect(await activeAlerts('GPS_SOURCE_MUETTE')).toHaveLength(0);
    const readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.measurementKind])).toEqual([['30150', 'ACCEPTE', 'COMPTEUR_CAN']]);
    const after = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(after.body.odometer).toMatchObject({ physicalKm: '30150.000', source: 'TELEMATICS', measurementKind: 'COMPTEUR_CAN', freshness: 'A_JOUR' });
    const mappingAlerts = await t.prisma.client.alert.count({ where: { objectId: mappingId, status: 'ACTIVE' } });
    expect(mappingAlerts).toBe(0);
  });

  it('quota 429 : Retry-After respecté dans le run, plus aucun appel une fois le quota atteint ; au-delà du plafond, appel suivant différé (IGNORE) sans ouvrir le coupe-circuit ; aucun secret dans les journaux, les runs, l’état ni les alertes (T44)', async () => {
    const token = `jeton-sentinelle-${randomUUID()}`;
    // Journaux réellement capturés : le journal Nest écrit sur process.stdout / process.stderr.
    const logs: string[] = [];
    const originals = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    const capture = (chunk: unknown) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      await quotaScenario(token);
    } finally {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
    }
    const journal = logs.join('');
    expect(journal).toContain('quota dépassé (HTTP 429, Retry-After 20 s)');
    expect(journal).toContain('token=[expurgé]');
    expect(journal).not.toContain(token);
  });

  async function quotaScenario(token: string): Promise<void> {
    const { provider } = await provision({
      at: '2026-09-24T09:55:00Z',
      unit: 'U-429',
      odometerKind: 'COMPTEUR_CAN',
      token,
      scenario: {
        authRequired: true,
        echoRequestUrlInErrors: true,
        units: [unitDef('U-429', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-429', '10100', '2026-09-24T09:00:00Z')],
        failures: [
          { mode: 'QUOTA', retryAfterSeconds: 20, from: '2026-09-24T10:00:00Z', until: '2026-09-24T10:10:00Z', operations: DATA_OPERATIONS },
          { mode: 'QUOTA', retryAfterSeconds: 7200, from: '2026-09-24T10:30:00Z', until: '2026-09-24T10:40:00Z', operations: DATA_OPERATIONS },
        ],
      },
    });
    const first = await runDue('2026-09-24T10:00:00Z');
    expect(first.runs.map((r) => r.status)).toEqual(['ECHEC']);
    // État courant repris 3 fois après 20 s (Retry-After) ; le quota restant atteint, l'historique de la
    // reprise initiale n'est pas demandé dans la même synchronisation.
    expect(sleeps).toEqual([20000, 20000, 20000]);
    const firstRun = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: first.runs[0]?.runId as string } });
    expect(firstRun.errorSummary).toContain('Historique kilométrique (reprise initiale) non tenté : quota du fournisseur atteint');
    const second = await runDue('2026-09-24T10:30:00Z');
    expect(second.runs.map((r) => r.status)).toEqual(['ECHEC']);
    expect(sleeps).toHaveLength(3);
    let state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state.consecutiveFailures).toBe(2);
    expect(state.circuitOpenUntil?.toISOString()).toBe('2026-09-24T12:30:00.000Z');
    expect(await activeAlerts('GPS_SYNCHRO_EN_ECHEC')).toHaveLength(0);
    const held = await runDue('2026-09-24T11:30:00Z');
    expect(held.runs.map((r) => r.status)).toEqual(['IGNORE']);
    const heldRun = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: held.runs[0]?.runId as string } });
    expect(heldRun.errorSummary).toContain('Quota du fournisseur');
    const resumed = await runDue('2026-09-24T12:30:00Z');
    expect(resumed.runs.map((r) => r.status)).toEqual(['SUCCES']);
    state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state).toMatchObject({ consecutiveFailures: 0, circuitOpenUntil: null });
    // T44 : le jeton cité par le client HTTP simulé dans ses erreurs n'apparaît nulle part.
    const runs = await t.prisma.client.telemetrySyncRun.findMany({ where: { providerId: provider.id } });
    const firstFailure = runs.find((r) => r.status === 'ECHEC');
    expect(firstFailure?.errorSummary).toContain('quota dépassé');
    const exposed = JSON.stringify({
      runs,
      provider: await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } }),
      alerts: await t.prisma.client.alert.findMany(),
      audit: await t.prisma.client.auditEvent.findMany(),
      api: (await chefA.get(`/telemetry/sync-runs?providerId=${provider.id}`)).body,
      view: (await admin.get(`/telemetry/providers/${provider.id}`)).body,
    });
    expect(exposed).not.toContain(token);
  }

  // ---------------------------------------------------------------------------------------------
  // T36, T37 — idempotence, compteur CAN, synchronisation manuelle
  // ---------------------------------------------------------------------------------------------

  it('T36 et T37 — CAN 50 000 puis 50 120, manuel 50 130 une heure après : acceptés, compteur courant 50 130 ; même lot reçu deux fois : aucun doublon de relevé ni d’événement carburant', async () => {
    const { provider, vehicleId, unitId } = await provision({
      at: NOW,
      unit: 'U-37',
      odometerKind: 'COMPTEUR_CAN',
      fuelKinds: ['NIVEAU_SONDE'],
      init: { km: '49800', at: '2026-09-20T08:00:00Z' },
      vehicle: { energy: 'DIESEL', tankCapacityLiters: '80' },
      scenario: {
        units: [unitDef('U-37', ['COMPTEUR_CAN'], ['NIVEAU_SONDE'])],
        // 50 000 sans référence fournisseur (clé de repli), 50 120 avec référence ; chaque échantillon livré deux fois, en désordre.
        odometerSamples: [can('U-37', '50000', '2026-09-24T08:00:00Z'), can('U-37', '50120', '2026-09-24T09:00:00Z', 'can-50120')],
        fuelSamples: [probe('U-37', '30', '2026-09-24T08:00:00Z'), probe('U-37', '30', '2026-09-24T08:05:00Z'), probe('U-37', '50', '2026-09-24T08:10:00Z'), probe('U-37', '70', '2026-09-24T08:15:00Z'), probe('U-37', '70', '2026-09-24T08:20:00Z')],
        duplicates: true,
        order: 'INVERSE',
      },
    });

    const first = await runDue(NOW);
    expect(first.runs).toEqual([expect.objectContaining({ trigger: 'REPRISE_INITIALE', status: 'SUCCES' })]);
    const run1 = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: first.runs[0]?.runId as string } });
    expect(run1).toMatchObject({ readingsCreated: 2, readingsPending: 0, unitsSeen: 1, fuelEventsCreated: 1, errorCount: 0 });
    expect(run1.duplicatesIgnored).toBeGreaterThanOrEqual(4);
    let readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.cumulativeKm?.toString(), r.status, r.measurementKind, r.isEstimate, r.context, r.channel])).toEqual([
      ['50000', '50000', 'ACCEPTE', 'COMPTEUR_CAN', false, 'SYNCHRONISATION', 'API'],
      ['50120', '50120', 'ACCEPTE', 'COMPTEUR_CAN', false, 'SYNCHRONISATION', 'API'],
    ]);
    expect(readings.every((r) => r.providerId === provider.id && r.providerUnitId === 'U-37' && r.receivedAt !== null && r.createdById === null)).toBe(true);
    // D-303 : relevés et exécutions du simulateur libellés « SIMULATEUR — données fictives ».
    expect(readings.every((r) => r.note === 'SIMULATEUR — données fictives')).toBe(true);
    expect(run1.errorSummary).toContain('SIMULATEUR — données fictives : exécution sur des données simulées.');
    expect(readings[0]?.sourceReference).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(readings[1]?.sourceReference).toBe('can-50120');
    expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId } })).toBe(2);
    const unitState = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } });
    expect(unitState.lastOdometerValueKm?.toString()).toBe('50120');
    expect(unitState.lastOdometerObservedAt?.toISOString()).toBe('2026-09-24T09:00:00.000Z');
    expect(await t.prisma.client.fuelEvent.count()).toBe(1);

    // T37 : relevé manuel 50 130 une heure après le dernier CAN → accepté, compteur courant 50 130.
    const manual = await manualReading(vehicleId, '50130', '2026-09-24T10:00:00Z');
    expect(manual.outcome).toBe('ACCEPTE');
    const vehicle = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(vehicle.body.odometer).toMatchObject({ physicalKm: '50130.000', source: 'MANUAL', measurementKind: 'COMPTEUR_AFFICHE', isEstimate: false });

    // T36 : même lot reçu à nouveau (passage planifié puis synchronisation manuelle) → aucun doublon.
    const second = await runDue('2026-09-24T10:20:00Z');
    expect(second.runs).toEqual([expect.objectContaining({ trigger: 'PLANIFIE', status: 'SUCCES' })]);
    const run2 = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: second.runs[0]?.runId as string } });
    expect(run2).toMatchObject({ readingsCreated: 0, fuelEventsCreated: 0, fuelSamples: 0 });
    expect(run2.duplicatesIgnored).toBeGreaterThan(0);

    // Synchronisation manuelle : réservée à l'administrateur et au chef de parc des sociétés couvertes.
    t.clock.set('2026-09-24T10:25:00Z');
    expect((await conducteurA.post(`/telemetry/providers/${provider.id}/sync`, {})).status).toBe(403);
    expect((await operateurA.post(`/telemetry/providers/${provider.id}/sync`, {})).status).toBe(403);
    expect((await lecteurA.post(`/telemetry/providers/${provider.id}/sync`, {})).status).toBe(403);
    expect((await chefB.post(`/telemetry/providers/${provider.id}/sync`, {})).status).toBe(404);
    expect((await chefA.post(`/telemetry/providers/${provider.id}/sync`, { reprise: true })).status).toBe(403);
    expect((await chefA.post(`/telemetry/providers/${provider.id}/sync`, { companyId: f.companies.B })).status).toBe(404);
    const manualSync = await chefA.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(manualSync.status, JSON.stringify(manualSync.body)).toBe(202);
    expect(manualSync.body.runs).toEqual([expect.objectContaining({ companyId: f.companies.A, trigger: 'MANUEL', status: 'EN_COURS', alreadyRunning: false })]);
    const run3 = await waitRun(manualSync.body.runs[0].syncRunId as string);
    expect(run3).toMatchObject({ status: 'SUCCES', trigger: 'MANUEL', readingsCreated: 0, fuelEventsCreated: 0, requestedById: f.users.chefA });
    // Reprise d'historique explicite (administrateur) : rejouée sans doublon.
    const reprise = await admin.post(`/telemetry/providers/${provider.id}/sync`, { reprise: true, companyId: f.companies.A });
    expect(reprise.status, JSON.stringify(reprise.body)).toBe(202);
    const run4 = await waitRun(reprise.body.runs[0].syncRunId as string);
    expect(run4).toMatchObject({ status: 'SUCCES', trigger: 'REPRISE_INITIALE', readingsCreated: 0, fuelEventsCreated: 0 });

    readings = await telematicsReadings(vehicleId);
    expect(readings).toHaveLength(2);
    expect(await t.prisma.client.fuelEvent.count()).toBe(1);
    expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId } })).toBe(2);
    const listed = await chefA.get(`/telemetry/sync-runs?providerId=${provider.id}`);
    expect(listed.body.items.filter((r: { companyId: string | null }) => r.companyId === f.companies.A)).toHaveLength(4);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer.physicalKm).toBe('50130.000');
  });

  // ---------------------------------------------------------------------------------------------
  // T38, T39 — calibrage GPS et dérive
  // ---------------------------------------------------------------------------------------------

  it('T38 et T39 — référence 80 000 à distanceGps 12 000, puis 12 450 → 80 450 « estimé GPS » ; estimation 81 000, restitution 80 960 → écart 4,2 %, alerte dérive, nouvelle référence 80 960', async () => {
    await permits();
    const { vehicleId, mappingId } = await provision({
      at: '2026-09-24T09:52:00Z',
      unit: 'U-38',
      odometerKind: 'DISTANCE_GPS',
      init: { km: '79000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-38', ['DISTANCE_GPS'])],
        odometerSamples: [
          gps('U-38', '12000', '2026-09-24T09:50:00Z'),
          gps('U-38', '12450', '2026-09-24T19:55:00Z'),
          gps('U-38', '13000', '2026-09-25T07:55:00Z'),
          gps('U-38', '13100', '2026-09-25T11:55:00Z'),
        ],
      },
    });
    // Reprise initiale : la distance GPS est stockée comme échantillon brut ; sans référence, aucune estimation.
    const initial = await runDue('2026-09-24T09:52:00Z');
    expect(initial.runs.map((r) => r.status)).toEqual(['SUCCES']);
    expect(await telematicsReadings(vehicleId)).toHaveLength(0);

    // Remise à 80 000 : relevé manuel accepté → référence de calibrage (distance GPS 12 000 à 09:50).
    const usage = await checkout(vehicleId, '80000', '2026-09-24T10:00:00Z', '2026-09-25T18:00:00Z');
    let calibrations = await t.prisma.client.telemetryCalibration.findMany({ where: { mappingId }, orderBy: { referenceAt: 'asc' } });
    expect(calibrations.map((c) => [c.status, c.referenceKm.toString(), c.referenceGpsDistanceKm?.toString()])).toEqual([['CALIBRE', '80000', '12000']]);

    // T38 : distance GPS 12 450 → kilométrage estimé 80 450, relevé estimé (jamais présenté comme compteur).
    await runDue('2026-09-24T20:00:00Z');
    let readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.cumulativeKm?.toString(), r.physicalKm, r.isEstimate, r.measurementKind, r.gpsDistanceKm?.toString(), r.status])).toEqual([['80450', null, true, 'DISTANCE_GPS', '12450', 'ACCEPTE']]);
    expect(readings[0]?.calibrationId).toBe(calibrations[0]?.id);
    expect(readings[0]?.note).toBe('Estimé GPS (réf. manuelle du 24/09/2026, 80 000 km)');
    const shown = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(shown.body.odometer).toMatchObject({ cumulativeKm: '80450.000', physicalKm: null, isEstimate: true, measurementKind: 'DISTANCE_GPS', source: 'TELEMATICS' });

    // T39 : estimation 81 000 (distance GPS 13 000), puis restitution manuelle 80 960 → acceptée (une
    // estimation ne sert jamais de voisin à un relevé physique), écart 4,2 %, alerte dérive, nouvelle référence.
    await runDue('2026-09-25T08:00:00Z');
    readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => r.cumulativeKm?.toString())).toEqual(['80450', '81000']);
    const returned = await giveBack(usage, '80960', '2026-09-25T08:00:00Z');
    expect(returned.returnReading?.status ?? 'ACCEPTE').toBe('ACCEPTE');
    calibrations = await t.prisma.client.telemetryCalibration.findMany({ where: { mappingId }, orderBy: { referenceAt: 'asc' } });
    expect(calibrations).toHaveLength(2);
    expect(calibrations[1]).toMatchObject({ status: 'CALIBRE', driftAlertRaised: true, previousCalibrationId: calibrations[0]?.id });
    expect([calibrations[1]?.referenceKm.toString(), calibrations[1]?.referenceGpsDistanceKm?.toString(), calibrations[1]?.estimatedKmAtReference?.toString(), calibrations[1]?.deviationKm?.toString(), calibrations[1]?.deviationPercent?.toString(), calibrations[1]?.distanceSincePreviousKm?.toString()]).toEqual([
      '80960',
      '13000',
      '81000',
      '40',
      '4.167',
      '960',
    ]);
    const drift = await activeAlerts('GPS_DERIVE');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ objectType: 'TelemetryVehicleMapping', objectId: mappingId, companyId: f.companies.A, vehicleId });
    expect(drift[0]?.message).toContain('4,2 %');
    const current = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(current.body.odometer).toMatchObject({ physicalKm: '80960.000', isEstimate: false, source: 'MANUAL' });

    // Les estimations suivantes partent de la nouvelle référence : 80 960 + (13 100 − 13 000) = 81 060.
    await runDue('2026-09-25T12:00:00Z');
    readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.cumulativeKm?.toString(), r.calibrationId])).toEqual([
      ['80450', calibrations[0]?.id],
      ['81000', calibrations[0]?.id],
      ['81060', calibrations[1]?.id],
    ]);
    expect(readings[2]?.note).toBe('Estimé GPS (réf. manuelle du 25/09/2026, 80 960 km)');
  });

  // ---------------------------------------------------------------------------------------------
  // T40 — régression automatique
  // ---------------------------------------------------------------------------------------------

  it('T40 — valeur CAN inférieure à la précédente : EN_ATTENTE motivé (un seul par motif), compteur courant inchangé, remise non bloquée', async () => {
    await permits();
    const { vehicleId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-40',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '60000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-40', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-40', '60500', '2026-09-24T09:00:00Z'), can('U-40', '60400', '2026-09-24T10:00:00Z'), can('U-40', '60410', '2026-09-24T11:00:00Z')],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    const regression = await runDue('2026-09-24T10:00:00Z');
    const run = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: regression.runs[0]?.runId as string } });
    expect(run).toMatchObject({ status: 'SUCCES', readingsCreated: 0, readingsPending: 1 });
    let readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.anomalyCode])).toEqual([
      ['60500', 'ACCEPTE', null],
      ['60400', 'EN_ATTENTE', 'DIMINUTION'],
    ]);
    expect(readings[1]?.statusReason).toContain('Diminution inexpliquée');
    expect((await activeAlerts('RELEVE_A_VALIDER')).map((a) => a.objectId)).toEqual([readings[1]?.id]);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '60500.000', measurementKind: 'COMPTEUR_CAN' });

    // Anomalie encore ouverte : l'échantillon incohérent suivant ne crée pas un second relevé en attente (D-322).
    await runDue('2026-09-24T11:00:00Z');
    readings = await telematicsReadings(vehicleId);
    expect(readings.filter((r) => r.status === 'EN_ATTENTE')).toHaveLength(1);
    const unitState = await t.prisma.client.telemetryUnitState.findFirstOrThrow({ where: { unit: { externalId: 'U-40' } } });
    expect(unitState.lastOdometerValueKm?.toString()).toBe('60410');

    // La remise n'est pas bloquée par le relevé automatique en attente.
    const usage = await checkout(vehicleId, '60520', '2026-09-24T11:30:00Z', '2026-09-24T18:00:00Z');
    expect(usage.id).toBeTruthy();
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '60520.000', source: 'MANUAL' });
  });

  it('D-183 — véhicule verrouillé par une saisie en cours : le connecteur abandonne après 2 s sans attendre, la saisie garde la priorité, relevé repris au cycle suivant', async () => {
    const { vehicleId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-LK',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '70000', at: '2026-09-01T08:00:00Z' },
      scenario: { units: [unitDef('U-LK', ['COMPTEUR_CAN'])], odometerSamples: [can('U-LK', '70100', '2026-09-24T09:00:00Z')] },
    });
    // Verrou de ligne du véhicule tenu par une autre transaction (saisie manuelle en cours) pendant le passage.
    let locked: Awaited<ReturnType<typeof runDue>> | null = null;
    const started = performance.now();
    await t.prisma.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${vehicleId}::uuid FOR UPDATE`;
        locked = await runDue('2026-09-24T09:30:00Z');
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    const runId = (locked as Awaited<ReturnType<typeof runDue>> | null)?.runs[0]?.runId as string;
    const run = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'SUCCES', readingsCreated: 0 });
    expect(run.errorSummary).toContain('véhicule verrouillé par une saisie en cours');
    expect(await telematicsReadings(vehicleId)).toHaveLength(0);

    // Cycle suivant, verrou libéré : l'échantillon est historisé.
    await runDue('2026-09-24T09:50:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => [r.physicalKm?.toString(), r.status])).toEqual([['70100', 'ACCEPTE']]);
  });

  it('D-175, D-186 — véhicule HORS_SERVICE : un seul relevé CAN EN_ATTENTE motivé VEHICULE_NON_ACTIF (ouvert, puis un par jour), compteur courant inchangé ; retour ACTIF : historisation normale', async () => {
    const { vehicleId, unitId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-HS',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '40000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-HS', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-HS', '40100', '2026-09-24T09:00:00Z'), can('U-HS', '40110', '2026-09-24T11:00:00Z'), can('U-HS', '40120', '2026-09-24T13:00:00Z'), can('U-HS', '40130', '2026-09-25T09:00:00Z')],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    t.clock.set('2026-09-24T10:00:00Z');
    const vehicle = await chefA.get(`/vehicles/${vehicleId}`);
    const out = await chefA.post(`/vehicles/${vehicleId}/lifecycle`, { lifecycleStatus: 'HORS_SERVICE', reason: 'Panne moteur au dépôt', expectedVersion: vehicle.body.version });
    expect(out.status, JSON.stringify(out.body)).toBe(200);

    // Hors service : échantillon présenté à l'ingestion unique, mis d'office en attente avec motif.
    const pendingRun = await runDue('2026-09-24T11:10:00Z');
    const run = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: pendingRun.runs[0]?.runId as string } });
    expect(run).toMatchObject({ status: 'SUCCES', readingsCreated: 0, readingsPending: 1 });
    let readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.anomalyCode])).toEqual([
      ['40100', 'ACCEPTE', null],
      ['40110', 'EN_ATTENTE', 'VEHICULE_NON_ACTIF'],
    ]);
    expect(readings[1]?.statusReason).toContain('Véhicule hors service');
    expect((await activeAlerts('RELEVE_A_VALIDER')).map((a) => a.objectId)).toEqual([readings[1]?.id]);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '40100.000' });

    // Relevé encore en attente : l'échantillon suivant ne met à jour que l'état de l'unité.
    await runDue('2026-09-24T13:10:00Z');
    expect(await telematicsReadings(vehicleId)).toHaveLength(2);
    expect((await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } })).lastOdometerValueKm?.toString()).toBe('40120');

    // Rejeté par le chef : pas de nouveau relevé en attente le même jour local.
    t.clock.set('2026-09-24T13:20:00Z');
    const rejected = await chefA.post(`/readings/${readings[1]?.id}/reject`, { expectedVersion: readings[1]?.version, reason: 'Véhicule au garage, déplacement non retenu' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    await runDue('2026-09-24T13:30:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => r.status)).toEqual(['ACCEPTE', 'REJETE']);

    // De retour en service : l'échantillon suivant est historisé normalement.
    t.clock.set('2026-09-25T08:00:00Z');
    await ensureSessions('2026-09-25T08:00:00Z');
    const again = await chefA.get(`/vehicles/${vehicleId}`);
    expect((await chefA.post(`/vehicles/${vehicleId}/lifecycle`, { lifecycleStatus: 'ACTIF', reason: 'Réparation terminée', expectedVersion: again.body.version })).status).toBe(200);
    await runDue('2026-09-25T09:10:00Z');
    readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status])).toEqual([
      ['40100', 'ACCEPTE'],
      ['40110', 'REJETE'],
      ['40130', 'ACCEPTE'],
    ]);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '40130.000', source: 'TELEMATICS' });
  });

  // ---------------------------------------------------------------------------------------------
  // T41 — source muette
  // ---------------------------------------------------------------------------------------------

  it('T41 — unité associée sans donnée pendant 25 h : alerte « source GPS muette », saisie manuelle possible, fraîcheur sur la dernière observation, résolution au premier échantillon frais', async () => {
    const { vehicleId, mappingId } = await provision({
      at: NOW,
      unit: 'U-41',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '20000', at: '2026-09-01T08:00:00Z' },
      scenario: { units: [unitDef('U-41', ['COMPTEUR_CAN'])], odometerSamples: [can('U-41', '20100', '2026-09-24T09:00:00Z'), can('U-41', '20180', '2026-09-25T12:30:00Z')] },
    });
    // Liste des unités au plus une fois par heure et par fournisseur (D-296) : la découverte de la mise en
    // service vient d'avoir lieu ; la suivante douze heures plus tard, puis pas avant une heure.
    expect((await runDue(NOW)).discoveries).toBe(0);
    expect(await activeAlerts('GPS_SOURCE_MUETTE')).toHaveLength(0);
    expect((await runDue('2026-09-24T22:00:00Z')).discoveries).toBe(1);
    const soon = await runDue('2026-09-24T22:30:00Z');
    expect(soon).toMatchObject({ discoveries: 0, runs: [expect.objectContaining({ status: 'SUCCES' })] });
    expect(await t.prisma.client.telemetrySyncRun.count({ where: { companyId: null } })).toBe(2);
    expect(await activeAlerts('GPS_SOURCE_MUETTE')).toHaveLength(0);

    // 25 h après la confirmation (26 h après la dernière observation) : le fournisseur répond, l'unité se tait.
    const later = await runDue('2026-09-25T11:00:00Z');
    expect(later.runs.map((r) => r.status)).toEqual(['SUCCES']);
    const silent = await activeAlerts('GPS_SOURCE_MUETTE');
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ objectType: 'TelemetryVehicleMapping', objectId: mappingId, vehicleId, occurrenceKey: 'depuis:2026-09-24T09:00:00.000Z' });
    // Fraîcheur : dernière observation acceptée toutes sources (le CAN de la veille), aucun suivi en direct.
    const before = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(before.body.odometer).toMatchObject({ physicalKm: '20100.000', observedAt: '2026-09-24T09:00:00.000Z', source: 'TELEMATICS', freshness: 'A_JOUR' });
    const manual = await manualReading(vehicleId, '20150', '2026-09-25T11:05:00Z');
    expect(manual.outcome).toBe('ACCEPTE');
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '20150.000', observedAt: '2026-09-25T11:05:00.000Z', source: 'MANUAL' });

    // Échantillon frais : alerte résolue.
    await runDue('2026-09-25T12:45:00Z');
    expect(await activeAlerts('GPS_SOURCE_MUETTE')).toHaveLength(0);
    expect((await telematicsReadings(vehicleId)).map((r) => r.physicalKm?.toString())).toEqual(['20100', '20180']);
  });

  // ---------------------------------------------------------------------------------------------
  // T42 — entretien automatique
  // ---------------------------------------------------------------------------------------------

  it('T42 — base 80 000, intervalle 10 000 : synchro CAN 89 500 puis 90 000 → A_PREVOIR puis A_FAIRE sans saisie manuelle, alerte moins d’une minute après l’ingestion (délai mesuré)', async () => {
    const { vehicleId } = await provision({
      at: '2026-09-24T09:05:00Z',
      unit: 'U-42',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '85000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-42', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-42', '89500', '2026-09-24T09:00:00Z'), can('U-42', '89990', '2026-09-24T17:00:00Z'), can('U-42', '90000', '2026-09-24T17:20:00Z')],
      },
    });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    expect(type.status).toBe(201);
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type.body.id, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-03-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body).toMatchObject({ nextDueKm: '90000', status: 'A_JOUR' });
    const planAlert = () => t.prisma.client.alert.findFirst({ where: { type: 'ENTRETIEN_ECHEANCE', objectId: plan.body.id, status: 'ACTIVE' } });

    let started = performance.now();
    await runDue('2026-09-24T09:10:00Z');
    let elapsed = performance.now() - started;
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ status: 'A_PREVOIR', currentKmSource: 'COMPTEUR_CAN' });
    expect((await planAlert())?.severity).toBe('ATTENTION');
    expect(elapsed).toBeLessThan(60_000);

    // 89 990 : historisé (progression après l'intervalle), l'échéance n'est pas atteinte.
    await runDue('2026-09-24T17:10:00Z');
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body.status).toBe('A_PREVOIR');

    // 90 000, vingt minutes après : historisé par franchissement de seuil malgré l'intervalle d'une heure.
    started = performance.now();
    await runDue('2026-09-24T17:25:00Z');
    elapsed = performance.now() - started;
    const alert = await planAlert();
    expect(alert?.severity).toBe('URGENT');
    expect(elapsed).toBeLessThan(60_000);
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ status: 'A_FAIRE', remainingKm: '0' });
    const readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status])).toEqual([
      ['89500', 'ACCEPTE'],
      ['89990', 'ACCEPTE'],
      ['90000', 'ACCEPTE'],
    ]);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, source: 'MANUAL', context: { not: 'INITIALISATION' } } })).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // T43 — carburant
  // ---------------------------------------------------------------------------------------------

  it('T43 — sonde : baisse de 25 L moteur coupé en 20 min et remplissage de 40 L sans ticket → deux anomalies à qualifier, aucune dépense ; qualification par le chef ; ticket saisi ensuite → rapprochement', async () => {
    const { vehicleId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-43',
      odometerKind: 'AUCUN',
      fuelKinds: ['NIVEAU_SONDE'],
      vehicle: { energy: 'DIESEL', tankCapacityLiters: '80' },
      scenario: {
        units: [unitDef('U-43', [], ['NIVEAU_SONDE'])],
        fuelSamples: [
          probe('U-43', '60', '2026-09-24T09:00:00Z'),
          probe('U-43', '55', '2026-09-24T09:05:00Z'),
          probe('U-43', '48', '2026-09-24T09:10:00Z'),
          probe('U-43', '42', '2026-09-24T09:15:00Z'),
          probe('U-43', '35', '2026-09-24T09:20:00Z'),
          probe('U-43', '35', '2026-09-24T11:00:00Z', true),
          probe('U-43', '55', '2026-09-24T11:05:00Z'),
          probe('U-43', '75', '2026-09-24T11:10:00Z'),
          probe('U-43', '75', '2026-09-24T11:15:00Z'),
          probe('U-43', '75', '2026-09-24T11:20:00Z', true),
        ],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    await runDue('2026-09-24T11:30:00Z');
    const events = await t.prisma.client.fuelEvent.findMany({ orderBy: { detectedAt: 'asc' } });
    expect(events.map((e) => [e.type, e.status, e.measureKind, e.litersDelta?.toString(), e.fuelEntryId])).toEqual([
      ['BAISSE_ANORMALE', 'A_QUALIFIER', 'NIVEAU_SONDE', '25', null],
      ['REMPLISSAGE_DETECTE', 'A_QUALIFIER', 'NIVEAU_SONDE', '40', null],
    ]);
    expect(events[0]).toMatchObject({ vehicleId, companyId: f.companies.A });
    expect([events[0]?.windowStart.toISOString(), events[0]?.windowEnd.toISOString()]).toEqual(['2026-09-24T09:00:00.000Z', '2026-09-24T09:20:00.000Z']);
    expect((await activeAlerts('CARBURANT_BAISSE_ANORMALE')).map((a) => a.objectId)).toEqual([events[0]?.id]);
    expect((await activeAlerts('CARBURANT_REMPLISSAGE_DETECTE')).map((a) => a.objectId)).toEqual([events[1]?.id]);
    expect(await t.prisma.client.expense.count()).toBe(0);
    expect(await t.prisma.client.fuelLevelSample.count({ where: { vehicleId } })).toBe(10);

    // Rejeu : aucun doublon d'événement.
    await runDue('2026-09-24T11:50:00Z');
    expect(await t.prisma.client.fuelEvent.count()).toBe(2);

    // Consultation dans le périmètre ; conducteur refusé ; chef d'une autre société sans rien voir.
    const listed = await chefA.get('/telemetry/fuel-events?status=A_QUALIFIER');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((e: { type: string; typeLabel: string; measureKindLabel: string }) => [e.type, e.measureKindLabel])).toEqual([
      ['REMPLISSAGE_DETECTE', 'Niveau sonde'],
      ['BAISSE_ANORMALE', 'Niveau sonde'],
    ]);
    expect((await operateurA.get('/telemetry/fuel-events')).body.total).toBe(2);
    expect((await chefB.get('/telemetry/fuel-events')).body.total).toBe(0);
    expect((await chefB.get(`/telemetry/fuel-events?companyId=${f.companies.A}`)).status).toBe(404);
    expect((await chefB.get(`/telemetry/fuel-events?vehicleId=${vehicleId}`)).body.total).toBe(0);
    expect((await chefB.get(`/telemetry/fuel-events/${events[0]?.id}`)).status).toBe(404);
    expect((await chefA.get(`/telemetry/fuel-events/${events[0]?.id}`)).body).toMatchObject({ id: events[0]?.id, type: 'BAISSE_ANORMALE', status: 'A_QUALIFIER', litersDelta: '25.000' });
    expect((await conducteurA.get('/telemetry/fuel-events')).status).toBe(403);
    expect((await conducteurA.get(`/telemetry/fuel-events/${events[0]?.id}`)).status).toBe(403);

    // Qualification : chef de parc (ou administrateur), note, verrou optimiste.
    const drop = events[0] as { id: string; version: number };
    expect((await operateurA.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'ANOMALIE_CONFIRMEE', note: 'Vol constaté', expectedVersion: drop.version })).status).toBe(403);
    expect((await chefB.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'ANOMALIE_CONFIRMEE', note: 'Vol constaté', expectedVersion: drop.version })).status).toBe(404);
    expect((await chefA.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'INCONNUE', note: 'Vol constaté', expectedVersion: drop.version })).status).toBe(422);
    expect((await chefA.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'ANOMALIE_CONFIRMEE', note: 'Vol constaté', expectedVersion: drop.version + 1 })).status).toBe(409);
    const qualified = await chefA.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'ANOMALIE_CONFIRMEE', note: 'Siphonnage constaté sur le parking', expectedVersion: drop.version });
    expect(qualified.status, JSON.stringify(qualified.body)).toBe(200);
    expect(qualified.body).toMatchObject({ status: 'QUALIFIE', qualification: 'ANOMALIE_CONFIRMEE', qualifiedById: f.users.chefA, qualificationNote: 'Siphonnage constaté sur le parking', version: drop.version + 1 });
    expect(await activeAlerts('CARBURANT_BAISSE_ANORMALE')).toHaveLength(0);
    expect((await chefA.post(`/telemetry/fuel-events/${drop.id}/qualify`, { qualification: 'JUSTIFIE', note: 'Autre avis', expectedVersion: drop.version + 1 })).status).toBe(422);
    expect(await t.prisma.client.expense.count()).toBe(0);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'telemetrie.carburant.qualification', objectId: drop.id } })).toBe(1);

    // Ticket de 40 L saisi après la détection : le remplissage est rapproché et justifié automatiquement.
    t.clock.set('2026-09-24T12:00:00Z');
    const ticket = await chefA.post('/fuel-entries', { vehicleId, filledAt: '2026-09-24T11:10:00Z', liters: '40', unitPrice: '2.000', totalAmount: '80.000', isFullTank: true }).set('Idempotency-Key', randomUUID());
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const expensesAfterTicket = await t.prisma.client.expense.count();
    await runDue('2026-09-24T12:10:00Z');
    const refill = await t.prisma.client.fuelEvent.findUniqueOrThrow({ where: { id: events[1]?.id as string } });
    expect(refill).toMatchObject({ status: 'QUALIFIE', qualification: 'JUSTIFIE', fuelEntryId: ticket.body.id, qualifiedById: null });
    expect(await activeAlerts('CARBURANT_REMPLISSAGE_DETECTE')).toHaveLength(0);
    expect(await t.prisma.client.expense.count()).toBe(expensesAfterTicket);
  });

  it('8.5, D-242 — remplissage dont le ticket est déjà saisi : JUSTIFIE automatiquement (audit, sans alerte) ; ticket hors tolérance : ECART_TICKET à qualifier ; aucune dépense créée par la télématique', async () => {
    const { vehicleId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-44',
      odometerKind: 'AUCUN',
      fuelKinds: ['NIVEAU_SONDE'],
      vehicle: { energy: 'DIESEL', tankCapacityLiters: '80' },
      scenario: {
        units: [unitDef('U-44', [], ['NIVEAU_SONDE'])],
        fuelSamples: [
          probe('U-44', '20', '2026-09-24T10:00:00Z', true),
          probe('U-44', '40', '2026-09-24T10:05:00Z'),
          probe('U-44', '60', '2026-09-24T10:10:00Z'),
          probe('U-44', '60', '2026-09-24T10:15:00Z'),
          probe('U-44', '60', '2026-09-24T10:20:00Z', true),
          probe('U-44', '30', '2026-09-24T12:00:00Z', true),
          probe('U-44', '50', '2026-09-24T12:05:00Z'),
          probe('U-44', '70', '2026-09-24T12:10:00Z'),
          probe('U-44', '70', '2026-09-24T12:15:00Z'),
          probe('U-44', '70', '2026-09-24T12:20:00Z', true),
        ],
      },
    });
    async function ticket(filledAt: string, liters: string, at: string): Promise<string> {
      t.clock.set(at);
      const res = await chefA.post('/fuel-entries', { vehicleId, filledAt, liters, unitPrice: '2.000', totalAmount: (Number(liters) * 2).toFixed(3), isFullTank: true }).set('Idempotency-Key', randomUUID());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    }

    // Plein de 40 L saisi avant la synchronisation : rapproché dès la détection.
    const matching = await ticket('2026-09-24T10:05:00Z', '40', '2026-09-24T10:25:00Z');
    const expensesBefore = await t.prisma.client.expense.count();
    await runDue('2026-09-24T10:30:00Z');
    let events = await t.prisma.client.fuelEvent.findMany({ orderBy: { detectedAt: 'asc' } });
    expect(events.map((e) => [e.type, e.status, e.qualification, e.fuelEntryId, e.qualifiedById])).toEqual([['REMPLISSAGE_DETECTE', 'QUALIFIE', 'JUSTIFIE', matching, null]]);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'telemetrie.carburant.justification_automatique', objectId: events[0]?.id } })).toBe(1);
    expect(await activeAlerts('CARBURANT_REMPLISSAGE_DETECTE')).toHaveLength(0);
    expect(await t.prisma.client.expense.count()).toBe(expensesBefore);

    // Ticket de 15 L pour un remplissage de 40 L : écart hors tolérance, anomalie à qualifier.
    const far = await ticket('2026-09-24T12:05:00Z', '15', '2026-09-24T12:25:00Z');
    const expensesWithTickets = await t.prisma.client.expense.count();
    await runDue('2026-09-24T12:30:00Z');
    events = await t.prisma.client.fuelEvent.findMany({ orderBy: { detectedAt: 'asc' } });
    expect(events.map((e) => [e.type, e.status, e.fuelEntryId, e.litersDelta?.toString()])).toEqual([
      ['REMPLISSAGE_DETECTE', 'QUALIFIE', matching, '40'],
      ['ECART_TICKET', 'A_QUALIFIER', far, '40'],
    ]);
    expect(events[1]?.details).toMatchObject({ rapprochement: { resultat: 'ECART_LITRES', ecartLitres: '25' } });
    expect((await activeAlerts('CARBURANT_ECART_TICKET')).map((a) => a.objectId)).toEqual([events[1]?.id]);
    // La télématique ne crée jamais de dépense : seuls les pleins saisis en ont éventuellement une.
    expect(expensesWithTickets).toBeGreaterThanOrEqual(expensesBefore);
    expect(await t.prisma.client.expense.count()).toBe(expensesWithTickets);
  });

  it('8.5 — un plein ne justifie qu’un seul remplissage détecté : second remplissage dans la même fenêtre sans ticket disponible → à qualifier', async () => {
    const { vehicleId } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-45',
      odometerKind: 'AUCUN',
      fuelKinds: ['NIVEAU_SONDE'],
      vehicle: { energy: 'DIESEL', tankCapacityLiters: '80' },
      scenario: {
        units: [unitDef('U-45', [], ['NIVEAU_SONDE'])],
        fuelSamples: [
          probe('U-45', '20', '2026-09-24T10:00:00Z', true),
          probe('U-45', '40', '2026-09-24T10:05:00Z'),
          probe('U-45', '60', '2026-09-24T10:10:00Z'),
          probe('U-45', '60', '2026-09-24T10:15:00Z'),
          probe('U-45', '60', '2026-09-24T10:20:00Z', true),
          probe('U-45', '30', '2026-09-24T11:00:00Z', true),
          probe('U-45', '50', '2026-09-24T11:05:00Z'),
          probe('U-45', '70', '2026-09-24T11:10:00Z'),
          probe('U-45', '70', '2026-09-24T11:15:00Z'),
          probe('U-45', '70', '2026-09-24T11:20:00Z', true),
        ],
      },
    });
    // Un seul ticket de 40 L, dans la fenêtre de 2 h des deux remplissages de 40 L.
    t.clock.set('2026-09-24T11:25:00Z');
    const res = await chefA.post('/fuel-entries', { vehicleId, filledAt: '2026-09-24T10:30:00Z', liters: '40', unitPrice: '2.000', totalAmount: '80.000', isFullTank: true }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await runDue('2026-09-24T11:30:00Z');
    const fills = await t.prisma.client.fuelEvent.findMany({ where: { vehicleId, type: { in: ['REMPLISSAGE_DETECTE', 'ECART_TICKET'] } }, orderBy: { detectedAt: 'asc' } });
    expect(fills.map((e) => [e.type, e.status, e.qualification, e.fuelEntryId])).toEqual([
      ['REMPLISSAGE_DETECTE', 'QUALIFIE', 'JUSTIFIE', res.body.id],
      ['REMPLISSAGE_DETECTE', 'A_QUALIFIER', null, null],
    ]);
    expect(fills[1]?.details).toMatchObject({ rapprochement: { resultat: 'ABSENCE_TICKET' } });
    // Le rapprochement tardif ne réutilise pas non plus le ticket déjà rapproché.
    await runDue('2026-09-24T12:30:00Z');
    expect((await t.prisma.client.fuelEvent.findUniqueOrThrow({ where: { id: fills[1]?.id as string } })).status).toBe('A_QUALIFIER');
  });

  // ---------------------------------------------------------------------------------------------
  // Canal RAPPORT réel (SFTP en conteneur) de bout en bout par le moteur de synchronisation
  // ---------------------------------------------------------------------------------------------

  describe('canal RAPPORT — vrai serveur SFTP (conteneur mirror.gcr.io/atmoz/sftp:alpine)', () => {
    const container = `parc-sftp-sync-${randomBytes(4).toString('hex')}`;
    const password = `sftp-${randomBytes(6).toString('hex')}`;
    let port = 0;
    let fingerprint = '';

    async function sftp(): Promise<SftpClient> {
      const c = new SftpClient('test', { error: () => undefined, end: () => undefined, close: () => undefined });
      await c.connect({ host: 'localhost', port, username: 'parc', password, readyTimeout: 5000, retries: 0, hostVerifier: (key: Buffer) => ((fingerprint = sshHostKeyFingerprint(key)), true) });
      return c;
    }

    async function upload(name: string, content: string): Promise<Buffer> {
      const buffer = Buffer.from(content, 'utf8');
      const c = await sftp();
      try {
        await c.put(buffer, `/rapports/${name}`);
      } finally {
        await c.end();
      }
      return buffer;
    }

    async function listing(dir: string): Promise<string[]> {
      const c = await sftp();
      try {
        return (await c.list(dir)).map((f) => f.name).sort();
      } finally {
        await c.end();
      }
    }

    beforeAll(async () => {
      // Un conteneur qui ne démarre pas fait échouer le test (aucun saut silencieux).
      execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::22', 'mirror.gcr.io/atmoz/sftp:alpine', `parc:${password}:1001:100:rapports`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const line = execFileSync('docker', ['port', container, '22/tcp'], { encoding: 'utf8' }).split('\n')[0] ?? '';
      port = Number(/:(\d+)$/.exec(line.trim())?.[1]);
      expect(Number.isInteger(port) && port > 0).toBe(true);
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          await (await sftp()).end();
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      expect(fingerprint).toMatch(/^[A-Za-z0-9+/]{43}$/);
    }, 90_000);

    afterAll(() => {
      try {
        execFileSync('docker', ['stop', '-t', '2', container], { stdio: 'ignore' });
      } catch {
        // Déjà arrêté.
      }
    });

    it('fichiers CSV lus par runDue : relevés CAN historisés par l’ingestion unique, fichiers inscrits au registre et déplacés après ingestion ; fichier rejoué ou lignes répétées sans doublon ; source injoignable sans reprise ni acquittement', async () => {
      const header = 'Unité;Date;Compteur (km)';
      const first = await upload('releves-1.csv', [header, 'R-1;2026-09-24T08:00:00Z;45000', 'R-1;2026-09-24T09:15:00Z;45080', 'R-2;2026-09-24T09:00:00Z;12000', ''].join('\n'));

      t.clock.set('2026-09-24T09:50:00Z');
      await setCompany(true);
      const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-R-1' });
      expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '44000' })).status).toBe(201);
      const created = await admin.post('/telemetry/providers', {
        name: 'Rapports SFTP',
        kind: 'RAPPORT_GENERIQUE',
        settings: {
          source: 'SFTP',
          sftp: { host: 'localhost', port, directory: '/rapports', hostKeySha256: `SHA256:${fingerprint}` },
          columns: { unit: 'Unité', timestamp: 'Date', odometer: 'Compteur (km)' },
          timestampFormat: 'ISO',
          odometerUnit: 'km',
          odometerKind: 'COMPTEUR_CAN',
        },
        companyIds: [f.companies.A],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await admin.put(`/telemetry/providers/${created.body.id}/credentials/SFTP`, { secret: `parc:${password}` })).status).toBe(200);
      const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
      expect(activated.status, JSON.stringify(activated.body)).toBe(200);
      const providerId = created.body.id as string;
      // Découverte : unités lues dans les fichiers, sans acquittement (les fichiers restent à traiter).
      expect((await admin.post(`/telemetry/providers/${providerId}/discover`)).status).toBe(200);
      expect(await listing('/rapports')).toEqual(['releves-1.csv']);
      const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId, externalId: 'R-1' } });
      const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
      expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);

      // Premier passage : lecture réelle, ingestion, registre SHA-256, déplacement dans « traites ».
      const r1 = await runDue('2026-09-24T10:00:00Z');
      expect(r1.runs).toEqual([expect.objectContaining({ providerId, companyId: f.companies.A, status: 'SUCCES' })]);
      const run1 = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: r1.runs[0]?.runId as string } });
      expect(run1).toMatchObject({ readingsCreated: 2, readingsPending: 0, errorCount: 0 });
      expect(run1.errorSummary).toContain('Fichiers de rapport : 1 lu(s)');
      let readings = await telematicsReadings(vehicleId);
      expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.measurementKind, r.channel, r.providerUnitId])).toEqual([
        ['45000', 'ACCEPTE', 'COMPTEUR_CAN', 'RAPPORT', 'R-1'],
        ['45080', 'ACCEPTE', 'COMPTEUR_CAN', 'RAPPORT', 'R-1'],
      ]);
      expect(readings.every((r) => r.sourceReference?.startsWith('fp:'))).toBe(true);
      expect(await t.prisma.client.telemetryReportFile.findMany({ where: { providerId }, select: { sha256: true, rowCount: true } })).toEqual([{ sha256: createHash('sha256').update(first).digest('hex'), rowCount: 3 }]);
      expect(await listing('/rapports')).toEqual(['traites']);
      expect(await listing('/rapports/traites')).toEqual(['releves-1.csv']);
      // Unité non associée : aucune donnée ingérée (ni échantillon ni relevé).
      const other = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId, externalId: 'R-2' } });
      expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId: other.id } })).toBe(0);

      // Même fichier déposé à nouveau sous un autre nom (empreinte connue) et lignes répétées dans un nouveau fichier.
      await upload('releves-1-copie.csv', first.toString('utf8'));
      // R-3 n'apparaît que dans ce fichier, lu et acquitté (déplacé) par la synchronisation de 10:40, moins
      // d'une heure après la dernière découverte : elle doit être enregistrée avant l'acquittement (D-296).
      await upload('releves-2.csv', [header, 'R-1;2026-09-24T09:15:00Z;45080', 'R-1;2026-09-24T10:30:00Z;45150', 'R-3;2026-09-24T10:20:00Z;7000', ''].join('\n'));
      const r2 = await runDue('2026-09-24T10:40:00Z');
      expect(r2.runs.map((r) => r.status)).toEqual(['SUCCES']);
      const run2 = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: r2.runs[0]?.runId as string } });
      expect(run2).toMatchObject({ readingsCreated: 1, errorCount: 0 });
      expect(run2.errorSummary).toContain('1 lu(s), 1 déjà traité(s)');
      readings = await telematicsReadings(vehicleId);
      expect(readings.map((r) => r.physicalKm?.toString())).toEqual(['45000', '45080', '45150']);
      expect(await t.prisma.client.telemetryReportFile.count({ where: { providerId } })).toBe(2);
      expect(await listing('/rapports/traites')).toEqual(['releves-1-copie.csv', 'releves-1.csv', 'releves-2.csv']);
      const lateUnit = await t.prisma.client.telemetryUnit.findFirst({ where: { providerId, externalId: 'R-3' } });
      expect(lateUnit).toMatchObject({ presentAtProvider: true });
      expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId: lateUnit?.id as string } })).toBe(0);

      // Serveur arrêté : échec sans reprise dans le run (canal RAPPORT), parcours manuel intact.
      await upload('releves-3.csv', [header, 'R-1;2026-09-24T11:30:00Z;45210', ''].join('\n'));
      execFileSync('docker', ['pause', container], { stdio: 'ignore' });
      try {
        sleeps.length = 0;
        const r3 = await runDue('2026-09-24T11:40:00Z');
        expect(r3.runs.map((r) => r.status)).toEqual(['ECHEC']);
        expect(sleeps).toEqual([]);
        expect((await manualReading(vehicleId, '45220', '2026-09-24T11:45:00Z')).outcome).toBe('ACCEPTE');
      } finally {
        execFileSync('docker', ['unpause', container], { stdio: 'ignore' });
      }
      // Source rétablie : le fichier non acquitté est lu au passage suivant.
      const r4 = await runDue('2026-09-24T12:40:00Z');
      expect(r4.runs.map((r) => r.status)).toEqual(['SUCCES']);
      expect(await listing('/rapports/traites')).toContain('releves-3.csv');
      expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId: unit.id } })).toBe(4);
    }, 180_000);
  });

  // ---------------------------------------------------------------------------------------------
  // Purges
  // ---------------------------------------------------------------------------------------------

  it('purges pour le worker : échantillons carburant et odomètre au-delà de la rétention, relevés et événements conservés', async () => {
    const unitId = randomUUID();
    const vehicleId = randomUUID();
    const old = new Date('2026-06-01T08:00:00Z');
    const recent = new Date('2026-09-20T08:00:00Z');
    await t.prisma.client.fuelLevelSample.createMany({
      data: [old, recent].map((observedAt) => ({ organizationId: f.organizationId, unitId, vehicleId, observedAt, kind: 'NIVEAU_SONDE' as const, liters: '40', receivedAt: observedAt })),
    });
    await t.prisma.client.telemetryOdometerSample.createMany({
      data: [old, recent].map((observedAt) => ({ organizationId: f.organizationId, unitId, observedAt, kind: 'DISTANCE_GPS' as const, valueKm: '1000', receivedAt: observedAt })),
    });
    const result = await t.app.get(TelemetrySyncService).purgeSamples(new Date(NOW));
    expect(result).toMatchObject({ fuelSamples: 1, odometerSamples: 1 });
    expect(await t.prisma.client.fuelLevelSample.count()).toBe(1);
    expect(await t.prisma.client.telemetryOdometerSample.count()).toBe(1);
    expect(await t.app.get(TelemetrySyncService).purgeSamples(new Date(NOW))).toMatchObject({ fuelSamples: 0, odometerSamples: 0 });
  });
});
