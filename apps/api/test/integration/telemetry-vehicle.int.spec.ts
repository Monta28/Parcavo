import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelemetrySyncService } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T09:52:00.000Z';
const SENTINEL = `JETON-SENTINELLE-${randomUUID()}`;

function gps(unit: string, valueKm: string, observedAt: string) {
  return { unitExternalId: unit, kind: 'DISTANCE_GPS', valueKm, observedAt };
}

/**
 * GET /telemetry/vehicles/:vehicleId — panneau télématique de la fiche véhicule (CDC 5.6, 14.5 ;
 * D-101, D-112, D-178, D-190) : association en cours, dernière observation, dernière estimation
 * « estimé GPS » avec sa référence, dernier calibrage et dernière dérive ; périmètre et secrets (T44).
 */
describe('Connecteur télématique — état télématique d’un véhicule (lecture)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;
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
    await loginAll(NOW);
  });

  async function loginAll(at: string): Promise<void> {
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    loggedInAt = new Date(at).getTime();
  }

  /** Horloge avancée ; sessions renouvelées au-delà de 6 h (durée de session de 12 h). */
  async function at(instant: string): Promise<void> {
    t.clock.set(instant);
    if (Math.abs(new Date(instant).getTime() - loggedInAt) >= 6 * 3_600_000) await loginAll(instant);
  }

  async function runDue(instant: string) {
    await at(instant);
    return t.app.get(TelemetrySyncService).runDue(new Date(instant), { holder: 'worker-test', sleep: () => Promise.resolve() });
  }

  async function enableA(): Promise<void> {
    const res = await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function simulator(scenario: Record<string, unknown>, token?: string): Promise<{ id: string }> {
    const created = await admin.post('/telemetry/providers', { name: 'Simulateur panneau', kind: 'SIMULATEUR', settings: { scenario }, companyIds: [f.companies.A] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (token) {
      const put = await admin.put(`/telemetry/providers/${created.body.id}/credentials/JETON_API`, { secret: token });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const discovered = await admin.post(`/telemetry/providers/${created.body.id}/discover`);
    expect(discovered.status, JSON.stringify(discovered.body)).toBe(200);
    return { id: created.body.id as string };
  }

  it('périmètre : lecture par le personnel de la société (état vide sans F11), 404 hors périmètre ou inconnu, 403 conducteur', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-SANS-GPS' });
    for (const agent of [admin, chefA, operateurA, lecteurA]) {
      const res = await agent.get(`/telemetry/vehicles/${vehicleId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        vehicleId,
        vehicleCode: 'V-SANS-GPS',
        companyId: f.companies.A,
        telemetryEnabled: false,
        mapping: null,
        pendingProposals: 0,
        provider: null,
        lastObservation: null,
        lastEstimate: null,
        lastCalibration: null,
        lastDrift: null,
      });
    }
    expect((await chefB.get(`/telemetry/vehicles/${vehicleId}`)).status).toBe(404);
    expect((await admin.get(`/telemetry/vehicles/${randomUUID()}`)).status).toBe(404);
    expect((await conducteurA.get(`/telemetry/vehicles/${vehicleId}`)).status).toBe(403);
    expect((await admin.get('/telemetry/vehicles/pas-un-uuid')).status).toBe(400);
  });

  it('proposition en attente : aucune association ni donnée avant confirmation (14.5)', async () => {
    await enableA();
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-PROP', registration: '123 TU 4567' });
    await simulator({
      units: [{ externalId: 'U-P', label: 'Boîtier P', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }],
      odometerSamples: [{ unitExternalId: 'U-P', kind: 'COMPTEUR_CAN', valueKm: '50000', observedAt: '2026-09-24T09:00:00Z' }],
    });
    const res = await chefA.get(`/telemetry/vehicles/${vehicleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ telemetryEnabled: true, mapping: null, pendingProposals: 1, provider: null, lastObservation: null, lastEstimate: null });
  });

  it('boîtier réutilisé : le véhicule suivant n’hérite pas de la dernière observation du véhicule précédent (14.5, D-300)', async () => {
    await enableA();
    const first = await createVehicle(t.prisma, f, 'A', { code: 'V-AVANT' });
    const next = await createVehicle(t.prisma, f, 'A', { code: 'V-APRES' });
    const seg = await chefA.post(`/vehicles/${first}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '49000' });
    expect(seg.status, JSON.stringify(seg.body)).toBe(201);
    const provider = await simulator({
      units: [{ externalId: 'U-R', label: 'Boîtier réutilisé', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }],
      odometerSamples: [{ unitExternalId: 'U-R', kind: 'COMPTEUR_CAN', valueKm: '50000', observedAt: '2026-09-24T09:00:00Z' }],
    });
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: provider.id, externalId: 'U-R' } });
    const created = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId: first, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await runDue(NOW);
    const before = await chefA.get(`/telemetry/vehicles/${first}`);
    expect(before.body.lastObservation).toMatchObject({ odometerKm: '50000.000', odometerKind: 'COMPTEUR_CAN', odometerObservedAt: '2026-09-24T09:00:00.000Z' });

    // Le boîtier est retiré du premier véhicule puis posé sur le second : aucune donnée depuis.
    await at('2026-09-24T10:00:00Z');
    const closed = await chefA.post(`/telemetry/mappings/${created.body.id}/close`, { reason: 'Boîtier déposé', expectedVersion: created.body.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const moved = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId: next, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body.validFrom).toBe('2026-09-24T10:00:00.000Z');

    const after = await chefA.get(`/telemetry/vehicles/${next}`);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.mapping).toMatchObject({ id: moved.body.id, unitId: unit.id });
    expect(after.body.lastObservation).toBeNull();
    const previous = await chefA.get(`/telemetry/vehicles/${first}`);
    expect(previous.body).toMatchObject({ mapping: null, lastObservation: null });
  });

  it('alerte carburant → écran : lien d’action servi par /telematique/carburant, événement lu par son identifiant dans le périmètre, dernier niveau affiché par le panneau (8.5, T43)', async () => {
    await enableA();
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-CARB' });
    const probe = (liters: string, observedAt: string) => ({ unitExternalId: 'U-C', kind: 'NIVEAU_SONDE', liters, engineOn: false, speedKmh: '0', observedAt });
    const provider = await simulator({
      units: [{ externalId: 'U-C', label: 'Boîtier C', declaredRegistration: null, odometerKinds: [], fuelKinds: ['NIVEAU_SONDE'] }],
      fuelSamples: [probe('35', '2026-09-24T09:00:00Z'), probe('55', '2026-09-24T09:05:00Z'), probe('75', '2026-09-24T09:10:00Z'), probe('75', '2026-09-24T09:15:00Z'), probe('75', '2026-09-24T09:20:00Z')],
    });
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: provider.id, externalId: 'U-C' } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: 'AUCUN', fuelKinds: ['NIVEAU_SONDE'] });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    await runDue('2026-09-24T09:52:00Z');

    const event = await t.prisma.client.fuelEvent.findFirstOrThrow({ where: { vehicleId, type: 'REMPLISSAGE_DETECTE' } });
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'CARBURANT_REMPLISSAGE_DETECTE', objectId: event.id, status: 'ACTIVE' } });
    // Chemin servi par apps/web/app/(app)/telematique/carburant/page.tsx (redirection vers l'onglet carburant).
    expect(alert.actionPath).toBe(`/telematique/carburant?evenement=${event.id}`);
    const focused = await chefA.get(`/telemetry/fuel-events/${event.id}`);
    expect(focused.status, JSON.stringify(focused.body)).toBe(200);
    // Données du simulateur : l'événement est marqué pour porter la mention « SIMULATEUR — données fictives » (D-303).
    expect(focused.body).toMatchObject({ id: event.id, isSimulator: true, vehicleCode: 'V-CARB', type: 'REMPLISSAGE_DETECTE', status: 'A_QUALIFIER', litersDelta: '40.000', measureKind: 'NIVEAU_SONDE' });
    const listed = await chefA.get(`/telemetry/fuel-events?vehicleId=${vehicleId}`);
    expect(listed.body.items.map((e: { id: string; isSimulator: boolean }) => [e.id, e.isSimulator])).toEqual([[event.id, true]]);
    expect((await chefB.get(`/telemetry/fuel-events/${event.id}`)).status).toBe(404);
    expect((await conducteurA.get(`/telemetry/fuel-events/${event.id}`)).status).toBe(403);

    const panel = await lecteurA.get(`/telemetry/vehicles/${vehicleId}`);
    expect(panel.body.lastObservation).toMatchObject({ odometerKm: null, fuelKind: 'NIVEAU_SONDE', fuelLiters: '75.000', fuelPercent: null, fuelObservedAt: '2026-09-24T09:20:00.000Z' });
  });

  it('DISTANCE_GPS : unité et nature, dernière observation, estimation « estimé GPS » avec sa référence, calibrage et dérive 4,2 % ; aucun secret restitué (T38, T39, T44)', async () => {
    await enableA();
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-PANNEAU', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-GPS' });
    const seg = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '79000' });
    expect(seg.status, JSON.stringify(seg.body)).toBe(201);
    const provider = await simulator(
      {
        units: [{ externalId: 'U-G', label: 'Boîtier G', declaredRegistration: null, odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] }],
        odometerSamples: [gps('U-G', '12000', '2026-09-24T09:50:00Z'), gps('U-G', '12450', '2026-09-24T19:55:00Z'), gps('U-G', '13000', '2026-09-25T07:55:00Z')],
        authRequired: true,
      },
      SENTINEL,
    );
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: provider.id, externalId: 'U-G' } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: 'DISTANCE_GPS', fuelKinds: [] });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    await runDue(NOW);

    // Remise à 80 000 : référence de calibrage ; puis distance GPS 12 450 → estimation 80 450.
    await at('2026-09-24T10:00:00Z');
    const checkout = await operateurA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T10:00:00Z', expectedReturnAt: '2026-09-25T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '80000' }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'DEMI', checklist: [{ label: 'Clés', present: true }] })
      .set('Idempotency-Key', randomUUID());
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    await runDue('2026-09-24T20:00:00Z');

    let res = await chefA.get(`/telemetry/vehicles/${vehicleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mapping).toMatchObject({ id: mapping.body.id, unitId: unit.id, unitLabel: 'SIMULATEUR — Boîtier G', status: 'CONFIRME', odometerKind: 'DISTANCE_GPS', fuelKinds: [] });
    expect(res.body.provider).toMatchObject({ id: provider.id, kind: 'SIMULATEUR', kindLabel: 'SIMULATEUR — données fictives', isSimulator: true, status: 'ACTIF', consecutiveFailures: 0, circuitOpenUntil: null });
    expect(res.body.lastObservation).toMatchObject({ odometerKm: '12450.000', odometerKind: 'DISTANCE_GPS', odometerObservedAt: '2026-09-24T19:55:00.000Z', fuelKind: null, fuelLiters: null });
    expect(res.body.lastEstimate).toMatchObject({
      cumulativeKm: '80450.000',
      gpsDistanceKm: '12450.000',
      observedAt: '2026-09-24T19:55:00.000Z',
      // Séparateur de milliers fr-FR : espace fine insécable.
      label: expect.stringMatching(/^Estimé GPS \(réf\. manuelle du 24\/09\/2026, 80\s000 km\)$/) as unknown,
      referenceAt: '2026-09-24T10:00:00.000Z',
      referenceKm: '80000.000',
    });
    expect(res.body.lastCalibration).toMatchObject({ status: 'CALIBRE', referenceKm: '80000.000', deviationPercent: null, driftAlertRaised: false });
    expect(res.body.lastDrift).toBeNull();

    // Estimation 81 000, puis restitution manuelle 80 960 : dérive 4,2 %, alerte, nouvelle référence.
    await runDue('2026-09-25T08:00:00Z');
    await at('2026-09-25T08:00:00Z');
    const usage = await operateurA.get(`/usages/${checkout.body.id}`);
    const returned = await operateurA
      .post(`/usages/${checkout.body.id}/return`, { returnedAt: '2026-09-25T08:00:00Z', reading: { physicalKm: '80960' }, location: { placeLabel: 'Dépôt' }, expectedVersion: usage.body.version })
      .set('Idempotency-Key', randomUUID());
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);

    res = await lecteurA.get(`/telemetry/vehicles/${vehicleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lastEstimate).toMatchObject({ cumulativeKm: '81000.000', referenceKm: '80000.000' });
    const drift = {
      status: 'CALIBRE',
      referenceAt: '2026-09-25T08:00:00.000Z',
      referenceKm: '80960.000',
      estimatedKmAtReference: '81000.000',
      distanceSincePreviousKm: '960.000',
      deviationKm: '40.000',
      deviationPercent: '4.167',
      deviationPercentLabel: '4,2',
      driftAlertRaised: true,
      statusReason: null,
    };
    expect(res.body.lastCalibration).toMatchObject(drift);
    expect(res.body.lastDrift).toMatchObject(drift);

    // Aucune configuration ni secret dans la réponse, quel que soit le rôle (T44).
    for (const agent of [admin, chefA, lecteurA]) {
      const body = JSON.stringify((await agent.get(`/telemetry/vehicles/${vehicleId}`)).body);
      expect(body).not.toContain(SENTINEL);
      expect(body).not.toContain('settings');
      expect(body).not.toContain('credentials');
    }
  });
});
