import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrismaClient } from '@parc-auto/db';
import { gzipSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import SftpClient from 'ssh2-sftp-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/common/clock.js';
import { ReportGenericAdapter, sshHostKeyFingerprint } from '../../src/modules/telemetry/adapters/report-generic.adapter.js';
import { TraccarAdapter } from '../../src/modules/telemetry/adapters/traccar.adapter.js';
import { WialonAdapter } from '../../src/modules/telemetry/adapters/wialon.adapter.js';
import type { AdapterConfig, ReportLedger } from '../../src/modules/telemetry/telemetry-provider.interface.js';
import { createReportLedger } from '../../src/modules/telemetry/telemetry-report-ledger.js';

/**
 * Tests réseau des adaptateurs réels (D-292) — données fictives créées par le test, jamais de compte réel :
 *  - Traccar : vrai serveur Traccar 6.15 en conteneur ; appareils et utilisateur de lecture créés par
 *    l'API REST ; positions réelles envoyées par le protocole OsmAnd (HTTP, port 5055) ;
 *  - Wialon : serveur HTTP local reproduisant les formats de requêtes et de réponses de la documentation
 *    officielle (help.wialon.com/en/api) — aucun serveur Wialon réel n'est interrogé ;
 *  - RAPPORT : vrais serveurs IMAP (GreenMail 2.1.3) et SFTP (atmoz/sftp) en conteneurs.
 * Un conteneur qui ne démarre pas fait échouer le test (aucun saut silencieux). Noms de conteneurs
 * propres à l'exécution et ports hôte attribués par Docker (127.0.0.1) : deux exécutions simultanées
 * de la suite ne se gênent pas.
 */

const CLOCK = new FixedClock('2026-09-24T10:00:00.000Z');

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Suffixe propre à cette exécution : aucun conteneur d'une autre exécution n'est touché. */
const RUN_ID = randomBytes(4).toString('hex');

function startContainer(name: string, args: string[]): void {
  docker(['run', '-d', '--rm', '--name', name, ...args]);
}

/** Port hôte attribué par Docker à un port du conteneur (publication « 127.0.0.1::<port> »). */
function hostPort(name: string, containerPort: number): number {
  const line = docker(['port', name, `${containerPort}/tcp`]).split('\n')[0] ?? '';
  const port = Number(/:(\d+)$/.exec(line.trim())?.[1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Port hôte introuvable pour ${name}:${containerPort}`);
  return port;
}

/** Port local libre à l'instant du test (serveur ouvert puis fermé) : adresse injoignable garantie. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function stopContainer(name: string): void {
  try {
    docker(['stop', '-t', '2', name]);
  } catch {
    // Déjà arrêté.
  }
}

async function waitFor<T>(what: string, attempt: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} : non disponible après ${timeoutMs} ms${last instanceof Error ? ` (${last.message})` : ''}`);
}

function adapterConfig(overrides: Partial<AdapterConfig>): AdapterConfig {
  return { providerId: 'fournisseur-test', baseUrl: null, settings: {}, secrets: {}, timeoutMs: 10_000, timezone: 'Africa/Tunis', clock: CLOCK, ...overrides };
}

/** Registre en mémoire du test, même contrat que TelemetryReportFile (empreinte unique par fournisseur). */
class MemoryLedger implements ReportLedger {
  readonly files = new Map<string, { sourceName: string; rowCount: number }>();
  async isProcessed(sha256: string): Promise<boolean> {
    return this.files.has(sha256);
  }
  async markProcessed(file: { sourceName: string; sha256: string; rowCount: number }): Promise<void> {
    if (!this.files.has(file.sha256)) this.files.set(file.sha256, { sourceName: file.sourceName, rowCount: file.rowCount });
  }
}

function expectNoSecret(text: string, secrets: string[]): void {
  for (const s of secrets) expect(text).not.toContain(s);
}

// ---------------------------------------------------------------------------------------------------
// Traccar 6.15 réel
// ---------------------------------------------------------------------------------------------------

describe('Traccar réel (conteneur mirror.gcr.io/traccar/traccar:6.15)', () => {
  const NAME = `parc-traccar-test-${RUN_ID}`;
  let API = '';
  let OSMAND = '';
  const ADMIN = { email: 'admin@parc.test', password: `adm-${randomBytes(6).toString('hex')}` };
  const READER = { email: 'lecture@parc.test', password: `lec-${randomBytes(6).toString('hex')}` };
  let token = '';
  const ids = { truck: 0, van: 0, hidden: 0, nofix: 0 };
  const t0 = Math.floor(Date.now() / 1000) - 7200;

  const basic = (u: { email: string; password: string }) => `Basic ${Buffer.from(`${u.email}:${u.password}`).toString('base64')}`;
  async function rest(method: string, path: string, auth: string | null, body?: unknown, form?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth) headers['Authorization'] = auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(`${API}/api${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${method} ${path} : HTTP ${response.status}`);
    return response;
  }
  async function osmand(params: Record<string, string | number | boolean>): Promise<void> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
    const response = await fetch(`${OSMAND}/?${query.toString()}`, { method: 'POST' });
    if (response.status !== 200) throw new Error(`OsmAnd : HTTP ${response.status}`);
  }
  async function rawPositions(deviceId: number): Promise<Array<{ id: number; fixTime: string; attributes: Record<string, number> }>> {
    const from = new Date((t0 - 60) * 1000).toISOString();
    const to = new Date((t0 + 3600) * 1000).toISOString();
    const response = await rest('GET', `/positions?deviceId=${deviceId}&from=${from}&to=${to}`, basic(ADMIN));
    return (await response.json()) as Array<{ id: number; fixTime: string; attributes: Record<string, number> }>;
  }

  beforeAll(async () => {
    startContainer(NAME, ['-p', '127.0.0.1::8082', '-p', '127.0.0.1::5055', 'mirror.gcr.io/traccar/traccar:6.15']);
    API = `http://localhost:${hostPort(NAME, 8082)}`;
    OSMAND = `http://localhost:${hostPort(NAME, 5055)}`;
    await waitFor('Traccar /api/server', async () => ((await fetch(`${API}/api/server`)).ok ? true : null), 120_000);
    // Premier utilisateur d'un serveur neuf = administrateur ; puis appareils et compte de lecture dédié.
    await rest('POST', '/users', null, { name: 'Administrateur test', email: ADMIN.email, password: ADMIN.password });
    const device = async (name: string, uniqueId: string, plate: string) =>
      ((await (await rest('POST', '/devices', basic(ADMIN), { name, uniqueId, attributes: { immatriculation: plate } })).json()) as { id: number }).id;
    ids.truck = await device('Camion 17', 'parc-test-0017', '123 TU 4567');
    ids.van = await device('Fourgon 18', 'parc-test-0018', '45-TU-9876');
    ids.hidden = await device('Hors périmètre', 'parc-test-0099', '999 TU 9999');
    ids.nofix = await device('Porteur 20', 'parc-test-0020', '77 TU 2020');
    const reader = (await (await rest('POST', '/users', basic(ADMIN), { name: 'Lecture Parc Auto', email: READER.email, password: READER.password, readonly: true })).json()) as { id: number };
    for (const deviceId of [ids.truck, ids.van, ids.nofix]) await rest('POST', '/permissions', basic(ADMIN), { userId: reader.id, deviceId });
    const expiration = new Date(Date.now() + 86_400_000).toISOString();
    token = (await (await rest('POST', '/session/token', basic(READER), undefined, { expiration })).text()).trim();

    // Positions réelles (OsmAnd) : odometer en mètres et fuel/ignition en attributs, speed en nœuds.
    // Chaque position est attendue avant la suivante : Traccar cumule totalDistance depuis la position
    // précédente enregistrée, le résultat ne dépend donc pas du rythme d'écriture du serveur.
    const truckPositions = [
      { timestamp: t0, lat: 36.8065, lon: 10.1815, odometer: 80000000, fuel: 60, ignition: false, speed: 0 },
      { timestamp: t0 + 600, lat: 36.8165, lon: 10.1915, odometer: 80012345, fuel: 58.5, ignition: true, speed: 20 },
      { timestamp: t0 + 1200, lat: 36.8165, lon: 10.1915, odometer: 80012345, fuel: 33.5, ignition: false, speed: 0 },
    ];
    for (const [index, p] of truckPositions.entries()) {
      await osmand({ id: 'parc-test-0017', ...p });
      await waitFor('position enregistrée', async () => ((await rawPositions(ids.truck)).length === index + 1 ? true : null), 60_000);
    }
    await osmand({ id: 'parc-test-0018', timestamp: t0 + 300, lat: 36.9, lon: 10.2 });
    await osmand({ id: 'parc-test-0099', timestamp: t0 + 300, lat: 36.9, lon: 10.2, odometer: 5000 });
    await waitFor('positions enregistrées', async () => ((await rawPositions(ids.van)).length === 1 ? true : null), 60_000);
    // Boîtier sans fix GPS (parking couvert) : une position avec fix, puis une position sans lat/lon dix
    // minutes plus tard. Traccar recopie alors le dernier fix (fixTime compris) ; odometer est le nouveau.
    await osmand({ id: 'parc-test-0020', timestamp: t0 + 100, lat: 36.85, lon: 10.15, odometer: 5000000 });
    await waitFor('position avec fix', async () => ((await rawPositions(ids.nofix)).length === 1 ? true : null), 60_000);
    await osmand({ id: 'parc-test-0020', timestamp: t0 + 700, odometer: 5004000 });
    await waitFor('position sans fix', async () => ((await rawPositions(ids.nofix)).length === 2 ? true : null), 60_000);
  }, 180_000);

  afterAll(() => stopContainer(NAME));

  const settings = { registrationSource: 'attribute:immatriculation', fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' };
  const bearer = () => new TraccarAdapter(adapterConfig({ baseUrl: API, settings, secrets: { JETON_API: token } }));

  it('listUnits : appareils visibles du compte de lecture, immatriculation déclarée et natures constatées', async () => {
    const units = await bearer().listUnits();
    expect(units.sort((a, b) => a.externalId.localeCompare(b.externalId))).toEqual(
      [
        { externalId: String(ids.truck), label: 'Camion 17', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN', 'DISTANCE_GPS'], fuelKinds: ['NIVEAU_SONDE'] },
        { externalId: String(ids.van), label: 'Fourgon 18', declaredRegistration: '45-TU-9876', odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] },
        { externalId: String(ids.nofix), label: 'Porteur 20', declaredRegistration: '77 TU 2020', odometerKinds: ['COMPTEUR_CAN', 'DISTANCE_GPS'], fuelKinds: [] },
      ].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    );
  });

  it('getOdometers : dernier état en km, instant fixTime, référence = identifiant de position Traccar', async () => {
    const raw = await rawPositions(ids.truck);
    const last = raw[raw.length - 1] as (typeof raw)[number];
    const samples = await bearer().getOdometers([String(ids.truck), String(ids.van)]);
    const truck = samples.filter((s) => s.unitExternalId === String(ids.truck));
    expect(truck).toEqual([
      { unitExternalId: String(ids.truck), kind: 'COMPTEUR_CAN', valueKm: '80012.345', observedAt: new Date((t0 + 1200) * 1000), sourceReference: `pos:${last.id}:COMPTEUR_CAN` },
      {
        unitExternalId: String(ids.truck),
        kind: 'DISTANCE_GPS',
        // totalDistance calculé par Traccar (mètres) : même valeur que l'API brute, arrondie au mètre.
        valueKm: (Math.round(last.attributes['totalDistance'] as number) / 1000).toFixed(3),
        observedAt: new Date((t0 + 1200) * 1000),
        sourceReference: `pos:${last.id}:DISTANCE_GPS`,
      },
    ]);
    expect(Number(truck[1]?.valueKm)).toBeGreaterThan(1);
    expect(samples.filter((s) => s.unitExternalId === String(ids.van))).toEqual([
      expect.objectContaining({ kind: 'DISTANCE_GPS', valueKm: '0.000', observedAt: new Date((t0 + 300) * 1000) }),
    ]);
  });

  it('getOdometerHistory et getFuel : positions de la période, litres, moteur, vitesse nœuds → km/h', async () => {
    const adapter = bearer();
    const from = new Date((t0 - 60) * 1000);
    const to = new Date((t0 + 3600) * 1000);
    const history = await adapter.getOdometerHistory([String(ids.truck)], from, to);
    expect(history.filter((s) => s.kind === 'COMPTEUR_CAN').map((s) => [s.valueKm, s.observedAt.getTime() / 1000])).toEqual([
      ['80000.000', t0],
      ['80012.345', t0 + 600],
      ['80012.345', t0 + 1200],
    ]);
    expect(history.filter((s) => s.kind === 'DISTANCE_GPS')).toHaveLength(3);
    const fuel = await adapter.getFuel([String(ids.truck)], from, to);
    expect(fuel.map((f) => [f.kind, f.liters, f.percent, f.engineOn, f.speedKmh, f.observedAt.getTime() / 1000])).toEqual([
      ['NIVEAU_SONDE', '60.000', null, false, '0.000', t0],
      ['NIVEAU_SONDE', '58.500', null, true, '37.040', t0 + 600],
      ['NIVEAU_SONDE', '33.500', null, false, '0.000', t0 + 1200],
    ]);
    expect(adapter.diagnostics().rejected).toEqual({});
  });

  it('position reçue sans fix GPS : fix recopié par Traccar, échantillon écarté en mode fixTime, daté deviceTime sur demande', async () => {
    const raw = await rawPositions(ids.nofix);
    const stale = raw[1] as (typeof raw)[number];
    // Comportement réel du serveur : fixTime de la position précédente, odometer de la nouvelle mesure.
    expect(stale.fixTime).toBe(raw[0]?.fixTime);
    expect(stale.attributes['odometer']).toBe(5004000);
    const byFix = bearer();
    expect(await byFix.getOdometers([String(ids.nofix)])).toEqual([]);
    expect(byFix.diagnostics().rejected).toEqual({ 'position sans fix GPS récent (fixTime antérieur à deviceTime) : instant de mesure incertain': 2 });
    const byDevice = new TraccarAdapter(adapterConfig({ baseUrl: API, settings: { ...settings, timeSource: 'deviceTime' }, secrets: { JETON_API: token } }));
    expect(await byDevice.getOdometers([String(ids.nofix)])).toEqual([
      { unitExternalId: String(ids.nofix), kind: 'COMPTEUR_CAN', valueKm: '5004.000', observedAt: new Date((t0 + 700) * 1000), sourceReference: `pos:${stale.id}:COMPTEUR_CAN` },
      { unitExternalId: String(ids.nofix), kind: 'DISTANCE_GPS', valueKm: '0.000', observedAt: new Date((t0 + 700) * 1000), sourceReference: `pos:${stale.id}:DISTANCE_GPS` },
    ]);
  });

  it('authentification Basic (IDENTIFIANTS_API) et contrôle de santé', async () => {
    const adapter = new TraccarAdapter(adapterConfig({ baseUrl: `${API}/api`, settings, secrets: { IDENTIFIANTS_API: `${READER.email}:${READER.password}` } }));
    expect((await adapter.getOdometers([String(ids.truck)])).map((s) => s.kind)).toEqual(['COMPTEUR_CAN', 'DISTANCE_GPS']);
    const health = await adapter.healthCheck();
    expect(health).toMatchObject({ ok: true, checkedAt: CLOCK.now() });
    expect(health.message).toMatch(/^Traccar 6\.15/);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('erreurs typées : mot de passe ou jeton refusé, appareil hors droits, serveur injoignable ; aucun secret dans les messages', async () => {
    const wrong = `${READER.email}:mauvais-${randomBytes(4).toString('hex')}`;
    const denied = new TraccarAdapter(adapterConfig({ baseUrl: API, settings, secrets: { IDENTIFIANTS_API: wrong } }));
    const e1 = await denied.listUnits().catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: 'AUTHENTIFICATION' });
    const health = await denied.healthCheck();
    expect(health.ok).toBe(false);
    expectNoSecret(`${String(e1)} ${health.message}`, [wrong, READER.password]);

    // Un caractère réellement modifié (remplacer par « x » un « x » laisserait le jeton valide).
    const forged = `${token.slice(0, 10)}${token[10] === 'x' ? 'y' : 'x'}${token.slice(11)}`;
    expect(forged).not.toBe(token);
    const e2 = await new TraccarAdapter(adapterConfig({ baseUrl: API, settings, secrets: { JETON_API: forged } })).listUnits().catch((e: unknown) => e);
    expect(e2).toMatchObject({ kind: 'AUTHENTIFICATION' });
    expectNoSecret(String(e2), [forged, token]);

    const e3 = await bearer()
      .getOdometerHistory([String(ids.hidden)], new Date((t0 - 60) * 1000), new Date((t0 + 3600) * 1000))
      .catch((e: unknown) => e);
    expect(e3).toMatchObject({ kind: 'AUTHENTIFICATION' });

    const offline = new TraccarAdapter(adapterConfig({ baseUrl: `http://localhost:${await closedPort()}`, settings, secrets: { JETON_API: token }, timeoutMs: 2000 }));
    await expect(offline.getOdometers([String(ids.truck)])).rejects.toMatchObject({ kind: 'INJOIGNABLE' });
    const offlineHealth = await offline.healthCheck();
    expect(offlineHealth.ok).toBe(false);
    expectNoSecret(offlineHealth.message, [token]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Wialon Remote API : serveur local conforme aux exemples documentés
// ---------------------------------------------------------------------------------------------------

/**
 * Serveur HTTP de test qui applique les formats de la documentation officielle Wialon :
 *  - user-guide/api-reference/reqformat : POST /wialon/ajax.html, Content-Type
 *    application/x-www-form-urlencoded, paramètres svc, params (JSON), sid ;
 *  - user-guide/code-examples/login-and-logout : token/login → { host, eid, tm } (exemple
 *    « host: 212.98.173.107, eid: d1cb60897768780f846df7ab2400eb5f, tm: 1358415984 ») ; core/logout → {"error":0} ;
 *  - user-guide/error-codes : erreur = {"error": <code>} (1 session invalide, 4 entrée invalide, 7 accès refusé) ;
 *  - user-guide/api-reference/core/search_items : { searchSpec, dataFlags, totalItemsCount, indexFrom, indexTo, items } ;
 *  - user-guide/data-format/units : blocs par drapeau (1, 8, 256, 1024, 4096, 8192, 8388608) ;
 *  - user-guide/api-reference/unit/calc_last : [{ i, mileage{value, format{value}}, engine_hours, pos, sensors }] ;
 *  - user-guide/api-reference/messages/load_interval : { count, messages } ; erreur 1003 sans Accept-Encoding gzip ;
 *  - user-guide/data-format/messages et messages/get_messages : message { t, f, tp: "ud", pos{y,x,z,s,c,sc}, i, o, p } ;
 *  - user-guide/api-reference/unit/calc_sensors : [{ "<sensor_id>": valeur }, …] aligné sur le chargeur.
 */
class WialonDocServer {
  static readonly TOKEN = `jeton-wialon-fictif-${randomBytes(8).toString('hex')}`;
  readonly calls: string[] = [];
  readonly sessions = new Set<string>();
  expireSessionsOnce = false;
  denySvc: string | null = null;
  throttle = false;
  bumpDuringCalcLast = false;
  loggedOut = 0;
  private loader: { unitId: number; messages: Array<Record<string, unknown>> } | null = null;
  private server: Server | null = null;
  readonly T = 1790236800; // 2026-09-24T08:00:00Z
  readonly units = [
    {
      id: 16091323,
      nm: 'Camion 12',
      mu: 0,
      uid: '865000000000123',
      lmsgT: this.T,
      cnm: 24498,
      mileage: 24498.82,
      pflds: { '1': { id: 1, n: 'registration_plate', v: '123 TU 4567' } },
      sens: {
        '1': { id: 1, n: 'Réservoir', t: 'fuel level', d: '', m: 'l', p: 'can_fls', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
        '2': { id: 2, n: 'Contact', t: 'engine operation', d: '', m: 'On/Off', p: 'in1', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
        '3': { id: 3, n: 'Compteur CAN', t: 'mileage', d: '', m: 'km', p: 'can_mileage', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
      },
      messages: [
        { t: this.T - 600, s: 0, p: { can_fls: 412, in1: 0, can_mileage: 24498.3 }, sensors: { '1': 62.5, '2': 0, '3': 24498.3 } },
        { t: this.T - 300, s: 0, p: { can_fls: 250, in1: 0, can_mileage: 24498.3 }, sensors: { '1': 37.5, '2': 0, '3': 24498.3 } },
        { t: this.T, s: 25, p: { can_fls: 250, in1: 1, can_mileage: 24498.82 }, sensors: { '1': 37.5, '2': 1, '3': 24498.82 } },
      ],
    },
    { id: 16454260, nm: 'Utilitaire US', mu: 1, uid: '865000000000456', lmsgT: this.T - 60, cnm: 100, mileage: 100, pflds: {}, sens: {}, messages: [] },
  ];

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return `http://localhost:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private send(res: ServerResponse, body: unknown, gzip = false): void {
    const json = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (gzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(json));
    } else res.end(json);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/wialon/ajax.html') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const svc = form.get('svc') ?? '';
    this.calls.push(svc);
    if (this.throttle) {
      res.statusCode = 429;
      res.setHeader('Retry-After', '30');
      res.end();
      return;
    }
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(form.get('params') ?? '') as Record<string, unknown>;
    } catch {
      this.send(res, { error: 4 });
      return;
    }
    if (svc === 'token/login') {
      if (params['token'] !== WialonDocServer.TOKEN) return this.send(res, { error: 8 });
      const eid = randomBytes(16).toString('hex');
      this.sessions.add(eid);
      return this.send(res, { host: '212.98.173.107', eid, tm: 1358415984, user: { nm: 'lecture-parc', cls: 1, id: 648548, prp: {}, crt: 648548, bact: 648547, fl: 0, hm: '', uacl: 0 } });
    }
    const sid = form.get('sid') ?? '';
    if (this.expireSessionsOnce && svc !== 'core/logout') {
      this.expireSessionsOnce = false;
      this.sessions.clear();
    }
    if (!this.sessions.has(sid)) return this.send(res, { error: 1 });
    if (this.denySvc === svc) return this.send(res, { error: 7 });
    switch (svc) {
      case 'core/search_items':
        return this.send(res, this.searchItems(params));
      case 'unit/calc_last': {
        const ids = params['itemIds'];
        if (!Array.isArray(ids)) return this.send(res, { error: 4 });
        const out = this.units
          .filter((u) => ids.includes(u.id))
          .map((u) => ({
            i: u.id,
            mileage: { value: u.mileage, format: { value: `${u.mileage.toFixed(2)} ${u.mu === 0 ? 'km' : 'mi'}` } },
            engine_hours: { value: 0, format: { value: '0.00 h' } },
            pos: { y: 36.8065, x: 10.1815, c: 0, z: { value: 12, format: { value: '12.00 m' } }, s: { value: 0, format: { value: '0.00 km/h' } }, sc: 9 },
            sensors: {},
          }));
        if (this.bumpDuringCalcLast) {
          this.bumpDuringCalcLast = false;
          const first = this.units[0];
          if (first) first.lmsgT += 30;
        }
        return this.send(res, out);
      }
      case 'messages/load_interval': {
        if (!String(req.headers['accept-encoding'] ?? '').includes('gzip')) return this.send(res, { error: 1003 });
        const unit = this.units.find((u) => u.id === params['itemId']);
        const from = params['timeFrom'];
        const to = params['timeTo'];
        if (!unit || typeof from !== 'number' || typeof to !== 'number' || params['flagsMask'] !== 65280 || params['loadCount'] !== 4294967295) return this.send(res, { error: 4 });
        const messages = unit.messages
          .filter((m) => m.t >= from && m.t <= to)
          .map((m) => ({ t: m.t, f: 7, tp: 'ud', pos: { y: 36.8065, x: 10.1815, z: 12, s: m.s, c: 0, sc: 9 }, i: 0, o: 0, p: m.p, lc: 0, rt: m.t + 2 }));
        this.loader = { unitId: unit.id, messages: messages.map((m) => ({ ...m, sensors: unit.messages.find((x) => x.t === m.t)?.sensors })) };
        return this.send(res, { count: messages.length, messages }, true);
      }
      case 'unit/calc_sensors': {
        const loader = this.loader;
        if (!loader || params['source'] !== '' || params['unitId'] !== loader.unitId || params['indexFrom'] !== 0 || params['indexTo'] !== loader.messages.length - 1) return this.send(res, { error: 4 });
        return this.send(res, loader.messages.map((m) => m['sensors']));
      }
      case 'messages/unload':
        this.loader = null;
        return this.send(res, {});
      case 'core/logout':
        this.sessions.delete(sid);
        this.loggedOut += 1;
        return this.send(res, { error: 0 });
      default:
        return this.send(res, { error: 4 });
    }
  }

  private searchItems(params: Record<string, unknown>): unknown {
    const spec = params['spec'] as Record<string, unknown> | undefined;
    const flags = params['flags'];
    if (!spec || spec['itemsType'] !== 'avl_unit' || typeof flags !== 'number') return { error: 4 };
    const items = this.units.map((u) => {
      const item: Record<string, unknown> = {};
      if (flags & 1) Object.assign(item, { nm: u.nm, cls: 2, id: u.id, mu: u.mu, uacl: 19327369763 });
      if (flags & 8) Object.assign(item, { flds: {}, fldsmax: -1 });
      if (flags & 256) Object.assign(item, { uid: u.uid, uid2: '', hw: 1234, ph: '', ph2: '', psw: '' });
      if (flags & 1024) {
        Object.assign(item, {
          pos: { t: u.lmsgT, y: 36.8065, x: 10.1815, z: 12, s: 0, c: 0, sc: 9 },
          lmsg: { t: u.lmsgT, f: 7, tp: 'ud', pos: { y: 36.8065, x: 10.1815, z: 12, s: 0, c: 0, sc: 9 }, i: 0, o: 0, p: {} },
        });
      }
      if (flags & 4096) Object.assign(item, { sens: u.sens, sens_max: -1 });
      if (flags & 8192) Object.assign(item, { cfl: 1, cnm: u.cnm, cneh: 0, cnkb: 0 });
      if (flags & 8388608) Object.assign(item, { pflds: u.pflds });
      return item;
    });
    return { searchSpec: spec, dataFlags: flags, totalItemsCount: items.length, indexFrom: 0, indexTo: items.length - 1, items };
  }
}

describe('Wialon Remote API — serveur local conforme à la documentation (pas de serveur Wialon réel)', () => {
  const server = new WialonDocServer();
  let baseUrl = '';
  beforeAll(async () => {
    baseUrl = await server.start();
  });
  afterAll(() => server.stop());

  const settings = {
    odometerKind: 'COMPTEUR_CAN',
    registrationSource: 'profile:registration_plate',
    fuelSensors: [{ type: 'fuel level', kind: 'NIVEAU_SONDE' }],
    mileageSensor: { type: 'mileage' },
  };
  const adapter = (overrides: Partial<AdapterConfig> = {}) => new WialonAdapter(adapterConfig({ baseUrl, settings, secrets: { JETON_API: WialonDocServer.TOKEN }, ...overrides }));

  it('session par jeton, unités, kilométrage calc_last daté du dernier message, miles convertis, core/logout', async () => {
    const a = adapter();
    expect(await a.listUnits()).toEqual([
      { externalId: '16091323', label: 'Camion 12', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] },
      { externalId: '16454260', label: 'Utilitaire US', declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] },
    ]);
    expect(await a.getOdometers(['16091323', '16454260'])).toEqual([
      { unitExternalId: '16454260', kind: 'COMPTEUR_CAN', valueKm: '160.934', observedAt: new Date((server.T - 60) * 1000), sourceReference: `msg:${server.T - 60}:COMPTEUR_CAN` },
      { unitExternalId: '16091323', kind: 'COMPTEUR_CAN', valueKm: '24498.820', observedAt: new Date(server.T * 1000), sourceReference: `msg:${server.T}:COMPTEUR_CAN` },
    ]);
    expect((await a.healthCheck()).ok).toBe(true);
    await a.close();
    expect(server.loggedOut).toBe(1);
    expect(server.sessions.size).toBe(0);
  });

  it('carburant et historique : messages/load_interval (gzip) + unit/calc_sensors, messages/unload', async () => {
    const a = adapter();
    server.calls.length = 0;
    const from = new Date((server.T - 3600) * 1000);
    const to = new Date(server.T * 1000);
    expect(await a.getFuel(['16091323', '16454260'], from, to)).toEqual([
      { unitExternalId: '16091323', kind: 'NIVEAU_SONDE', liters: '62.500', percent: null, engineOn: false, speedKmh: '0.000', observedAt: new Date((server.T - 600) * 1000), sourceReference: `msg:${server.T - 600}` },
      { unitExternalId: '16091323', kind: 'NIVEAU_SONDE', liters: '37.500', percent: null, engineOn: false, speedKmh: '0.000', observedAt: new Date((server.T - 300) * 1000), sourceReference: `msg:${server.T - 300}` },
      { unitExternalId: '16091323', kind: 'NIVEAU_SONDE', liters: '37.500', percent: null, engineOn: true, speedKmh: '25.000', observedAt: new Date(server.T * 1000), sourceReference: `msg:${server.T}` },
    ]);
    expect(server.calls).toEqual(['token/login', 'core/search_items', 'messages/load_interval', 'unit/calc_sensors', 'messages/unload']);
    const history = await a.getOdometerHistory?.(['16091323'], from, to);
    expect(history?.map((s) => [s.valueKm, s.observedAt.getTime() / 1000])).toEqual([
      ['24498.300', server.T - 600],
      ['24498.300', server.T - 300],
      ['24498.820', server.T],
    ]);
    await a.close();
  });

  it('session expirée (code 1) : une seule reconnexion ; message reçu pendant la lecture : échantillon écarté', async () => {
    const a = adapter();
    await a.listUnits();
    server.expireSessionsOnce = true;
    server.calls.length = 0;
    expect(await a.getOdometers(['16454260'])).toHaveLength(1);
    expect(server.calls.slice(0, 3)).toEqual(['core/search_items', 'token/login', 'core/search_items']);
    server.bumpDuringCalcLast = true;
    expect((await a.getOdometers(['16091323'])).map((s) => s.unitExternalId)).toEqual([]);
    expect(a.diagnostics().rejected).toEqual({ 'message reçu pendant la lecture (échantillon repris au run suivant)': 1 });
    await a.close();
  });

  it('erreurs typées : jeton refusé, droits (7), quota HTTP 429 avec Retry-After, délai dépassé ; aucun secret exposé', async () => {
    const bad = adapter({ secrets: { JETON_API: 'jeton-invalide-000' } });
    const e1 = await bad.listUnits().catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: 'AUTHENTIFICATION' });
    expectNoSecret(String(e1), ['jeton-invalide-000']);

    const a = adapter();
    server.denySvc = 'unit/calc_last';
    await expect(a.getOdometers(['16091323'])).rejects.toMatchObject({ kind: 'AUTHENTIFICATION', message: expect.stringContaining('code 7') });
    server.denySvc = null;
    server.throttle = true;
    await expect(a.listUnits()).rejects.toMatchObject({ kind: 'QUOTA', retryAfterSeconds: 30 });
    server.throttle = false;
    await a.close();

    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    const slow = adapter({ baseUrl: `http://localhost:${port}`, timeoutMs: 500 });
    const e2 = await slow.listUnits().catch((e: unknown) => e);
    expect(e2).toMatchObject({ kind: 'INJOIGNABLE' });
    expectNoSecret(String(e2), [WialonDocServer.TOKEN]);
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------------------------------
// Canal RAPPORT : IMAP (GreenMail) et SFTP (atmoz/sftp) réels
// ---------------------------------------------------------------------------------------------------

const REPORT_COLUMNS = {
  unit: 'Unité',
  label: 'Nom',
  registration: 'Immatriculation',
  timestamp: 'Date',
  odometer: 'Compteur (km)',
  fuelLiters: 'Carburant (L)',
  engine: 'Moteur',
  speed: 'Vitesse',
  reference: 'N°',
};
const CSV = [
  'N°;Unité;Nom;Immatriculation;Date;Compteur (km);Carburant (L);Moteur;Vitesse',
  '5001;U-17;Camion 17;123 TU 4567;24/09/2026 08:15:00;80450,125;62,5;off;0',
  '5002;U-17;Camion 17;123 TU 4567;24/09/2026 08:35:00;80450,125;37,5;off;0',
  '5003;U-18;Fourgon 18;45-TU-9876;24/09/2026 08:40:00;12000;;on;12',
  '5004;U-18;Fourgon 18;45-TU-9876;31/09/2026 08:40:00;12001;;on;12',
].join('\r\n');

describe('Canal RAPPORT — IMAP réel (conteneur mirror.gcr.io/greenmail/standalone:2.1.3)', () => {
  const NAME = `parc-greenmail-test-${RUN_ID}`;
  const ports = { smtp: 0, imap: 0 };
  const PASSWORD = `imap-${randomBytes(6).toString('hex')}`;
  const settings = {
    source: 'IMAP',
    imap: { host: 'localhost', port: 0, tls: 'aucun', mailbox: 'INBOX', afterProcessing: 'deplacer', processedMailbox: 'Traites' },
    columns: REPORT_COLUMNS,
    timestampFormat: 'dd/MM/yyyy HH:mm:ss',
    decimalSeparator: ',',
    odometerUnit: 'km',
    odometerKind: 'COMPTEUR_CAN',
    fuelKind: 'NIVEAU_SONDE',
  };
  const ledger = new MemoryLedger();
  const make = (secret = `rapports:${PASSWORD}`) => new ReportGenericAdapter(adapterConfig({ settings, secrets: { IMAP: secret }, reportLedger: ledger }));
  let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
  const mail = (subject: string, attachments: Array<{ filename: string; content: Buffer }>) =>
    (transport as NonNullable<typeof transport>).sendMail({ from: 'plateforme-gps@fournisseur.test', to: 'rapports@parc.test', subject, text: 'Rapport planifié (données fictives).', attachments });

  async function inspect(): Promise<{ unseen: number; processed: number }> {
    const client = new ImapFlow({ host: 'localhost', port: ports.imap, secure: false, doSTARTTLS: false, auth: { user: 'rapports', pass: PASSWORD }, logger: false });
    await client.connect();
    try {
      const inbox = await client.status('INBOX', { unseen: true });
      const boxes = await client.list();
      const processed = boxes.some((b) => b.path === 'Traites') ? ((await client.status('Traites', { messages: true })).messages ?? 0) : 0;
      return { unseen: inbox.unseen ?? 0, processed };
    } finally {
      await client.logout();
    }
  }

  beforeAll(async () => {
    startContainer(NAME, [
      '-e',
      `GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=rapports:${PASSWORD}@parc.test`,
      '-p',
      '127.0.0.1::3025',
      '-p',
      '127.0.0.1::3143',
      'mirror.gcr.io/greenmail/standalone:2.1.3',
    ]);
    ports.smtp = hostPort(NAME, 3025);
    ports.imap = hostPort(NAME, 3143);
    settings.imap.port = ports.imap;
    transport = nodemailer.createTransport({ host: 'localhost', port: ports.smtp, secure: false, ignoreTLS: true });
    await waitFor('GreenMail IMAP', async () => (await inspect()) ?? null, 90_000);
  }, 120_000);

  afterAll(() => {
    transport?.close();
    stopContainer(NAME);
  });

  it('pièces jointes CSV des messages non lus : lues sans les marquer, puis registre SHA-256 et déplacement à l’acquittement', async () => {
    await mail('Rapport kilométrage 24/09', [{ filename: 'rapport-2026-09-24.csv', content: Buffer.from(CSV, 'utf8') }]);
    await mail('Rapport kilométrage 24/09 (renvoi)', [{ filename: 'rapport-2026-09-24-copie.csv', content: Buffer.from(CSV, 'utf8') }]);
    await mail('Message sans rapport', []);
    await waitFor('messages livrés', async () => ((await inspect()).unseen === 3 ? true : null), 30_000);

    const run = make();
    const units = await run.listUnits();
    expect(units.map((u) => [u.externalId, u.label, u.declaredRegistration])).toEqual([
      ['U-17', 'Camion 17', '123 TU 4567'],
      ['U-18', 'Fourgon 18', '45-TU-9876'],
    ]);
    expect(await run.getOdometers(['U-17', 'U-18'])).toEqual([
      { unitExternalId: 'U-17', kind: 'COMPTEUR_CAN', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:15:00Z'), sourceReference: '5001:COMPTEUR_CAN' },
      { unitExternalId: 'U-17', kind: 'COMPTEUR_CAN', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:35:00Z'), sourceReference: '5002:COMPTEUR_CAN' },
      { unitExternalId: 'U-18', kind: 'COMPTEUR_CAN', valueKm: '12000.000', observedAt: new Date('2026-09-24T07:40:00Z'), sourceReference: '5003:COMPTEUR_CAN' },
    ]);
    const fuel = await run.getFuel(['U-17'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    expect(fuel.map((f) => [f.liters, f.engineOn, f.observedAt.toISOString()])).toEqual([
      ['62.500', false, '2026-09-24T07:15:00.000Z'],
      ['37.500', false, '2026-09-24T07:35:00.000Z'],
    ]);
    expect(run.diagnostics()).toEqual({
      rejected: { 'horodatage invalide ou sans heure': 1, 'message sans pièce jointe CSV/XLSX': 1 },
      files: { read: 1, alreadyProcessed: 1, unreadable: 0, rows: 4 },
    });
    // Lecture en EXAMINE : rien n'est marqué lu avant l'acquittement.
    expect(await inspect()).toEqual({ unseen: 3, processed: 0 });

    await run.acknowledge();
    await run.close();
    expect([...ledger.files.values()]).toEqual([{ sourceName: expect.stringContaining('rapport-2026-09-24.csv'), rowCount: 4 }]);
    expect([...ledger.files.keys()]).toEqual([createHash('sha256').update(Buffer.from(CSV, 'utf8')).digest('hex')]);
    expect(await inspect()).toEqual({ unseen: 0, processed: 3 });

    // Même fichier reçu à nouveau : empreinte connue, aucun échantillon, message acquitté.
    await mail('Rapport kilométrage 24/09 (troisième envoi)', [{ filename: 'rapport.csv', content: Buffer.from(CSV, 'utf8') }]);
    await waitFor('message livré', async () => ((await inspect()).unseen === 1 ? true : null), 30_000);
    const again = make();
    expect(await again.getOdometers(['U-17', 'U-18'])).toEqual([]);
    expect(again.diagnostics().files).toEqual({ read: 0, alreadyProcessed: 1, unreadable: 0, rows: 0 });
    await again.acknowledge();
    await again.close();
    expect(await inspect()).toEqual({ unseen: 0, processed: 4 });
  });

  it('run sans acquittement : le fichier reste à traiter et est relu au run suivant', async () => {
    const other = CSV.replace('5001;', '6001;').replace('80450,125;62,5', '80460,000;61,0');
    await mail('Rapport kilométrage 25/09', [{ filename: 'rapport-2026-09-25.csv', content: Buffer.from(other, 'utf8') }]);
    await waitFor('message livré', async () => ((await inspect()).unseen === 1 ? true : null), 30_000);
    const failed = make();
    expect(await failed.getOdometers(['U-17'])).toHaveLength(2);
    await failed.close();
    const retry = make();
    expect((await retry.getOdometers(['U-17'])).map((s) => s.sourceReference)).toEqual(['6001:COMPTEUR_CAN', '5002:COMPTEUR_CAN']);
    await retry.acknowledge();
    await retry.close();
    expect(await inspect()).toEqual({ unseen: 0, processed: 5 });
  });

  it('contrôle de santé ; dossier absent : CONFIGURATION ; STARTTLS exigé mais non proposé : CONFIGURATION', async () => {
    const healthy = make();
    expect(await healthy.healthCheck()).toMatchObject({ ok: true, message: expect.stringContaining('boîte IMAP joignable') });
    await healthy.close();
    const missing = new ReportGenericAdapter(adapterConfig({ settings: { ...settings, imap: { ...settings.imap, mailbox: 'Inexistant' } }, secrets: { IMAP: `rapports:${PASSWORD}` }, reportLedger: ledger }));
    await expect(missing.listUnits()).rejects.toMatchObject({ kind: 'CONFIGURATION', message: expect.stringContaining('Inexistant') });
    await missing.close();
    const starttls = new ReportGenericAdapter(adapterConfig({ settings: { ...settings, imap: { ...settings.imap, tls: 'starttls' } }, secrets: { IMAP: `rapports:${PASSWORD}` }, reportLedger: ledger }));
    await expect(starttls.listUnits()).rejects.toMatchObject({ kind: 'CONFIGURATION' });
    await starttls.close();
  });

  it('mot de passe IMAP refusé : AUTHENTIFICATION, sans secret dans le message', async () => {
    const wrong = `rapports:faux-${randomBytes(4).toString('hex')}`;
    const run = make(wrong);
    const error = await run.listUnits().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'AUTHENTIFICATION' });
    expectNoSecret(String(error), [wrong.split(':')[1] as string, PASSWORD]);
    const health = await run.healthCheck();
    expect(health.ok).toBe(false);
    await run.close();
  });
});

describe('Canal RAPPORT — SFTP réel (conteneur mirror.gcr.io/atmoz/sftp:alpine)', () => {
  const NAME = `parc-sftp-test-${RUN_ID}`;
  const PASSWORD = `sftp-${randomBytes(6).toString('hex')}`;
  // Registre réel en base (TelemetryReportFile) : fournisseur fictif créé dans la base de test.
  const prisma = createPrismaClient({ databaseUrl: process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test', maxConnections: 2 });
  const provider = { id: '', organizationId: '' };
  let ledger: ReportLedger = new MemoryLedger();
  let port = 0;
  let fingerprint = '';
  let workbook: Buffer = Buffer.alloc(0);

  async function client(): Promise<SftpClient> {
    const c = new SftpClient('test', { error: () => undefined, end: () => undefined, close: () => undefined });
    await c.connect({ host: 'localhost', port, username: 'parc', password: PASSWORD, readyTimeout: 5000, retries: 0, hostVerifier: (key: Buffer) => ((fingerprint = sshHostKeyFingerprint(key)), true) });
    return c;
  }

  async function xlsx(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Données');
    sheet.addRow(['Unité', 'Date', 'Distance (m)', 'Carburant (%)', 'Moteur']);
    const rows: Array<[string, Date, number | string, number | string, string]> = [
      ['U-17', new Date(Date.UTC(2026, 8, 24, 8, 15, 0)), 80450125, 62.5, 'OFF'],
      ['U-17', new Date(Date.UTC(2026, 8, 24, 8, 30, 0)), 80450125, 41, 'OFF'],
      ['U-17', new Date(Date.UTC(2026, 8, 24, 9, 0, 0)), 'illisible', 40, 'ON'],
    ];
    for (const r of rows) sheet.addRow(r).getCell(2).numFmt = 'dd/mm/yyyy hh:mm';
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  const settings = () => ({
    source: 'SFTP',
    sftp: { host: 'localhost', port, directory: '/rapports', hostKeySha256: `SHA256:${fingerprint}` },
    columns: { unit: 'Unité', timestamp: 'Date', odometer: 'Distance (m)', fuelPercent: 'Carburant (%)', engine: 'Moteur' },
    timestampFormat: 'ISO',
    odometerUnit: 'm',
    odometerKind: 'DISTANCE_GPS',
    fuelKind: 'NIVEAU_CAN',
  });
  const make = (overrides: Partial<AdapterConfig> = {}) => new ReportGenericAdapter(adapterConfig({ settings: settings(), secrets: { SFTP: `parc:${PASSWORD}` }, reportLedger: ledger, ...overrides }));

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { code: `ORG-SFTP-${RUN_ID}`, name: 'Groupe test (adaptateurs)' } });
    const row = await prisma.telemetryProvider.create({ data: { organizationId: org.id, name: `Rapports SFTP ${RUN_ID}`, kind: 'RAPPORT_GENERIQUE', channel: 'RAPPORT' } });
    Object.assign(provider, { id: row.id, organizationId: org.id });
    ledger = createReportLedger(prisma, CLOCK, provider);
    startContainer(NAME, ['-p', '127.0.0.1::22', 'mirror.gcr.io/atmoz/sftp:alpine', `parc:${PASSWORD}:1001:100:rapports`]);
    port = hostPort(NAME, 22);
    const c = await waitFor('serveur SFTP', async () => await client(), 60_000);
    workbook = await xlsx();
    await c.put(workbook, '/rapports/rapport-2026-09-24.xlsx');
    await c.end();
    expect(fingerprint).toMatch(/^[A-Za-z0-9+/]{43}$/);
  }, 90_000);

  afterAll(async () => {
    stopContainer(NAME);
    await prisma.$disconnect();
  });

  it('fichier XLSX lu (heure murale du fuseau), valeurs invalides écartées, déplacé dans « traites » à l’acquittement', async () => {
    const run = make();
    expect(await run.listUnits()).toEqual([{ externalId: 'U-17', label: 'U-17', declaredRegistration: null, odometerKinds: ['DISTANCE_GPS'], fuelKinds: ['NIVEAU_CAN'] }]);
    expect(await run.getOdometers(['U-17'])).toEqual([
      { unitExternalId: 'U-17', kind: 'DISTANCE_GPS', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:15:00Z'), sourceReference: null },
      { unitExternalId: 'U-17', kind: 'DISTANCE_GPS', valueKm: '80450.125', observedAt: new Date('2026-09-24T07:30:00Z'), sourceReference: null },
    ]);
    const fuel = await run.getFuel(['U-17'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    expect(fuel.map((f) => [f.kind, f.percent, f.liters, f.engineOn, f.observedAt.toISOString()])).toEqual([
      ['NIVEAU_CAN', '62.500', null, false, '2026-09-24T07:15:00.000Z'],
      ['NIVEAU_CAN', '41.000', null, false, '2026-09-24T07:30:00.000Z'],
      ['NIVEAU_CAN', '40.000', null, true, '2026-09-24T08:00:00.000Z'],
    ]);
    expect(run.diagnostics()).toEqual({ rejected: { 'kilométrage invalide': 1 }, files: { read: 1, alreadyProcessed: 0, unreadable: 0, rows: 3 } });
    await run.acknowledge();
    await run.close();
    expect(await prisma.telemetryReportFile.findMany({ where: { providerId: provider.id }, select: { sourceName: true, sha256: true, rowCount: true, processedAt: true } })).toEqual([
      { sourceName: 'SFTP /rapports/rapport-2026-09-24.xlsx', sha256: createHash('sha256').update(workbook).digest('hex'), rowCount: 3, processedAt: CLOCK.now() },
    ]);

    const c = await client();
    try {
      expect((await c.list('/rapports')).map((f) => f.name).sort()).toEqual(['traites']);
      expect((await c.list('/rapports/traites')).map((f) => f.name)).toEqual(['rapport-2026-09-24.xlsx']);
    } finally {
      await c.end();
    }
    const next = make();
    expect(await next.getOdometers(['U-17'])).toEqual([]);
    expect(next.diagnostics().files).toEqual({ read: 0, alreadyProcessed: 0, unreadable: 0, rows: 0 });
    await next.close();
  });

  it('empreinte de clé d’hôte différente : CONFIGURATION ; mot de passe refusé : AUTHENTIFICATION ; aucun secret exposé', async () => {
    const wrongKey = new ReportGenericAdapter(
      adapterConfig({ settings: { ...settings(), sftp: { ...settings().sftp, hostKeySha256: `SHA256:${'B'.repeat(43)}` } }, secrets: { SFTP: `parc:${PASSWORD}` }, reportLedger: ledger }),
    );
    const e1 = await wrongKey.listUnits().catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: 'CONFIGURATION' });
    await wrongKey.close();
    const wrong = `faux-${randomBytes(4).toString('hex')}`;
    const denied = make({ secrets: { SFTP: `parc:${wrong}` } });
    const e2 = await denied.listUnits().catch((e: unknown) => e);
    expect(e2).toMatchObject({ kind: 'AUTHENTIFICATION' });
    expectNoSecret(`${String(e1)} ${String(e2)}`, [wrong, PASSWORD]);
    await denied.close();
    const healthy = make();
    const health = await healthy.healthCheck();
    await healthy.close();
    expect(health).toMatchObject({ ok: true, message: expect.stringContaining('répertoire SFTP joignable') });
  });
});
