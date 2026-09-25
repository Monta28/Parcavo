import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelemetrySyncService } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/** Opérations de lecture documentées (Traccar REST, Wialon Remote API) : seules admises (CDC 1.3, 14.6). */
const TRACCAR_READS = new Set(['GET /api/server', 'GET /api/devices', 'GET /api/positions']);
const WIALON_READS = new Set(['token/login', 'core/search_items', 'unit/calc_last', 'messages/load_interval', 'unit/calc_sensors', 'messages/unload', 'core/logout']);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, body: unknown, status = 200, gzip = false): void {
  const raw = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (gzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzipSync(raw));
  } else res.end(raw);
}

/**
 * Faux serveur Traccar local (formats de l'API REST Traccar 6) qui enregistre chaque requête reçue :
 * méthode, chemin et présence de l'authentification. Toute écriture (POST, PUT, DELETE, PATCH) ou tout
 * chemin hors lecture est enregistré puis refusé (405).
 */
class RecordingTraccar {
  static readonly TOKEN = `jeton-lecture-${randomBytes(8).toString('hex')}`;
  readonly requests: string[] = [];
  readonly server = createServer((req, res) => void this.handle(req, res));
  private readonly position = (id: number, fixTime: string, odometerKm: number, fuel: number) => ({
    id,
    deviceId: 7,
    protocol: 'osmand',
    valid: true,
    fixTime,
    deviceTime: fixTime,
    serverTime: fixTime,
    latitude: 36.8,
    longitude: 10.18,
    speed: 0,
    attributes: { odometer: odometerKm * 1000, fuel, ignition: false },
  });
  private readonly history = [this.position(1001, '2026-09-24T09:00:00.000Z', 50050, 41), this.position(1002, '2026-09-24T09:50:00.000Z', 50100, 40)];

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await bodyOf(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.requests.push(`${req.method ?? '?'} ${url.pathname}`);
    if (req.method !== 'GET') return json(res, { message: 'Méthode non admise par le serveur de test.' }, 405);
    if (url.pathname === '/api/server') return json(res, { id: 1, version: '6.15', registration: false, readonly: true });
    if (req.headers.authorization !== `Bearer ${RecordingTraccar.TOKEN}`) return json(res, { message: 'Unauthorized' }, 401);
    if (url.pathname === '/api/devices') return json(res, [{ id: 7, name: '123 TU 4567', uniqueId: '865000000000007', status: 'online', disabled: false, attributes: {} }]);
    if (url.pathname === '/api/positions') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from && to) return json(res, this.history.filter((p) => p.fixTime >= from && p.fixTime <= to));
      return json(res, [this.history.at(-1)]);
    }
    return json(res, { message: 'Chemin non admis par le serveur de test.' }, 405);
  }
}

/**
 * Faux serveur Wialon local (formats de la Remote API : POST /wialon/ajax.html, svc et params) qui enregistre
 * chaque service appelé ; un service hors lecture est enregistré puis refusé (code 7).
 */
