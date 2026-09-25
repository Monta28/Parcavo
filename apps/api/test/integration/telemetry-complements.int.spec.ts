import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelemetryLeaseService, syncLeaseName } from '../../src/modules/telemetry/sync/telemetry-lease.service.js';
import { TelemetrySyncService } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

interface Provider {
  id: string;
  version: number;
  [key: string]: unknown;
}

function can(unit: string, valueKm: string, observedAt: string) {
  return { unitExternalId: unit, kind: 'COMPTEUR_CAN', valueKm, observedAt };
}

function gps(unit: string, valueKm: string, observedAt: string) {
  return { unitExternalId: unit, kind: 'DISTANCE_GPS', valueKm, observedAt };
}

function fuel(unit: string, kind: 'NIVEAU_SONDE' | 'NIVEAU_CAN', liters: string, observedAt: string, engineOn = false) {
  return { unitExternalId: unit, kind, liters, engineOn, speedKmh: '0', observedAt };
}

function unitDef(externalId: string, odometerKinds: string[], fuelKinds: string[] = []) {
  return { externalId, label: `Boîtier ${externalId}`, declaredRegistration: null, odometerKinds, fuelKinds };
}

/**
 * Compléments du connecteur télématique (CDC 5.6, 8.5, 13.2, 14.3 à 14.5) : aide télématique limitée à
 * l'association en cours, conservation des données après désactivation et purge, distance GPS d'un nouveau
 * boîtier jamais convertie sans référence, plan MANUEL_OU_CAN, natures carburant non déclarées, compteur CAN
 * inférieur après changement de boîtier, bail d'un couple fournisseur-société, état d'unité et durée des runs,
 * parcours manuels pendant une panne du fournisseur.
 */
