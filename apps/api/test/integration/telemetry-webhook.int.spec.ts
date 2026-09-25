import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretsCryptoService } from '../../src/infra/secrets-crypto.service.js';
import { TelemetrySyncService, WEBHOOK_MAX_ATTEMPTS } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_PENDING, WEBHOOK_SETTINGS_BOUNDS } from '../../src/modules/telemetry/webhook/telemetry-webhook-format.js';
import { webhookSignatureHeader } from '../../src/modules/telemetry/webhook/telemetry-webhook-signature.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

interface Provider {
  id: string;
  version: number;
  status: string;
  channel: string;
}

/** Secret de signature tel que l'écran d'administration le génère (32 octets aléatoires, base64url). */
function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

function can(unit: string, valueKm: string, observedAt: string, sourceReference?: string) {
  return { unitExternalId: unit, kind: 'COMPTEUR_CAN', valueKm, observedAt, ...(sourceReference ? { sourceReference } : {}) };
}

function probe(unit: string, liters: string, observedAt: string) {
  return { unitExternalId: unit, kind: 'NIVEAU_SONDE', liters, engineOn: false, speedKmh: '0', observedAt };
}

describe('Connecteur télématique — réception webhook signée (CDC 14.4, 14.6 ; D-298 ; R-14.4-02, R-14.4-X01)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;

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
  });

  // ---------------------------------------------------------------------------------------------
  // Aides
  // ---------------------------------------------------------------------------------------------

  function unixNow(offsetSeconds = 0): string {
    return String(Math.floor(t.clock.now().getTime() / 1000) + offsetSeconds);
  }

  /** Envoi d'un lot tel qu'un fournisseur le ferait : corps brut, horodatage et signature HMAC. */
  function push(providerId: string, body: string, options: { secret?: string | null; timestamp?: string; signature?: string; contentType?: string } = {}) {
    const timestamp = options.timestamp ?? unixNow();
    const req = request(t.server).post(`/api/v1/telemetry/webhooks/${providerId}`).set('Content-Type', options.contentType ?? 'application/json');
    if (options.secret !== null) {
      req.set('X-Webhook-Timestamp', timestamp);
      req.set('X-Webhook-Signature', options.signature ?? webhookSignatureHeader(options.secret ?? '', timestamp, Buffer.from(body, 'utf8')));
    }
    return req.send(body);
  }

  async function setCompany(company: 'A' | 'B', enabled: boolean): Promise<void> {
    const res = await admin.post(`/telemetry/companies/${f.companies[company]}/${enabled ? 'enable' : 'disable'}`, { reason: enabled ? 'Mise en service du module F11' : 'Suspension du module F11' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** Fournisseur WEBHOOK_GENERIQUE actif couvrant la société A, secret de signature déposé. */
  async function webhookProvider(settings: Record<string, unknown> = {}, secret = newSecret()): Promise<{ provider: Provider; secret: string }> {
    const created = await admin.post('/telemetry/providers', { name: `Webhook ${randomBytes(3).toString('hex')}`, kind: 'WEBHOOK_GENERIQUE', settings, companyIds: [f.companies.A] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: 'WEBHOOK_GENERIQUE', channel: 'WEBHOOK', status: 'BROUILLON' });
    // Activation refusée sans secret de signature.
    const refused = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(refused.status).toBe(422);
    expect(refused.body.details.problems).toContain('Secret de signature du webhook non déposé.');
    const put = await admin.put(`/telemetry/providers/${created.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    return { provider: activated.body as Provider, secret };
  }

  async function worker(at?: string) {
    if (at) t.clock.set(at);
    return t.app.get(TelemetrySyncService).runWebhooks(t.clock.now(), { holder: 'worker-test' });
  }

  async function telematicsReadings(vehicleId: string) {
    return t.prisma.client.odometerReading.findMany({ where: { vehicleId, source: 'TELEMATICS' }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }] });
  }

  async function deliveries(providerId: string) {
    return t.prisma.client.telemetryWebhookDelivery.findMany({ where: { providerId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
  }

  /** Données ingérées (relevés télématiques, échantillons, états d'unité, événements carburant). */
  async function ingested(): Promise<number[]> {
    return Promise.all([
      t.prisma.client.odometerReading.count({ where: { source: 'TELEMATICS' } }),
      t.prisma.client.telemetryOdometerSample.count(),
      t.prisma.client.fuelLevelSample.count(),
      t.prisma.client.telemetryUnitState.count(),
      t.prisma.client.fuelEvent.count(),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // Réception puis ingestion par le worker
  // ---------------------------------------------------------------------------------------------

  it('signature valide → 202, lot déposé sans ingestion synchrone, puis ingéré par le worker ; même lot rejoué (nouvelle signature) sans doublon ; rejeu exact refusé (409) ; reprise bornée d’un lot interrompu', async () => {
    await setCompany('A', true);
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-WH-1', registration: '123 TU 4567' });
    expect((await chefA.patch(`/vehicles/${vehicleId}`, { energy: 'DIESEL', tankCapacityLiters: '80', expectedVersion: 1 })).status).toBe(200);
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-20T08:00:00Z', physicalKm: '49800' })).status).toBe(201);
    const { provider, secret } = await webhookProvider();

    // 1. Premier lot : l'unité se déclare (immatriculation), aucune association encore.
    const declare = JSON.stringify({ version: 1, units: [{ externalId: 'U-1', label: 'Boîtier U-1', registration: '123-TU-4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] }] });
    const accepted = await push(provider.id, declare, { secret });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body).toEqual({ deliveryId: expect.any(String), status: 'EN_ATTENTE', receivedAt: NOW, units: 1, odometers: 0, fuel: 0 });
    // Aucune ingestion synchrone : ni unité ni run tant que le worker n'est pas passé.
    expect(await t.prisma.client.telemetryUnit.count()).toBe(0);
    expect(await t.prisma.client.telemetrySyncRun.count()).toBe(0);
    const queued = await deliveries(provider.id);
    expect(queued.map((d) => [d.status, d.attempts, d.unitCount])).toEqual([['EN_ATTENTE', 0, 1]]);
    expect(JSON.stringify(queued[0]?.payload)).not.toContain(secret);

    const first = await worker('2026-09-24T10:00:10Z');
    expect(first).toMatchObject({ processed: 1, ignored: 0, failed: 0, retried: 0 });
    expect(first.runs).toEqual([expect.objectContaining({ trigger: 'WEBHOOK', status: 'SUCCES', companyId: f.companies.A })]);
    expect((await deliveries(provider.id))[0]).toMatchObject({ status: 'TRAITE', lockedBy: null, processedAt: new Date('2026-09-24T10:00:10Z') });
    // Unité enregistrée et proposée à l'association (liste partielle, même règle que la découverte).
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: provider.id, externalId: 'U-1' } });
    const proposal = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { unitId: unit.id } });
    expect(proposal).toMatchObject({ status: 'PROPOSE', vehicleId });
    expect(await ingested()).toEqual([0, 0, 0, 0, 0]);

    // 2. Le chef confirme l'association (aucun relevé avant confirmation).
    const confirmed = await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: ['NIVEAU_SONDE'], validFrom: '2026-09-24T10:00:00Z', expectedVersion: proposal.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    // 3. Lot de mesures : kilométrage CAN (une valeur ancienne à la date d'effet exclue) et sonde carburant.
    t.clock.set('2026-09-24T12:30:00Z');
    const measures = JSON.stringify({
      version: 1,
      odometers: [can('U-1', '49900', '2026-09-24T09:00:00Z'), can('U-1', '50000', '2026-09-24T10:30:00Z'), can('U-1', '50120', '2026-09-24T11:45:00Z', 'can-50120'), can('U-1', '50120', '2026-09-24T11:45:00Z', 'can-50120')],
      fuel: [probe('U-1', '30', '2026-09-24T11:00:00Z'), probe('U-1', '30', '2026-09-24T11:05:00Z'), probe('U-1', '50', '2026-09-24T11:10:00Z'), probe('U-1', '70', '2026-09-24T11:15:00Z'), probe('U-1', '70', '2026-09-24T11:20:00Z')],
    });
    const timestamp = unixNow();
    const signature = webhookSignatureHeader(secret, timestamp, Buffer.from(measures));
    const pushed = await push(provider.id, measures, { secret, timestamp, signature });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(202);
    expect(pushed.body).toMatchObject({ units: 1, odometers: 4, fuel: 5 });
    expect(await telematicsReadings(vehicleId)).toEqual([]);

    // Rejeu exact de la même requête signée (même horodatage, même corps) : refusé, rien déposé.
    t.clock.set('2026-09-24T12:31:00Z');
    const replay = await push(provider.id, measures, { secret, timestamp, signature });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'WEBHOOK_REJOUE' });
    expect(await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: provider.id } })).toBe(2);

    const second = await worker('2026-09-24T12:31:10Z');
    expect(second).toMatchObject({ processed: 1, failed: 0 });
    const run = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: second.runs[0]?.runId as string } });
    expect(run).toMatchObject({ trigger: 'WEBHOOK', status: 'SUCCES', readingsCreated: 2, readingsPending: 0, fuelEventsCreated: 1 });
    const readings = await telematicsReadings(vehicleId);
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.measurementKind, r.context, r.channel, r.providerId, r.providerUnitId, r.createdById])).toEqual([
      ['50000', 'ACCEPTE', 'COMPTEUR_CAN', 'SYNCHRONISATION', 'WEBHOOK', provider.id, 'U-1', null],
      ['50120', 'ACCEPTE', 'COMPTEUR_CAN', 'SYNCHRONISATION', 'WEBHOOK', provider.id, 'U-1', null],
    ]);
    expect(readings[0]?.sourceReference).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(readings[1]?.sourceReference).toBe('can-50120');
    const before = await ingested();
    expect(before).toEqual([2, 2, 5, 1, 1]);
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.body.odometer).toMatchObject({ physicalKm: '50120.000', source: 'TELEMATICS', measurementKind: 'COMPTEUR_CAN' });

    // 4. Le fournisseur renvoie le même lot (nouvel horodatage, nouvelle signature) : accepté, ingéré sans doublon.
    t.clock.set('2026-09-24T12:40:00Z');
    const resent = await push(provider.id, measures, { secret });
    expect(resent.status, JSON.stringify(resent.body)).toBe(202);
    const third = await worker('2026-09-24T12:40:10Z');
    expect(third).toMatchObject({ processed: 1, failed: 0 });
    const run3 = await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: third.runs[0]?.runId as string } });
    expect(run3).toMatchObject({ status: 'SUCCES', readingsCreated: 0, fuelEventsCreated: 0, fuelSamples: 0 });
    expect(run3.duplicatesIgnored).toBeGreaterThan(0);
    expect(await ingested()).toEqual(before);
    expect((await telematicsReadings(vehicleId)).length).toBe(2);

    // 5. Worker arrêté pendant un traitement : le lot verrouillé est repris après expiration du verrou.
    t.clock.set('2026-09-24T13:00:00Z');
    const later = JSON.stringify({ version: 1, odometers: [can('U-1', '50200', '2026-09-24T12:55:00Z')] });
    const stuck = await push(provider.id, later, { secret });
    expect(stuck.status).toBe(202);
    await t.prisma.client.telemetryWebhookDelivery.update({ where: { id: stuck.body.deliveryId as string }, data: { status: 'EN_COURS', lockedBy: 'worker-arrete', lockedUntil: new Date('2026-09-24T13:05:00Z'), attempts: 1 } });
    expect(await worker('2026-09-24T13:01:00Z')).toMatchObject({ processed: 0, recovered: 0 });
    const resumed = await worker('2026-09-24T13:06:00Z');
    expect(resumed).toMatchObject({ recovered: 1, processed: 1 });
    expect(await t.prisma.client.telemetryWebhookDelivery.findUniqueOrThrow({ where: { id: stuck.body.deliveryId as string } })).toMatchObject({ status: 'TRAITE', attempts: 2 });
    // Reprise bornée : un lot interrompu à chacune de ses tentatives passe en échec définitif, sans nouvel essai.
    const poison = await push(provider.id, JSON.stringify({ version: 1, odometers: [can('U-1', '50210', '2026-09-24T12:58:00Z')] }), { secret });
    expect(poison.status).toBe(202);
    await t.prisma.client.telemetryWebhookDelivery.update({ where: { id: poison.body.deliveryId as string }, data: { status: 'EN_COURS', lockedBy: 'worker-arrete', lockedUntil: new Date('2026-09-24T13:06:30Z'), attempts: WEBHOOK_MAX_ATTEMPTS } });
    expect(await worker('2026-09-24T13:07:00Z')).toMatchObject({ recovered: 0, failed: 1, processed: 0 });
    const abandoned = await t.prisma.client.telemetryWebhookDelivery.findUniqueOrThrow({ where: { id: poison.body.deliveryId as string } });
    expect(abandoned).toMatchObject({ status: 'ECHEC', attempts: WEBHOOK_MAX_ATTEMPTS, lockedBy: null, processedAt: new Date('2026-09-24T13:07:00Z') });
    expect(abandoned.lastError).toContain('lot abandonné');
    expect(await worker('2026-09-24T13:20:00Z')).toMatchObject({ recovered: 0, failed: 0, processed: 0 });
    expect((await telematicsReadings(vehicleId)).map((r) => r.physicalKm?.toString())).not.toContain('50210');

    // 6. Traçabilité : exécutions WEBHOOK visibles, état du fournisseur, purge après la conservation.
    const runs = await admin.get(`/telemetry/sync-runs?providerId=${provider.id}`);
    expect(runs.status).toBe(200);
    expect(runs.body.items.some((r: { trigger: string }) => r.trigger === 'WEBHOOK')).toBe(true);
    const purged = await worker('2026-10-02T13:10:00Z');
    expect(purged.purged).toBe(5);
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(0);
    expect((await telematicsReadings(vehicleId)).length).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------------------------
  // Authentification
  // ---------------------------------------------------------------------------------------------

  it('signature absente, invalide, expirée, corps altéré, fournisseur inconnu ou d’un autre canal → 401 sans rien déposer ; session et CSRF ignorés sur cette route seulement', async () => {
    await setCompany('A', true);
    const { provider, secret } = await webhookProvider();
    const body = JSON.stringify({ version: 1, odometers: [can('U-1', '1000', '2026-09-24T09:55:00Z')] });

    const absent = await push(provider.id, body, { secret: null });
    expect(absent.status).toBe(401);
    expect(absent.body).toMatchObject({ code: 'SIGNATURE_ABSENTE', requestId: expect.any(String) });
    const wrong = await push(provider.id, body, { secret: newSecret() });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('SIGNATURE_INVALIDE');
    const expired = await push(provider.id, body, { secret, timestamp: unixNow(-301) });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('SIGNATURE_EXPIREE');
    const future = await push(provider.id, body, { secret, timestamp: unixNow(301) });
    expect(future.status).toBe(401);
    expect(future.body.code).toBe('SIGNATURE_EXPIREE');
    const ts = unixNow();
    const tampered = await push(provider.id, body.replace('1000', '9000'), { secret, timestamp: ts, signature: webhookSignatureHeader(secret, ts, Buffer.from(body)) });
    expect(tampered.status).toBe(401);
    expect(tampered.body.code).toBe('SIGNATURE_INVALIDE');
    const badTimestamp = await push(provider.id, body, { secret, timestamp: '2026-09-24T10:00:00Z' });
    expect(badTimestamp.status).toBe(401);
    expect(badTimestamp.body.code).toBe('HORODATAGE_INVALIDE');

    // Fournisseur inconnu, identifiant invalide, ou fournisseur d'un autre canal : même réponse qu'une signature fausse.
    const unknown = await push('0199a000-0000-7000-8000-000000000000', body, { secret });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('SIGNATURE_INVALIDE');
    expect((await push('pas-un-uuid', body, { secret })).body.code).toBe('SIGNATURE_INVALIDE');
    const sim = await admin.post('/telemetry/providers', { name: 'Simulateur', kind: 'SIMULATEUR', settings: { scenario: { units: [] } }, companyIds: [f.companies.A] });
    expect(sim.status).toBe(201);
    const other = await push(sim.body.id as string, body, { secret });
    expect(other.status).toBe(401);
    expect(other.body.code).toBe('SIGNATURE_INVALIDE');
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(0);

    // Une session valide (cookie) n'authentifie jamais un lot, et la route ignore origine et jeton CSRF.
    const withSession = await request(t.server).post(`/api/v1/telemetry/webhooks/${provider.id}`).set('Cookie', admin.cookies).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', admin.csrf).set('Content-Type', 'application/json').send(body);
    expect(withSession.status).toBe(401);
    const foreignOrigin = await push(provider.id, body, { secret }).set('Origin', 'https://intrus.example').set('Cookie', admin.cookies);
    expect(foreignOrigin.status, JSON.stringify(foreignOrigin.body)).toBe(202);
    // Les autres mutations restent protégées : origine étrangère refusée, jeton CSRF exigé.
    const crossSite = await request(t.server).post('/api/v1/telemetry/providers').set('Cookie', admin.cookies).set('Origin', 'https://intrus.example').set('X-CSRF-Token', admin.csrf).send({ name: 'X', kind: 'WEBHOOK_GENERIQUE', companyIds: [] });
    expect(crossSite.status).toBe(403);
    const noCsrf = await request(t.server).post('/api/v1/telemetry/providers').set('Cookie', admin.cookies).set('Origin', TEST_ORIGIN).send({ name: 'X', kind: 'WEBHOOK_GENERIQUE', companyIds: [] });
    expect(noCsrf.status).toBe(403);
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(1);
    // Aucune route utilisateur ne dépose un relevé TELEMATICS (5.1) : seule l'ingestion du worker en crée.
    const vehicleId = await createVehicle(t.prisma, f, 'A');
    const forged = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '1000', observedAt: '2026-09-24T09:00:00Z', source: 'TELEMATICS' });
    expect(forged.status).toBe(422);
    expect(await t.prisma.client.odometerReading.count({ where: { source: 'TELEMATICS' } })).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Fournisseur désactivé, société non activée
  // ---------------------------------------------------------------------------------------------

  it('fournisseur non actif ou module non activé : lot refusé (422) à la réception, ou ignoré par le worker s’il l’est devenu entre-temps ; aucune ingestion', async () => {
    await setCompany('A', true);
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-WH-2' });
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-20T08:00:00Z', physicalKm: '20000' })).status).toBe(201);
    const { provider, secret } = await webhookProvider();
    const declared = await push(provider.id, JSON.stringify({ version: 1, units: [{ externalId: 'U-2', label: 'Boîtier U-2' }] }), { secret });
    expect(declared.status).toBe(202);
    await worker('2026-09-24T10:00:05Z');
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: provider.id, externalId: 'U-2' } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-24T09:00:00Z' });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    const baseline = await ingested();
    expect(baseline).toEqual([0, 0, 0, 0, 0]);

    // Lot accepté, puis fournisseur suspendu avant le passage du worker : lot ignoré, jamais ingéré.
    t.clock.set('2026-09-24T10:10:00Z');
    const lot = (km: string, at: string) => JSON.stringify({ version: 1, odometers: [can('U-2', km, at)] });
    expect((await push(provider.id, lot('20100', '2026-09-24T10:05:00Z'), { secret })).status).toBe(202);
    const current = (await admin.get(`/telemetry/providers/${provider.id}`)).body as Provider;
    expect((await admin.post(`/telemetry/providers/${provider.id}/suspend`, { reason: 'Contrat en renégociation', expectedVersion: current.version })).status).toBe(200);
    const afterSuspend = await worker('2026-09-24T10:10:10Z');
    expect(afterSuspend).toMatchObject({ ignored: 1, processed: 0 });
    expect((await deliveries(provider.id)).at(-1)).toMatchObject({ status: 'IGNORE', lastError: 'Fournisseur non actif au moment du traitement : lot non ingéré.' });
    expect(await ingested()).toEqual(baseline);

    // Fournisseur suspendu : lot correctement signé refusé à la réception (422), rien n'est déposé.
    const refused = await push(provider.id, lot('20150', '2026-09-24T10:08:00Z'), { secret });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('FOURNISSEUR_INACTIF');
    expect(await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: provider.id } })).toBe(2);

    // Réactivé, puis module désactivé pour la société entre la réception et le traitement : ignoré.
    const suspended = (await admin.get(`/telemetry/providers/${provider.id}`)).body as Provider;
    expect((await admin.post(`/telemetry/providers/${provider.id}/activate`, { expectedVersion: suspended.version })).status).toBe(200);
    t.clock.set('2026-09-24T10:20:00Z');
    expect((await push(provider.id, lot('20200', '2026-09-24T10:15:00Z'), { secret })).status).toBe(202);
    await setCompany('A', false);
    const afterDisable = await worker('2026-09-24T10:20:10Z');
    expect(afterDisable).toMatchObject({ ignored: 1, processed: 0 });
    expect((await deliveries(provider.id)).at(-1)).toMatchObject({ status: 'IGNORE', lastError: 'Module télématique non activé pour les sociétés couvertes : lot non ingéré (D-101).' });
    expect(await ingested()).toEqual(baseline);

    // Module désactivé : refusé à la réception (422) ; l'application reste utilisable (saisie manuelle).
    const disabled = await push(provider.id, lot('20250', '2026-09-24T10:18:00Z'), { secret });
    expect(disabled.status).toBe(422);
    expect(disabled.body.code).toBe('TELEMETRIE_DESACTIVEE');
    const manual = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '20300', observedAt: '2026-09-24T10:20:00Z' });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect(await ingested()).toEqual(baseline);

    // Réactivé : le lot suivant est ingéré (la synchronisation par webhook n'a pas de mode manuel).
    await setCompany('A', true);
    t.clock.set('2026-09-24T11:30:00Z');
    expect((await push(provider.id, lot('20400', '2026-09-24T11:25:00Z'), { secret })).status).toBe(202);
    expect(await worker('2026-09-24T11:30:10Z')).toMatchObject({ processed: 1 });
    expect((await telematicsReadings(vehicleId)).map((r) => r.physicalKm?.toString())).toEqual(['20400']);
    const manualSync = await admin.post(`/telemetry/providers/${provider.id}/sync`, {});
    expect(manualSync.status).toBe(422);
    expect(manualSync.body.code).toBe('SYNCHRO_PAR_WEBHOOK');
  });

  // ---------------------------------------------------------------------------------------------
  // Bornes de taille et de débit, format
  // ---------------------------------------------------------------------------------------------

  it('corps trop volumineux → 413 (annoncé ou transmis par morceaux), débit par fournisseur ou file pleine → 429 avec Retry-After, type ou contenu non conformes → 415, 400 ou 422', async () => {
    await setCompany('A', true);
    const { provider, secret } = await webhookProvider({ maxRequestsPerMinute: 2 });
    const { provider: other, secret: otherSecret } = await webhookProvider({ maxRequestsPerMinute: 2 });

    // Taille : Content-Length au-delà de la borne.
    const padding = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES);
    const huge = JSON.stringify({ version: 1, units: [{ externalId: 'U-1', label: padding }] });
    const tooBig = await push(provider.id, huge, { secret });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ code: 'CONTENU_TROP_VOLUMINEUX', requestId: expect.any(String) });
    // Taille : corps transmis par morceaux sans Content-Length (serveur HTTP réel de l'application).
    const server: Server = t.app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/v1/telemetry/webhooks/${provider.id}`, headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      for (let i = 0; i < 9; i += 1) req.write(Buffer.alloc(128 * 1024, 0x20));
      req.end();
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toMatchObject({ code: 'CONTENU_TROP_VOLUMINEUX' });

    // Type et contenu.
    expect((await push(provider.id, 'version=1', { secret, contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
    const notJson = await push(provider.id, '{"version":1,', { secret });
    expect(notJson.status).toBe(400);
    expect(notJson.body.code).toBe('JSON_INVALIDE');
    const invalid = await push(provider.id, JSON.stringify({ version: 1, odometers: [{ unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '12,5', observedAt: '2026-09-24 09:00' }] }), { secret });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: 'LOT_INVALIDE', fieldErrors: { 'odometers[0].valueKm': expect.any(Array), 'odometers[0].observedAt': expect.any(Array) } });
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(0);

    // Débit : 2 lots par minute glissante pour ce fournisseur ; le troisième est refusé (429), pas celui d'un autre fournisseur.
    const lot = (n: number) => JSON.stringify({ version: 1, odometers: [can('U-1', String(1000 + n), '2026-09-24T09:50:00Z')] });
    expect((await push(provider.id, lot(1), { secret })).status).toBe(202);
    t.clock.set('2026-09-24T10:00:20Z');
    expect((await push(provider.id, lot(2), { secret })).status).toBe(202);
    t.clock.set('2026-09-24T10:00:40Z');
    const throttled = await push(provider.id, lot(3), { secret });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toMatchObject({ code: 'LIMITE_DEBIT', details: { retryAfterSeconds: 20 } });
    expect(throttled.headers['retry-after']).toBe('20');
    expect((await push(other.id, lot(3), { secret: otherSecret })).status).toBe(202);
    t.clock.set('2026-09-24T10:01:01Z');
    expect((await push(provider.id, lot(3), { secret })).status).toBe(202);
    expect(await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: provider.id } })).toBe(3);

    // File bornée : WEBHOOK_MAX_PENDING lots déjà en attente pour un fournisseur → 429 FILE_WEBHOOK_PLEINE avec Retry-After, rien déposé.
    const earlier = new Date('2026-09-24T09:00:00Z');
    const backlog = WEBHOOK_MAX_PENDING - (await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: other.id, status: 'EN_ATTENTE' } }));
    await t.prisma.client.telemetryWebhookDelivery.createMany({
      data: Array.from({ length: backlog }, (_, i) => ({
        organizationId: f.organizationId,
        providerId: other.id,
        signedAt: new Date(earlier.getTime() + i * 1000),
        receivedAt: new Date(earlier.getTime() + i * 1000),
        bodySha256: i.toString(16).padStart(64, '0'),
        sizeBytes: 32,
        payload: { version: 1, units: [], odometers: [], fuel: [] },
        nextAttemptAt: new Date(earlier.getTime() + i * 1000),
      })),
    });
    const full = await push(other.id, lot(4), { secret: otherSecret });
    expect(full.status).toBe(429);
    expect(full.body).toMatchObject({ code: 'FILE_WEBHOOK_PLEINE', details: { retryAfterSeconds: 60 } });
    expect(full.headers['retry-after']).toBe('60');
    expect(await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: other.id } })).toBe(WEBHOOK_MAX_PENDING);
  });

  // ---------------------------------------------------------------------------------------------
  // Secret de signature : chiffré, jamais restitué, rotation ; écran d'administration
  // ---------------------------------------------------------------------------------------------

  it('secret de signature chiffré au repos, jamais restitué par l’API ni journalisé ; rotation avec recouvrement puis expiration ; URL de réception pour l’administrateur seulement', async () => {
    await setCompany('A', true);
    const secret = newSecret();
    const random = secret.slice('whsec_'.length);
    const fragments = Array.from({ length: random.length - 7 }, (_, i) => random.slice(i, i + 8));
    const logs: string[] = [];
    const responses: string[] = [];
    const originals = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
    const capture = (chunk: unknown) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };
    process.stdout.write = capture;
    process.stderr.write = capture;
    let provider: Provider;
    const rotated = newSecret();
    try {
      // Secret trop faible refusé.
      const draft = await admin.post('/telemetry/providers', { name: 'Webhook T44', kind: 'WEBHOOK_GENERIQUE', companyIds: [f.companies.A] });
      expect(draft.status).toBe(201);
      const weak = await admin.put(`/telemetry/providers/${draft.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret: 'court' });
      expect(weak.status).toBe(422);
      const tooShort = await admin.put(`/telemetry/providers/${draft.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret: 'a'.repeat(31) });
      expect(tooShort.status).toBe(422);
      const withBaseUrl = await admin.patch(`/telemetry/providers/${draft.body.id}`, { baseUrl: 'https://fournisseur.example', expectedVersion: draft.body.version });
      expect(withBaseUrl.status).toBe(422);

      const put = await admin.put(`/telemetry/providers/${draft.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: NOW, previousValidUntil: null });
      responses.push(JSON.stringify(put.body));
      const activated = await admin.post(`/telemetry/providers/${draft.body.id}/activate`, { expectedVersion: draft.body.version });
      expect(activated.status).toBe(200);
      provider = activated.body as Provider;
      responses.push(JSON.stringify(activated.body));

      const view = await admin.get(`/telemetry/providers/${provider.id}/webhook`);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(view.body).toMatchObject({
        url: `${TEST_ORIGIN}/api/v1/telemetry/webhooks/${provider.id}`,
        method: 'POST',
        timestampHeader: 'X-Webhook-Timestamp',
        signatureHeader: 'X-Webhook-Signature',
        maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
        maxRequestsPerMinute: 60,
        toleranceSeconds: 300,
        rotationOverlapHours: 24,
        secret: { kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: NOW, previousValidUntil: null },
        counts: { pending: 0, receivedLast24h: 0 },
        recent: [],
        notice: null,
      });
      responses.push(JSON.stringify(view.body));
      expect((await chefA.get(`/telemetry/providers/${provider.id}/webhook`)).status).toBe(403);
      const sim = await admin.post('/telemetry/providers', { name: 'Simulateur', kind: 'SIMULATEUR', settings: { scenario: { units: [] } }, companyIds: [f.companies.A] });
      expect((await admin.get(`/telemetry/providers/${sim.body.id}/webhook`)).status).toBe(422);
      responses.push(JSON.stringify((await admin.get(`/telemetry/providers/${provider.id}`)).body));
      responses.push(JSON.stringify((await admin.get('/telemetry/providers')).body));

      const body = JSON.stringify({ version: 1, units: [{ externalId: 'U-9', label: 'Boîtier U-9' }] });
      const ok = await push(provider.id, body, { secret });
      expect(ok.status).toBe(202);
      responses.push(JSON.stringify(ok.body));
      for (const res of [await push(provider.id, body, { secret: newSecret() }), await push(provider.id, body, { secret, timestamp: unixNow(-900) }), await push(provider.id, body, { secret: null })]) {
        expect(res.status).toBe(401);
        responses.push(JSON.stringify(res.body));
      }
      const health = await admin.post(`/telemetry/providers/${provider.id}/health`);
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
      expect(health.body.message).toContain('secret de signature configuré');
      responses.push(JSON.stringify(health.body));
      await worker('2026-09-24T10:00:10Z');
      const discovered = await admin.post(`/telemetry/providers/${provider.id}/discover`);
      expect(discovered.status, JSON.stringify(discovered.body)).toBe(200);
      expect(discovered.body.unitsSeen).toBe(1);

      // Rotation : le nouveau secret est actif, l'ancien reste accepté 24 h, puis refusé et supprimé.
      t.clock.set('2026-09-24T11:00:00Z');
      const rotation = await admin.put(`/telemetry/providers/${provider.id}/credentials/SIGNATURE_WEBHOOK`, { secret: rotated });
      expect(rotation.status).toBe(200);
      expect(rotation.body).toEqual({ kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: '2026-09-24T11:00:00.000Z', previousValidUntil: '2026-09-25T11:00:00.000Z' });
      responses.push(JSON.stringify(rotation.body));
      expect((await t.prisma.client.telemetryCredential.findMany({ where: { providerId: provider.id } })).map((c) => [c.active, c.expiresAt?.toISOString() ?? null]).sort()).toEqual([
        [false, '2026-09-25T11:00:00.000Z'],
        [true, null],
      ]);
      // Chiffré au repos, vérifié pendant que les deux secrets existent (avant purge et révocation) : les
      // lignes brutes (bytea rendus en hexadécimal par row_to_json) ne contiennent le clair sous aucune
      // forme, et le chiffré se déchiffre bien en chacun des deux secrets avec la clé hors base.
      const atRest = await t.prisma.client.$queryRaw<Array<{ dump: string }>>`SELECT row_to_json(c)::text AS dump FROM "TelemetryCredential" c WHERE c."providerId" = ${provider.id}::uuid`;
      expect(atRest).toHaveLength(2);
      for (const value of [secret, rotated]) {
        for (const form of [value, Buffer.from(value).toString('hex'), Buffer.from(value).toString('base64'), random]) {
          for (const row of atRest) expect(row.dump).not.toContain(form);
        }
      }
      const crypto = t.app.get(SecretsCryptoService);
      const decrypted = (await t.prisma.client.telemetryCredential.findMany({ where: { providerId: provider.id } })).map((c) =>
        crypto.decrypt({ keyId: c.keyId, iv: Buffer.from(c.iv), authTag: Buffer.from(c.authTag), ciphertext: Buffer.from(c.ciphertext) }),
      );
      expect(decrypted.sort()).toEqual([secret, rotated].sort());
      const lot = (n: number) => JSON.stringify({ version: 1, odometers: [can('U-9', String(n), '2026-09-24T10:30:00Z')] });
      expect((await push(provider.id, lot(1), { secret })).status).toBe(202);
      expect((await push(provider.id, lot(2), { secret: rotated })).status).toBe(202);
      t.clock.set('2026-09-25T11:00:01Z');
      admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
      expect((await push(provider.id, lot(3), { secret })).status).toBe(401);
      expect((await push(provider.id, lot(4), { secret: rotated })).status).toBe(202);
      const cleaned = await worker('2026-09-25T11:00:05Z');
      expect(cleaned.secretsPurged).toBe(1);
      expect(await t.prisma.client.telemetryCredential.count({ where: { providerId: provider.id } })).toBe(1);
      const afterRotation = await admin.get(`/telemetry/providers/${provider.id}/webhook`);
      expect(afterRotation.body.secret).toMatchObject({ configured: true, previousValidUntil: null });
      // Fenêtre de 24 h glissantes : seul le lot reçu avec le nouveau secret après l'expiration de l'ancien.
      expect(afterRotation.body.counts).toMatchObject({ receivedLast24h: 1, pending: 0, processedLast24h: 3, failedLast24h: 0 });
      expect(afterRotation.body.recent).toHaveLength(4);
      responses.push(JSON.stringify(afterRotation.body));

      // Révocation immédiate : plus aucun lot authentifié.
      const revoked = await admin.delete(`/telemetry/providers/${provider.id}/credentials/SIGNATURE_WEBHOOK`);
      expect(revoked.status).toBe(200);
      expect((await push(provider.id, lot(5), { secret: rotated })).status).toBe(401);
    } finally {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
    }
    // Chiffré au repos : le clair n'apparaît dans aucune colonne ; jamais dans une réponse ni un journal.
    const everything = [...responses, ...logs].join('\n');
    for (const value of [secret, rotated]) {
      expect(everything).not.toContain(value);
      expect(everything).not.toContain(Buffer.from(value).toString('base64'));
    }
    for (const fragment of fragments) expect(everything).not.toContain(fragment);
    expect(logs.join('\n')).toContain('Lot webhook refusé (SIGNATURE_INVALIDE)');
    const stored = await t.prisma.client.$queryRaw<Array<{ dump: string }>>`SELECT row_to_json(c)::text AS dump FROM "TelemetryCredential" c`;
    const audit = await t.prisma.client.auditEvent.findMany({ where: { action: { startsWith: 'telemetrie.secret' } } });
    const persisted = [...stored.map((r) => r.dump), JSON.stringify(audit), JSON.stringify(await t.prisma.client.telemetryWebhookDelivery.findMany())].join('\n');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(rotated);
  });
});

describe('Connecteur télématique — webhook et limite de débit par adresse IP (CDC 14.4, 16.1 ; R-14.4-X01)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW, rateLimit: true });
  });
  afterAll(async () => {
    await t.close();
  });

  it('la limite IP de la route suit le plafond du débit par fournisseur : un débit autorisé n’est pas coupé à 300/min, et les requêtes non authentifiées restent bornées (429 + Retry-After)', async () => {
    await resetDatabase(t.prisma);
    const f = await seedFixture(t.prisma);
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    expect((await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11' })).status).toBe(200);
    const max = WEBHOOK_SETTINGS_BOUNDS.maxRequestsPerMinute.max;
    const created = await admin.post('/telemetry/providers', { name: 'Webhook débit maximal', kind: 'WEBHOOK_GENERIQUE', settings: { maxRequestsPerMinute: max }, companyIds: [f.companies.A] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const secret = newSecret();
    expect((await admin.put(`/telemetry/providers/${created.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret })).status).toBe(200);
    expect((await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version })).status).toBe(200);
    const url = `/api/v1/telemetry/webhooks/${created.body.id as string}`;
    const timestamp = String(Math.floor(t.clock.now().getTime() / 1000));

    // 310 lots signés depuis la même adresse dans la minute (au-delà de la limite globale de 300) : tous déposés.
    const signed: number[] = [];
    for (let i = 0; i < 310; i += 1) {
      const body = JSON.stringify({ version: 1, units: [{ externalId: `U-${i}` }] });
      const res = await request(t.server).post(url).set('Content-Type', 'application/json').set('X-Webhook-Timestamp', timestamp).set('X-Webhook-Signature', webhookSignatureHeader(secret, timestamp, Buffer.from(body))).send(body);
      signed.push(res.status);
    }
    expect(signed.filter((s) => s !== 202)).toEqual([]);
    expect(await t.prisma.client.telemetryWebhookDelivery.count({ where: { providerId: created.body.id as string } })).toBe(310);

    // Requêtes non signées depuis la même adresse : 401 jusqu'au plafond de la route, puis 429 avec Retry-After.
    const unsigned: number[] = [];
    for (let i = 310; i < max; i += 1) unsigned.push((await request(t.server).post(url).set('Content-Type', 'application/json').send('{"version":1}')).status);
    expect(unsigned.filter((s) => s !== 401)).toEqual([]);
    const flooded = await request(t.server).post(url).set('Content-Type', 'application/json').send('{"version":1}');
    expect(flooded.status).toBe(429);
    expect(flooded.body.code).toBe('LIMITE_DEBIT');
    expect(Number(flooded.headers['retry-after'])).toBeGreaterThan(0);
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(310);
  });
});