class RecordingWialon {
  static readonly TOKEN = `jeton-wialon-${randomBytes(8).toString('hex')}`;
  readonly services: string[] = [];
  readonly paths: string[] = [];
  readonly server = createServer((req, res) => void this.handle(req, res));
  private readonly sessions = new Set<string>();
  private loaded: Array<Record<string, unknown>> = [];
  private readonly T = 1790236800; // 2026-09-24T08:00:00Z
  private readonly messages = [
    { t: this.T + 3000, s: 0, sensors: { '1': 62.5, '2': 0 } },
    { t: this.T + 3300, s: 0, sensors: { '1': 61.5, '2': 0 } },
  ];

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await bodyOf(req);
    this.paths.push(`${req.method ?? '?'} ${req.url?.split('?')[0] ?? ''}`);
    const form = new URLSearchParams(raw);
    const svc = form.get('svc') ?? '';
    this.services.push(svc);
    const params = JSON.parse(form.get('params') ?? '{}') as Record<string, unknown>;
    if (svc === 'token/login') {
      if (params['token'] !== RecordingWialon.TOKEN) return json(res, { error: 8 });
      const eid = randomBytes(16).toString('hex');
      this.sessions.add(eid);
      return json(res, { host: '127.0.0.1', eid, tm: this.T, user: { nm: 'lecture-parc', id: 1 } });
    }
    if (!this.sessions.has(form.get('sid') ?? '')) return json(res, { error: 1 });
    switch (svc) {
      case 'core/search_items':
        return json(res, {
          searchSpec: params['spec'],
          dataFlags: params['flags'],
          totalItemsCount: 1,
          indexFrom: 0,
          indexTo: 0,
          items: [
            {
              nm: 'Camion 12',
              cls: 2,
              id: 16091323,
              mu: 0,
              uid: '865000000000123',
              pos: { t: this.T + 3300, y: 36.8, x: 10.18, z: 12, s: 0, c: 0, sc: 9 },
              lmsg: { t: this.T + 3300, f: 7, tp: 'ud', pos: { y: 36.8, x: 10.18, z: 12, s: 0, c: 0, sc: 9 }, i: 0, o: 0, p: {} },
              sens: { '1': { id: 1, n: 'Réservoir', t: 'fuel level', d: '', m: 'l', p: 'can_fls', f: 0, c: '', vt: 0, vs: 0, tbl: [] }, '2': { id: 2, n: 'Contact', t: 'engine operation', d: '', m: 'On/Off', p: 'in1', f: 0, c: '', vt: 0, vs: 0, tbl: [] } },
              cfl: 1,
              cnm: 24498,
              cneh: 0,
              cnkb: 0,
              pflds: { '1': { id: 1, n: 'registration_plate', v: '123 TU 4567' } },
            },
          ],
        });
      case 'unit/calc_last':
        return json(res, [{ i: 16091323, mileage: { value: 24498.82, format: { value: '24498.82 km' } }, engine_hours: { value: 0, format: { value: '0.00 h' } }, pos: {}, sensors: {} }]);
      case 'messages/load_interval': {
        const from = Number(params['timeFrom']);
        const to = Number(params['timeTo']);
        this.loaded = this.messages.filter((m) => m.t >= from && m.t <= to);
        const messages = this.loaded.map((m) => ({ t: m['t'], f: 7, tp: 'ud', pos: { y: 36.8, x: 10.18, z: 12, s: m['s'], c: 0, sc: 9 }, i: 0, o: 0, p: {}, lc: 0, rt: m['t'] }));
        return json(res, { count: messages.length, messages }, 200, String(req.headers['accept-encoding'] ?? '').includes('gzip'));
      }
      case 'unit/calc_sensors':
        return json(
          res,
          this.loaded.map((m) => m['sensors']),
        );
      case 'messages/unload':
        this.loaded = [];
        return json(res, {});
      case 'core/logout':
        this.sessions.delete(form.get('sid') ?? '');
        return json(res, { error: 0 });
      default:
        return json(res, { error: 7 });
    }
  }
}

/**
 * Périmètre F11 limité à la lecture (CDC 1.3, 14.3, 14.6 ; R-1.3-05) : sur un cycle complet (test de connexion,
 * activation, découverte des unités, reprise initiale, synchronisations planifiée et manuelle, carburant), le
 * connecteur n'adresse au fournisseur que des lectures : aucune méthode ni aucun service d'écriture n'est
 * appelé (pas de commande au boîtier, pas de modification d'appareil ou d'unité chez le fournisseur).
 */