describe('Connecteur télématique — compléments (R-5.6-17, R-14.3-X01, R-8.5-12, R-5.6-X01, R-5.6-16, R-8.5-01, R-14.5-05, R-14.4-04, R-13.2-26, R-13.2-27, R-14.4-06, R-14.4-08)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    loggedInAt = new Date(NOW).getTime();
    sleeps = [];
  });

  // ---------------------------------------------------------------------------------------------
  // Aides (mêmes parcours que l'interface : API HTTP, passage du worker par TelemetrySyncService.runDue)
  // ---------------------------------------------------------------------------------------------

  async function ensureSessions(at: string): Promise<void> {
    const instant = new Date(at).getTime();
    if (Math.abs(instant - loggedInAt) < 6 * 3_600_000) return;
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    loggedInAt = instant;
  }

  async function runDue(at: string, options: { holder?: string; sleep?: (ms: number) => Promise<void> } = {}) {
    t.clock.set(at);
    await ensureSessions(at);
    return t.app.get(TelemetrySyncService).runDue(new Date(at), {
      holder: options.holder ?? 'worker-test',
      sleep:
        options.sleep ??
        ((ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }),
    });
  }

  async function setCompany(enabled: boolean): Promise<void> {
    const res = await admin.post(`/telemetry/companies/${f.companies.A}/${enabled ? 'enable' : 'disable'}`, { reason: enabled ? 'Mise en service du module F11' : 'Suspension du module F11' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** Véhicule de A (compteur initialisé), SIMULATEUR actif, unités découvertes, première unité associée. */
  async function provision(options: {
    at: string;
    unit: string;
    scenario: Record<string, unknown>;
    odometerKind: 'COMPTEUR_CAN' | 'DISTANCE_GPS' | 'AUCUN';
    fuelKinds?: string[];
    init?: { km: string; at: string } | null;
    vehicle?: { energy?: string; tankCapacityLiters?: string };
  }): Promise<{ provider: Provider; vehicleId: string; mappingId: string; mappingVersion: number; unitId: string }> {
    t.clock.set(options.at);
    await ensureSessions(options.at);
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
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect((await admin.post(`/telemetry/providers/${created.body.id}/discover`)).status).toBe(200);
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: created.body.id, externalId: options.unit } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: options.odometerKind, fuelKinds: options.fuelKinds ?? [] });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    return { provider: activated.body as Provider, vehicleId, mappingId: mapping.body.id as string, mappingVersion: mapping.body.version as number, unitId: unit.id };
  }

  async function unitIdOf(providerId: string, externalId: string): Promise<string> {
    return (await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId, externalId } })).id;
  }

  async function permits(): Promise<void> {
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: `P-${randomUUID().slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
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

  async function giveBack(usage: { id: string }, km: string, at: string) {
    t.clock.set(at);
    await ensureSessions(at);
    const current = await operateurA.get(`/usages/${usage.id}`);
    const res = await operateurA.post(`/usages/${usage.id}/return`, { returnedAt: at, reading: { physicalKm: km }, location: { placeLabel: 'Dépôt' }, expectedVersion: current.body.version }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function manualReading(vehicleId: string, physicalKm: string, observedAt: string) {
    t.clock.set(observedAt);
    await ensureSessions(observedAt);
    const res = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { outcome: string; reading: { id: string; status: string } };
  }

  async function telematicsReadings(vehicleId: string) {
    return t.prisma.client.odometerReading.findMany({ where: { vehicleId, source: 'TELEMATICS' }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }] });
  }

  async function runRow(result: Awaited<ReturnType<typeof runDue>>) {
    return t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: result.runs[0]?.runId as string } });
  }

  async function hints(vehicleId: string) {
    const odometer = await chefA.get(`/vehicles/${vehicleId}/odometer`);
    expect(odometer.status, JSON.stringify(odometer.body)).toBe(200);
    const preview = await operateurA.get(`/usages/checkout-preview?vehicleId=${vehicleId}&driverId=${f.drivers.a1}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    return { odometer: odometer.body.lastTelematicsHint as unknown, preview: preview.body.telematicsHint as unknown };
  }

  // ---------------------------------------------------------------------------------------------
  // R-5.6-17 — aide télématique de la remise et de la restitution
  // ---------------------------------------------------------------------------------------------

  it('R-5.6-17 — aide télématique : valeur de l’association en cours seulement (jamais celle d’un boîtier réutilisé), de la nature retenue ; la valeur enregistrée reste celle saisie', async () => {
    await permits();
    const { provider, vehicleId: first, mappingId, mappingVersion, unitId } = await provision({
      at: '2026-09-24T09:05:00Z',
      unit: 'U-H',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '49000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-H', ['COMPTEUR_CAN', 'DISTANCE_GPS'])],
        odometerSamples: [can('U-H', '50000', '2026-09-24T09:00:00Z'), can('U-H', '12050', '2026-09-24T11:00:00Z'), gps('U-H', '900', '2026-09-24T11:10:00Z')],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    const expected = { valueKm: '50000.000', kind: 'COMPTEUR_CAN', observedAt: '2026-09-24T09:00:00.000Z' };
    expect(await hints(first)).toEqual({ odometer: expected, preview: expected });

    // Le boîtier est déposé à 10:00 et posé sur un second véhicule : son état garde 50 000 km observés sur le
    // premier véhicule, jamais proposés pour le second.
    t.clock.set('2026-09-24T10:00:00Z');
    const closed = await chefA.post(`/telemetry/mappings/${mappingId}/close`, { reason: 'Boîtier déposé', expectedVersion: mappingVersion });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const second = await createVehicle(t.prisma, f, 'A', { code: 'V-SECOND' });
    expect((await chefA.post(`/vehicles/${second}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '12000' })).status).toBe(201);
    const moved = await chefA.post('/telemetry/mappings', { unitId, vehicleId: second, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body.validFrom).toBe('2026-09-24T10:00:00.000Z');
    const state = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } });
    expect([state.lastOdometerValueKm?.toString(), state.lastOdometerObservedAt?.toISOString()]).toEqual(['50000', '2026-09-24T09:00:00.000Z']);
    expect(await hints(second)).toEqual({ odometer: null, preview: null });
    expect(await hints(first)).toEqual({ odometer: null, preview: null });

    // Première donnée depuis la pose (11:00, CAN 12 050) puis une distance GPS plus récente (nature non
    // retenue) : l'aide propose la valeur CAN observée pendant l'association en cours.
    await runDue('2026-09-24T11:30:00Z');
    expect((await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } })).lastOdometerKind).toBe('DISTANCE_GPS');
    const current = { valueKm: '12050.000', kind: 'COMPTEUR_CAN', observedAt: '2026-09-24T11:00:00.000Z' };
    expect(await hints(second)).toEqual({ odometer: current, preview: current });

    // Remise : la valeur enregistrée est celle lue sur le tableau de bord, pas l'aide.
    const usage = await checkout(second, '12063', '2026-09-24T11:40:00Z', '2026-09-24T18:00:00Z');
    const stored = await t.prisma.client.vehicleUsage.findUniqueOrThrow({ where: { id: usage.id }, include: { checkoutReading: true } });
    expect(stored.checkoutReading).toMatchObject({ source: 'MANUAL', status: 'ACCEPTE' });
    expect(stored.checkoutReading?.physicalKm?.toString()).toBe('12063');
    expect((await chefA.get(`/vehicles/${second}/odometer`)).body.reading).toMatchObject({ physicalKm: '12063.000', source: 'MANUAL' });

    // Désactivation du fournisseur : plus d'association en cours, plus d'aide (régime manuel).
    t.clock.set('2026-09-24T12:00:00Z');
    const fresh = (await admin.get(`/telemetry/providers/${provider.id}`)).body as Provider;
    expect((await admin.post(`/telemetry/providers/${provider.id}/deactivate`, { reason: 'Fin de contrat', expectedVersion: fresh.version })).status).toBe(200);
    expect(await hints(second)).toEqual({ odometer: null, preview: null });
  });

  // ---------------------------------------------------------------------------------------------
  // R-14.3-X01, R-8.5-12 — conservation après désactivation et après purge
  // ---------------------------------------------------------------------------------------------

  it('R-14.3-X01, R-8.5-12 — désactivation par société : relevés TELEMATICS et événements carburant conservés (non qualifiés toujours à qualifier), régime manuel sans aide télématique ; purge : seuls les échantillons sont supprimés', async () => {
    const { vehicleId, unitId } = await provision({
      at: '2026-09-24T09:25:00Z',
      unit: 'U-K',
      odometerKind: 'COMPTEUR_CAN',
      fuelKinds: ['NIVEAU_SONDE'],
      init: { km: '60000', at: '2026-09-01T08:00:00Z' },
      vehicle: { energy: 'DIESEL', tankCapacityLiters: '80' },
      scenario: {
        units: [unitDef('U-K', ['COMPTEUR_CAN'], ['NIVEAU_SONDE'])],
        odometerSamples: [can('U-K', '60100', '2026-09-24T09:00:00Z')],
        fuelSamples: [
          fuel('U-K', 'NIVEAU_SONDE', '60', '2026-09-24T09:00:00Z'),
          fuel('U-K', 'NIVEAU_SONDE', '55', '2026-09-24T09:05:00Z'),
          fuel('U-K', 'NIVEAU_SONDE', '48', '2026-09-24T09:10:00Z'),
          fuel('U-K', 'NIVEAU_SONDE', '42', '2026-09-24T09:15:00Z'),
          fuel('U-K', 'NIVEAU_SONDE', '35', '2026-09-24T09:20:00Z'),
        ],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    const readingsBefore = await telematicsReadings(vehicleId);
    expect(readingsBefore.map((r) => [r.physicalKm?.toString(), r.status, r.source])).toEqual([['60100', 'ACCEPTE', 'TELEMATICS']]);
    const eventsBefore = await t.prisma.client.fuelEvent.findMany({ where: { vehicleId } });
    expect(eventsBefore.map((e) => [e.type, e.status])).toEqual([['BAISSE_ANORMALE', 'A_QUALIFIER']]);
    const samples = { fuel: await t.prisma.client.fuelLevelSample.count({ where: { unitId } }), odometer: await t.prisma.client.telemetryOdometerSample.count({ where: { unitId } }) };
    expect(samples).toEqual({ fuel: 5, odometer: 1 });
    const hint = { valueKm: '60100.000', kind: 'COMPTEUR_CAN', observedAt: '2026-09-24T09:00:00.000Z' };
    expect(await hints(vehicleId)).toEqual({ odometer: hint, preview: hint });

    // Désactivation par l'administrateur (motif, audit) : plus aucun run pour la société.
    t.clock.set('2026-09-24T10:00:00Z');
    await setCompany(false);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'telemetrie.societe.desactivation' } })).toBe(1);
    expect((await runDue('2026-09-24T11:00:00Z')).runs).toEqual([]);
    // Historique intact : relevés, compteur courant et événements carburant.
    const readingsAfter = await telematicsReadings(vehicleId);
    expect(readingsAfter.map((r) => [r.id, r.status, r.physicalKm?.toString()])).toEqual(readingsBefore.map((r) => [r.id, r.status, r.physicalKm?.toString()]));
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '60100.000', source: 'TELEMATICS' });
    const pending = await chefA.get(`/telemetry/fuel-events?status=A_QUALIFIER&vehicleId=${vehicleId}`);
    expect(pending.body.items.map((e: { id: string; status: string }) => [e.id, e.status])).toEqual([[eventsBefore[0]?.id, 'A_QUALIFIER']]);
    expect((await chefA.get(`/vehicles/${vehicleId}/readings`)).body.items.some((r: { source: string }) => r.source === 'TELEMATICS')).toBe(true);
    // Régime manuel : plus d'aide télématique à la saisie (association conservée mais module désactivé).
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { vehicleId, status: 'CONFIRME', validTo: null } })).toBe(1);
    expect(await hints(vehicleId)).toEqual({ odometer: null, preview: null });
    // Régime manuel : relevé manuel accepté, et l'événement non qualifié reste à qualifier par le chef.
    expect((await manualReading(vehicleId, '60200', '2026-09-24T11:10:00Z')).outcome).toBe('ACCEPTE');
    const qualified = await chefA.post(`/telemetry/fuel-events/${eventsBefore[0]?.id}/qualify`, { qualification: 'ANOMALIE_CONFIRMEE', note: 'Siphonnage constaté', expectedVersion: eventsBefore[0]?.version });
    expect(qualified.status, JSON.stringify(qualified.body)).toBe(200);

    // Purge au-delà de la rétention (90 jours) : échantillons supprimés, relevés et événements conservés.
    const purged = await t.app.get(TelemetrySyncService).purgeSamples(new Date('2027-01-15T00:00:00Z'));
    expect(purged).toMatchObject({ fuelSamples: 5, odometerSamples: 1 });
    expect(await t.prisma.client.fuelLevelSample.count({ where: { unitId } })).toBe(0);
    expect(await t.prisma.client.telemetryOdometerSample.count({ where: { unitId } })).toBe(0);
    expect((await telematicsReadings(vehicleId)).map((r) => r.id)).toEqual(readingsBefore.map((r) => r.id));
    const eventsAfterPurge = await t.prisma.client.fuelEvent.findMany({ where: { vehicleId } });
    expect(eventsAfterPurge.map((e) => [e.id, e.type, e.status, e.qualification, e.litersDelta?.toString()])).toEqual([[eventsBefore[0]?.id, 'BAISSE_ANORMALE', 'QUALIFIE', 'ANOMALIE_CONFIRMEE', '25']]);
    expect((await chefA.get(`/telemetry/fuel-events/${eventsBefore[0]?.id}`)).status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // R-5.6-X01 — distance GPS d'un nouveau boîtier sans référence
  // ---------------------------------------------------------------------------------------------

  it('R-5.6-X01 — changement de boîtier DISTANCE_GPS : aucune conversion avec l’ancienne référence (valeur brute dans l’état de l’unité, aucun relevé, compteur et entretien inchangés, absence signalée, aucune aide de saisie) ; estimation dès la première référence manuelle', async () => {
    await permits();
    const { provider, vehicleId, mappingId } = await provision({
      at: '2026-09-24T09:52:00Z',
      unit: 'U-G1',
      odometerKind: 'DISTANCE_GPS',
      init: { km: '79000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-G1', ['DISTANCE_GPS']), unitDef('U-G2', ['DISTANCE_GPS'])],
        odometerSamples: [
          gps('U-G1', '12000', '2026-09-24T09:50:00Z'),
          gps('U-G1', '12450', '2026-09-24T19:55:00Z'),
          gps('U-G2', '25000', '2026-09-24T21:00:00Z'),
          gps('U-G2', '25050', '2026-09-24T22:00:00Z'),
          gps('U-G2', '25150', '2026-09-24T23:30:00Z'),
        ],
      },
    });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type.body.id, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '82000', baseDate: '2026-03-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body).toMatchObject({ nextDueKm: '92000', status: 'A_JOUR' });

    await runDue('2026-09-24T09:52:00Z');
    const usage = await checkout(vehicleId, '80000', '2026-09-24T10:00:00Z', '2026-09-25T18:00:00Z');
    await runDue('2026-09-24T20:00:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => [r.cumulativeKm?.toString(), r.isEstimate])).toEqual([['80450', true]]);
    // Aide de saisie (R-5.6-17) : l'estimation calibrée, jamais la distance GPS brute (12 450) du boîtier.
    const estimated = { valueKm: '80450.000', kind: 'DISTANCE_GPS', observedAt: '2026-09-24T19:55:00.000Z' };
    expect(await hints(vehicleId)).toEqual({ odometer: estimated, preview: estimated });

    // Changement de boîtier à 20:30 : la nouvelle association n'a encore aucune référence manuelle.
    t.clock.set('2026-09-24T20:30:00Z');
    const g2 = await unitIdOf(provider.id, 'U-G2');
    const mapping = await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: mappingId } });
    const closed = await chefA.post(`/telemetry/mappings/${mappingId}/close`, { reason: 'Boîtier remplacé', replacement: { unitId: g2, odometerKind: 'DISTANCE_GPS', fuelKinds: [] }, expectedVersion: mapping.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const replacementId = closed.body.replacement.id as string;

    // 25 050 km de distance GPS du nouveau boîtier : avec l'ancienne référence (80 000 à 12 000) on obtiendrait
    // 93 050 km et une échéance dépassée (92 000). Rien n'est converti ni fabriqué.
    const noReference = await runDue('2026-09-24T22:10:00Z');
    const run = await runRow(noReference);
    expect(run.status).toBe('SUCCES');
    expect(run.readingsCreated).toBe(0);
    expect(run.errorSummary).toContain('distance GPS non calibrée : aucune référence manuelle exploitable (échantillon conservé)');
    expect((await telematicsReadings(vehicleId)).map((r) => r.cumulativeKm?.toString())).toEqual(['80450']);
    const g2State = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId: g2 } });
    expect([g2State.lastOdometerValueKm?.toString(), g2State.lastOdometerKind]).toEqual(['25050', 'DISTANCE_GPS']);
    expect(await t.prisma.client.telemetryCalibration.count({ where: { mappingId: replacementId } })).toBe(0);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ cumulativeKm: '80450.000', isEstimate: true });
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ status: 'A_JOUR', currentKm: '80450' });
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId } })).toBe(1);
    // Aucune aide de saisie : ni la distance brute du nouveau boîtier (25 050), ni l'estimation de l'ancien.
    expect(await hints(vehicleId)).toEqual({ odometer: null, preview: null });

    // Restitution manuelle à 22:30 (distance GPS 25 050 à 22:00) : première référence du nouveau boîtier.
    await giveBack(usage, '80700', '2026-09-24T22:30:00Z');
    const calibrations = await t.prisma.client.telemetryCalibration.findMany({ where: { mappingId: replacementId } });
    expect(calibrations.map((c) => [c.status, c.referenceKm.toString(), c.referenceGpsDistanceKm?.toString()])).toEqual([['CALIBRE', '80700', '25050']]);
    await runDue('2026-09-24T23:40:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => [r.cumulativeKm?.toString(), r.calibrationId])).toEqual([
      ['80450', expect.any(String)],
      ['80800', calibrations[0]?.id],
    ]);
    const recalibrated = { valueKm: '80800.000', kind: 'DISTANCE_GPS', observedAt: '2026-09-24T23:30:00.000Z' };
    expect(await hints(vehicleId)).toEqual({ odometer: recalibrated, preview: recalibrated });
  });

  // ---------------------------------------------------------------------------------------------
  // R-5.6-16 — plan limité aux relevés manuels ou CAN
  // ---------------------------------------------------------------------------------------------

  it('R-5.6-16 — plan MANUEL_OU_CAN : une estimation DISTANCE_GPS qui franchit l’échéance est ignorée (le plan « toutes sources » est alimenté) ; un relevé manuel le fait avancer', async () => {
    await permits();
    const { vehicleId } = await provision({
      at: '2026-09-24T09:52:00Z',
      unit: 'U-P',
      odometerKind: 'DISTANCE_GPS',
      init: { km: '79000', at: '2026-09-01T08:00:00Z' },
      scenario: { units: [unitDef('U-P', ['DISTANCE_GPS'])], odometerSamples: [gps('U-P', '12000', '2026-09-24T09:50:00Z'), gps('U-P', '12400', '2026-09-24T19:55:00Z')] },
    });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    const type2 = await admin.post('/maintenance-types', { code: 'FILTRE', label: 'Filtre à air' });
    const base = { intervalKm: '10000', noticeKm: '300', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '70400', baseDate: '2026-03-01' } };
    const all = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type.body.id, acceptedSources: 'TOUTES', ...base });
    const strict = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type2.body.id, acceptedSources: 'MANUEL_OU_CAN', ...base });
    expect([all.status, strict.status]).toEqual([201, 201]);

    await runDue('2026-09-24T09:52:00Z');
    await checkout(vehicleId, '80000', '2026-09-24T10:00:00Z', '2026-09-25T18:00:00Z');
    expect((await chefA.get(`/maintenance-plans/${all.body.id}`)).body).toMatchObject({ status: 'A_JOUR', currentKm: '80000' });
    expect((await chefA.get(`/maintenance-plans/${strict.body.id}`)).body).toMatchObject({ status: 'A_JOUR', currentKm: '80000' });

    // Estimation GPS 80 400 (échéance) : le plan « toutes sources » passe à faire, pas le plan MANUEL_OU_CAN.
    await runDue('2026-09-24T20:00:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => [r.cumulativeKm?.toString(), r.isEstimate, r.measurementKind])).toEqual([['80400', true, 'DISTANCE_GPS']]);
    expect((await chefA.get(`/maintenance-plans/${all.body.id}`)).body).toMatchObject({ status: 'A_FAIRE', currentKm: '80400', currentKmSource: 'ESTIME_GPS' });
    expect((await chefA.get(`/maintenance-plans/${strict.body.id}`)).body).toMatchObject({ status: 'A_JOUR', currentKm: '80000', currentKmSource: 'COMPTEUR_AFFICHE' });
    expect(await t.prisma.client.alert.count({ where: { objectId: strict.body.id, status: 'ACTIVE' } })).toBe(0);

    // Relevé manuel 80 150 : le plan MANUEL_OU_CAN avance sur ce seul relevé physique.
    expect((await manualReading(vehicleId, '80150', '2026-09-24T20:30:00Z')).outcome).toBe('ACCEPTE');
    expect((await chefA.get(`/maintenance-plans/${strict.body.id}`)).body).toMatchObject({ status: 'A_PREVOIR', currentKm: '80150', currentKmSource: 'COMPTEUR_AFFICHE' });
  });

  // ---------------------------------------------------------------------------------------------
  // R-8.5-01 — carburant seulement pour les natures déclarées
  // ---------------------------------------------------------------------------------------------

  it('R-8.5-01 — carburant collecté pour les seules natures déclarées par l’association : nature exposée mais non retenue ignorée ; association sans carburant : aucune donnée carburant', async () => {
    const { provider, vehicleId, unitId } = await provision({
      at: '2026-09-24T09:25:00Z',
      unit: 'U-F1',
      odometerKind: 'AUCUN',
      fuelKinds: ['NIVEAU_SONDE'],
      scenario: {
        units: [unitDef('U-F1', [], ['NIVEAU_SONDE', 'NIVEAU_CAN']), unitDef('U-F2', ['COMPTEUR_CAN'], ['NIVEAU_SONDE'])],
        odometerSamples: [can('U-F2', '10100', '2026-09-24T09:00:00Z')],
        fuelSamples: [
          fuel('U-F1', 'NIVEAU_SONDE', '40', '2026-09-24T09:00:00Z', true),
          fuel('U-F1', 'NIVEAU_CAN', '41', '2026-09-24T09:00:00Z', true),
          fuel('U-F1', 'NIVEAU_SONDE', '39', '2026-09-24T09:10:00Z', true),
          fuel('U-F1', 'NIVEAU_CAN', '40', '2026-09-24T09:10:00Z', true),
          fuel('U-F2', 'NIVEAU_SONDE', '70', '2026-09-24T09:00:00Z', true),
          fuel('U-F2', 'NIVEAU_SONDE', '69', '2026-09-24T09:10:00Z', true),
        ],
      },
    });
    const other = await createVehicle(t.prisma, f, 'A', { code: 'V-F2' });
    expect((await chefA.post(`/vehicles/${other}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' })).status).toBe(201);
    const f2 = await unitIdOf(provider.id, 'U-F2');
    // L'unité U-F2 expose une sonde, mais son association ne déclare aucune nature carburant.
    expect((await chefA.post('/telemetry/mappings', { unitId: f2, vehicleId: other, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] })).status).toBe(201);

    const result = await runDue('2026-09-24T09:30:00Z');
    const run = await runRow(result);
    expect(run.status).toBe('SUCCES');
    expect(run.errorSummary).toContain('nature carburant NIVEAU_CAN non retenue pour l’association (ignorée)');
    const stored = await t.prisma.client.fuelLevelSample.findMany({ where: { vehicleId }, orderBy: { observedAt: 'asc' } });
    expect(stored.map((s) => [s.kind, s.liters?.toString()])).toEqual([
      ['NIVEAU_SONDE', '40'],
      ['NIVEAU_SONDE', '39'],
    ]);
    expect((await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } })).lastFuelKind).toBe('NIVEAU_SONDE');
    // Aucune donnée carburant pour l'association sans nature déclarée (kilométrage seul).
    expect(await t.prisma.client.fuelLevelSample.count({ where: { vehicleId: other } })).toBe(0);
    const f2State = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId: f2 } });
    expect([f2State.lastOdometerValueKm?.toString(), f2State.lastFuelValue, f2State.lastFuelKind]).toEqual(['10100', null, null]);
    expect(await t.prisma.client.fuelEvent.count()).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // R-14.5-05 — compteur CAN inférieur après changement de boîtier
  // ---------------------------------------------------------------------------------------------

  it('R-14.5-05 — changement de boîtier puis COMPTEUR_CAN inférieur : relevé EN_ATTENTE motivé, compteur et segment inchangés (aucun remplacement implicite), valeur cohérente suivante acceptée', async () => {
    const { provider, vehicleId, mappingId, mappingVersion } = await provision({
      at: '2026-09-24T09:30:00Z',
      unit: 'U-C1',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '50000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-C1', ['COMPTEUR_CAN']), unitDef('U-C2', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-C1', '50100', '2026-09-24T09:00:00Z'), can('U-C2', '120', '2026-09-24T11:00:00Z'), can('U-C2', '50160', '2026-09-24T13:00:00Z')],
      },
    });
    await runDue('2026-09-24T09:30:00Z');
    const segmentsBefore = await t.prisma.client.odometerSegment.findMany({ where: { vehicleId } });
    expect(segmentsBefore).toHaveLength(1);

    t.clock.set('2026-09-24T10:00:00Z');
    const c2 = await unitIdOf(provider.id, 'U-C2');
    const closed = await chefA.post(`/telemetry/mappings/${mappingId}/close`, { reason: 'Boîtier défectueux remplacé', replacement: { unitId: c2, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] }, expectedVersion: mappingVersion });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const lower = await runDue('2026-09-24T11:30:00Z');
    expect(await runRow(lower)).toMatchObject({ status: 'SUCCES', readingsCreated: 0, readingsPending: 1 });
    const readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.anomalyCode, r.providerUnitId])).toEqual([
      ['50100', 'ACCEPTE', null, 'U-C1'],
      ['120', 'EN_ATTENTE', 'DIMINUTION', 'U-C2'],
    ]);
    expect(readings[1]?.statusReason).toContain('Diminution inexpliquée');
    // Jamais un remplacement de compteur implicite : même segment, mêmes valeurs, compteur courant inchangé.
    const segmentsAfter = await t.prisma.client.odometerSegment.findMany({ where: { vehicleId } });
    expect(segmentsAfter.map((s) => [s.id, s.startPhysicalKm.toString(), s.startCumulativeKm.toString(), s.endedAt])).toEqual(segmentsBefore.map((s) => [s.id, s.startPhysicalKm.toString(), s.startCumulativeKm.toString(), null]));
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.odometer).toMatchObject({ physicalKm: '50100.000', source: 'TELEMATICS' });
    expect(await t.prisma.client.alert.count({ where: { type: 'RELEVE_A_VALIDER', objectId: readings[1]?.id, status: 'ACTIVE' } })).toBe(1);

    // Le nouveau boîtier remonte ensuite la bonne valeur : acceptée normalement.
    await runDue('2026-09-24T13:30:00Z');
    expect((await telematicsReadings(vehicleId)).map((r) => [r.physicalKm?.toString(), r.status])).toEqual([
      ['50100', 'ACCEPTE'],
      ['120', 'EN_ATTENTE'],
      ['50160', 'ACCEPTE'],
    ]);
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId } })).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // R-14.4-04, R-13.2-27, R-14.4-06 — bail d'un couple fournisseur-société, durée des runs
  // ---------------------------------------------------------------------------------------------

  it('R-14.4-04, R-13.2-27, R-14.4-06 — deux synchronisations concurrentes du même couple : un seul run sous bail, synchronisation manuelle « déjà en cours », reprise après libération ; durée du run tracée', async () => {
    const { provider, vehicleId } = await provision({
      at: '2026-09-24T09:55:00Z',
      unit: 'U-L',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '70000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-L', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-L', '70100', '2026-09-24T09:00:00Z')],
        // Fournisseur momentanément injoignable : le run détenteur du bail attend entre deux reprises.
        failures: [{ mode: 'INJOIGNABLE', from: '2026-09-24T09:59:00Z', until: '2026-09-24T10:00:03Z', operations: ['getOdometers', 'getOdometerHistory'] }],
        supportsHistory: false,
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => (signalWaiting = resolve));
    // Attente d'une reprise : bloquée jusqu'à l'ouverture de la barrière, puis l'horloge avance de l'attente.
    const gatedSleep = async (ms: number) => {
      sleeps.push(ms);
      signalWaiting();
      await gate;
      t.clock.advance(ms);
    };

    // Deux instances du worker passent au même instant sur le même couple.
    t.clock.set('2026-09-24T10:00:00Z');
    const service = t.app.get(TelemetrySyncService);
    const workerA = service.runDue(new Date('2026-09-24T10:00:00Z'), { holder: 'worker-A', sleep: gatedSleep });
    const workerB = service.runDue(new Date('2026-09-24T10:00:00Z'), { holder: 'worker-B', sleep: gatedSleep });
    await waiting;
    // Un seul run EN_COURS pour le couple ; le bail est tenu.
    const running = await t.prisma.client.telemetrySyncRun.findMany({ where: { providerId: provider.id, companyId: f.companies.A } });
    expect(running.map((r) => r.status)).toEqual(['EN_COURS']);
    const lease = syncLeaseName(provider.id, f.companies.A);
    expect(await t.app.get(TelemetryLeaseService).acquire(lease, 'worker-C', 60_000, t.clock.now())).toBe(false);
    // Synchronisation manuelle demandée pendant ce temps : « déjà en cours », aucun second run.
    const manual = await chefA.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(manual.status, JSON.stringify(manual.body)).toBe(202);
    expect(manual.body.runs).toEqual([expect.objectContaining({ companyId: f.companies.A, alreadyRunning: true, syncRunId: running[0]?.id, status: 'EN_COURS' })]);
    expect(await t.prisma.client.telemetrySyncRun.count({ where: { providerId: provider.id, companyId: f.companies.A } })).toBe(1);

    release();
    const [a, b] = await Promise.all([workerA, workerB]);
    const runs = [...a.runs, ...b.runs];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: running[0]?.id, status: 'SUCCES' });
    // Reprises 1 s puis 4 s dans le run : durée tracée (horloge contrôlée), volumes et résultat.
    expect(sleeps).toEqual([1000, 4000]);
    const done = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: running[0]?.id as string } });
    expect(done).toMatchObject({ status: 'SUCCES', durationMs: 5000, readingsCreated: 1, errorCount: 0 });
    expect(done.finishedAt?.getTime()).toBe(done.startedAt.getTime() + 5000);
    const listed = await chefA.get(`/telemetry/sync-runs?providerId=${provider.id}`);
    expect(listed.body.items.find((r: { id: string }) => r.id === done.id)).toMatchObject({ durationMs: 5000, status: 'SUCCES', readingsCreated: 1 });
    expect(await t.app.get(TelemetryLeaseService).isHeld(lease, t.clock.now())).toBe(false);

    // Bail libéré : la synchronisation manuelle démarre un nouveau run, sans doublon de relevé.
    const again = await chefA.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(again.body.runs).toEqual([expect.objectContaining({ alreadyRunning: false, status: 'EN_COURS' })]);
    let second = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: again.body.runs[0].syncRunId as string } });
    for (let i = 0; i < 100 && second.status === 'EN_COURS'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      second = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: second.id } });
    }
    expect(second).toMatchObject({ trigger: 'MANUEL', status: 'SUCCES', readingsCreated: 0, durationMs: 0 });
    expect((await telematicsReadings(vehicleId)).map((r) => r.physicalKm?.toString())).toEqual(['70100']);
  });

  // ---------------------------------------------------------------------------------------------
  // R-13.2-26 — état de l'unité : dernière valeur et erreurs
  // ---------------------------------------------------------------------------------------------

  it('R-13.2-26 — TelemetryUnitState : dernière valeur reçue et dernière erreur de l’unité, effacée au premier échantillon historisé sans erreur', async () => {
    const { vehicleId, unitId } = await provision({
      at: '2026-09-24T09:25:00Z',
      unit: 'U-E',
      odometerKind: 'COMPTEUR_CAN',
      init: null,
      scenario: {
        units: [unitDef('U-E', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-E', '30100', '2026-09-24T09:00:00Z'), can('U-E', '30150', '2026-09-24T10:00:00Z'), can('U-E', '30050', '2026-09-24T11:00:00Z')],
        supportsHistory: false,
      },
    });
    // Compteur non initialisé : échantillon conservé, aucune donnée inventée, erreur tenue sur l'unité.
    const first = await runDue('2026-09-24T09:30:00Z');
    expect(await runRow(first)).toMatchObject({ status: 'SUCCES', readingsCreated: 0 });
    let state = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } });
    expect([state.lastOdometerValueKm?.toString(), state.lastOdometerKind, state.lastOdometerObservedAt?.toISOString()]).toEqual(['30100', 'COMPTEUR_CAN', '2026-09-24T09:00:00.000Z']);
    expect(state.lastError).toBe('compteur du véhicule non initialisé : relevé manuel initial requis (échantillon conservé)');
    expect(await telematicsReadings(vehicleId)).toHaveLength(0);

    // Compteur initialisé : l'échantillon suivant est historisé et l'erreur effacée.
    t.clock.set('2026-09-24T09:40:00Z');
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '30000' })).status).toBe(201);
    await runDue('2026-09-24T10:10:00Z');
    state = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } });
    expect([state.lastOdometerValueKm?.toString(), state.lastError, state.lastHistorizedValueKm?.toString()]).toEqual(['30150', null, '30150']);

    // Régression : relevé en attente et erreur de nouveau tenue sur l'unité.
    await runDue('2026-09-24T11:10:00Z');
    state = await t.prisma.client.telemetryUnitState.findUniqueOrThrow({ where: { unitId } });
    expect([state.lastOdometerValueKm?.toString(), state.lastError]).toEqual(['30050', 'relevé automatique incohérent mis en attente de validation']);
  });

  // ---------------------------------------------------------------------------------------------
  // R-14.4-08 — parcours manuels pendant une panne du fournisseur
  // ---------------------------------------------------------------------------------------------

  it('R-14.4-08 — fournisseur en panne puis coupe-circuit ouvert : remise, restitution, relevé et clôture d’entretien aboutissent', async () => {
    await permits();
    const { provider, vehicleId } = await provision({
      at: '2026-09-24T09:25:00Z',
      unit: 'U-O',
      odometerKind: 'COMPTEUR_CAN',
      init: { km: '40000', at: '2026-09-01T08:00:00Z' },
      scenario: {
        units: [unitDef('U-O', ['COMPTEUR_CAN'])],
        odometerSamples: [can('U-O', '40100', '2026-09-24T09:00:00Z')],
        failures: [{ mode: 'INJOIGNABLE', from: '2026-09-24T09:26:00Z', operations: ['getOdometers', 'getOdometerHistory', 'getFuel', 'listUnits', 'healthCheck'] }],
        supportsHistory: false,
      },
    });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type.body.id, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '35000', baseDate: '2026-03-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);

    // Première panne : run en échec.
    const failed = await runDue('2026-09-24T09:30:00Z');
    expect(failed.runs.map((r) => r.status)).toEqual(['ECHEC']);
    // Remise et restitution pendant la panne.
    const usage = await checkout(vehicleId, '40120', '2026-09-24T09:40:00Z', '2026-09-24T18:00:00Z');
    await giveBack(usage, '40180', '2026-09-24T09:50:00Z');

    // Échecs répétés jusqu'au coupe-circuit (5 échecs, délai exponentiel entre runs).
    for (const at of ['2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z', '2026-09-24T12:00:00Z', '2026-09-24T13:00:00Z']) {
      expect((await runDue(at)).runs.map((r) => r.status), at).toEqual(['ECHEC']);
    }
    const state = await t.prisma.client.telemetryProvider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(state.consecutiveFailures).toBe(5);
    expect(state.circuitOpenUntil?.toISOString()).toBe('2026-09-24T14:00:00.000Z');
    expect(await t.prisma.client.alert.count({ where: { type: 'GPS_SYNCHRO_EN_ECHEC', status: 'ACTIVE' } })).toBe(1);

    // Coupe-circuit ouvert : relevé libre, remise, restitution et clôture d'entretien avec relevé.
    expect((await manualReading(vehicleId, '40200', '2026-09-24T13:05:00Z')).outcome).toBe('ACCEPTE');
    const again = await checkout(vehicleId, '40210', '2026-09-24T13:10:00Z', '2026-09-24T18:00:00Z');
    await giveBack(again, '40290', '2026-09-24T13:20:00Z');
    t.clock.set('2026-09-24T13:30:00Z');
    const intervention = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId: plan.body.id }] });
    expect(intervention.status, JSON.stringify(intervention.body)).toBe(201);
    const completed = await chefA
      .post(`/interventions/${intervention.body.id}/complete`, {
        completedTaskIds: intervention.body.tasks.map((x: { id: string }) => x.id),
        expectedVersion: intervention.body.version,
        performedOn: '2026-09-24',
        newReading: { physicalKm: '40300', observedAt: '2026-09-24T13:25:00Z' },
      })
      .set('Idempotency-Key', randomUUID());
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.status).toBe('TERMINEE');
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ baseKm: '40300', nextDueKm: '50300' });
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.body.odometer).toMatchObject({ physicalKm: '40300.000', source: 'MANUAL' });
    // Rien n'a été ingéré du fournisseur pendant la panne.
    expect(await telematicsReadings(vehicleId)).toHaveLength(0);
    expect((await runDue('2026-09-24T13:40:00Z')).runs.map((r) => r.status)).toEqual(['IGNORE']);
  });
});