describe('Connecteur télématique — lecture seule chez le fournisseur (R-1.3-05)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  const traccar = new RecordingTraccar();
  const wialon = new RecordingWialon();
  let traccarUrl = '';
  let wialonUrl = '';

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
    traccarUrl = await listen(traccar.server);
    wialonUrl = await listen(wialon.server);
  });
  afterAll(async () => {
    await close(traccar.server);
    await close(wialon.server);
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11' })).status).toBe(200);
  });

  /** Cycle complet par l'API et le worker ; renvoie le véhicule associé. */
  async function fullCycle(provider: { kind: string; baseUrl: string; settings: Record<string, unknown>; token: string; unitExternalId: string; fuelKinds: string[] }): Promise<string> {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: `V-${provider.kind}`, registration: '123 TU 4567' });
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '20000' })).status).toBe(201);
    const created = await admin.post('/telemetry/providers', { name: `Fournisseur ${provider.kind}`, kind: provider.kind, baseUrl: provider.baseUrl, settings: provider.settings, companyIds: [f.companies.A] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await admin.put(`/telemetry/providers/${created.body.id}/credentials/JETON_API`, { secret: provider.token })).status).toBe(200);
    const health = await admin.post(`/telemetry/providers/${created.body.id}/health`);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body.ok, JSON.stringify(health.body)).toBe(true);
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const discovered = await admin.post(`/telemetry/providers/${created.body.id}/discover`);
    expect(discovered.status, JSON.stringify(discovered.body)).toBe(200);
    const unit = await t.prisma.client.telemetryUnit.findFirstOrThrow({ where: { providerId: created.body.id, externalId: provider.unitExternalId } });
    const mapping = await chefA.post('/telemetry/mappings', { unitId: unit.id, vehicleId, odometerKind: 'COMPTEUR_CAN', fuelKinds: provider.fuelKinds, validFrom: '2026-09-24T07:00:00Z' });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(201);
    const service = t.app.get(TelemetrySyncService);
    const reprise = await service.runDue(new Date(NOW), { holder: 'worker-test', sleep: () => Promise.resolve() });
    expect(reprise.runs.map((r) => [r.trigger, r.status])).toEqual([['REPRISE_INITIALE', 'SUCCES']]);
    t.clock.set('2026-09-24T10:30:00Z');
    const planned = await service.runDue(new Date('2026-09-24T10:30:00Z'), { holder: 'worker-test', sleep: () => Promise.resolve() });
    expect(planned.runs.map((r) => r.status)).toEqual(['SUCCES']);
    const manual = await chefA.post(`/telemetry/providers/${created.body.id}/sync`, {});
    expect(manual.status, JSON.stringify(manual.body)).toBe(202);
    const runId = manual.body.runs[0].syncRunId as string;
    for (let i = 0; i < 100; i += 1) {
      if ((await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: runId } })).status !== 'EN_COURS') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await t.prisma.client.telemetrySyncRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('SUCCES');
    return vehicleId;
  }

  it('Traccar : uniquement des GET sur /api/server, /api/devices et /api/positions, authentifiés par le jeton de lecture ; données ingérées', async () => {
    traccar.requests.length = 0;
    const vehicleId = await fullCycle({ kind: 'TRACCAR', baseUrl: traccarUrl, settings: { fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' }, token: RecordingTraccar.TOKEN, unitExternalId: '7', fuelKinds: ['NIVEAU_SONDE'] });
    // Le cycle a réellement lu le fournisseur : relevé CAN et échantillons carburant ingérés.
    expect((await t.prisma.client.odometerReading.findMany({ where: { vehicleId, source: 'TELEMATICS' } })).map((r) => r.physicalKm?.toString())).toEqual(['50050']);
    expect((await t.prisma.client.telemetryUnitState.findFirstOrThrow({ where: { unit: { externalId: '7' } } })).lastOdometerValueKm?.toString()).toBe('50100');
    expect(await t.prisma.client.fuelLevelSample.count({ where: { vehicleId } })).toBeGreaterThan(0);
    expect(traccar.requests.length).toBeGreaterThan(5);
    expect(new Set(traccar.requests)).toEqual(TRACCAR_READS);
    expect(traccar.requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });

  it('Wialon : uniquement les services de lecture (session, recherche, dernier état, messages, capteurs, déchargement, fin de session) ; données ingérées', async () => {
    wialon.services.length = 0;
    wialon.paths.length = 0;
    const vehicleId = await fullCycle({
      kind: 'WIALON',
      baseUrl: wialonUrl,
      settings: { odometerKind: 'COMPTEUR_CAN', registrationSource: 'profile:registration_plate', fuelSensors: [{ type: 'fuel level', kind: 'NIVEAU_SONDE' }] },
      token: RecordingWialon.TOKEN,
      unitExternalId: '16091323',
      fuelKinds: ['NIVEAU_SONDE'],
    });
    expect((await t.prisma.client.odometerReading.findMany({ where: { vehicleId, source: 'TELEMATICS' } })).map((r) => r.physicalKm?.toString())).toContain('24498.82');
    expect(await t.prisma.client.fuelLevelSample.count({ where: { vehicleId } })).toBeGreaterThan(0);
    expect(wialon.services.filter((s) => !WIALON_READS.has(s))).toEqual([]);
    expect(new Set(wialon.services)).toEqual(WIALON_READS);
    expect(new Set(wialon.paths)).toEqual(new Set(['POST /wialon/ajax.html']));
  });
});
