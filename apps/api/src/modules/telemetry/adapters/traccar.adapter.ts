import type { Decimal } from 'decimal.js';
import {
  type AdapterConfig,
  type AdapterDiagnostics,
  type FuelSample,
  type OdometerSample,
  ProviderError,
  type ProviderFuelKind,
  type ProviderHealth,
  type ProviderOdometerKind,
  type ProviderUnit,
  type TelemetryProvider,
} from '../telemetry-provider.interface.js';
import {
  DiagnosticsCollector,
  RequestPacer,
  SettingsReader,
  apiBaseUrl,
  byObservedAt,
  decimalFromJson,
  httpCall,
  isRecord,
  joinUrl,
  knotsToKmh,
  measure,
  metersToKm,
  parseIsoInstant,
  parseJson,
  runHealthCheck,
  splitCredential,
  timeChunks,
} from './adapter-support.js';

/**
 * Adaptateur Traccar (API REST officielle, openapi.yaml 6.15 ; CDC 14.3, D-292, D-294). Lecture seule :
 * GET /api/server, /api/devices, /api/positions ; aucune écriture chez le fournisseur.
 *  - Authentification : jeton Bearer (secret JETON_API) ou Basic (IDENTIFIANTS_API « email:motdepasse »).
 *  - Compteurs : attribut `odometer` (mètres, compteur du véhicule remonté par le boîtier) → COMPTEUR_CAN ;
 *    attribut `totalDistance` (mètres, distance cumulée calculée par le serveur) → DISTANCE_GPS. Les noms
 *    d'attributs sont paramétrables (un boîtier dont `odometer` est calculé par GPS se déclare ainsi).
 *  - Horodatage : fixTime (ou deviceTime selon settings.timeSource) ; une position sans horodatage
 *    exploitable est écartée et comptée. Traccar recopie le dernier fix connu (fixTime compris) sur une
 *    position reçue sans fix GPS, alors que ses attributs (odometer, fuel…) datent de deviceTime (constaté
 *    sur Traccar 6.15.3) : en mode fixTime, une position dont le fix précède deviceTime de plus de
 *    settings.staleFixToleranceSeconds est écartée et comptée plutôt que datée faussement.
 *  - sourceReference : identifiant de position Traccar, qualifié par la nature pour les compteurs
 *    (« pos:<id>:COMPTEUR_CAN ») car une position porte les deux natures.
 */

export const TRACCAR_PROVIDER = 'Traccar';

export type RegistrationSource = { kind: 'name' } | { kind: 'uniqueId' } | { kind: 'attribute'; key: string };

export interface TraccarSettings {
  registrationSource: RegistrationSource;
  timeSource: 'fixTime' | 'deviceTime';
  /** Écart maximal admis entre fixTime et un deviceTime postérieur (mode fixTime), en secondes. */
  staleFixToleranceSeconds: number;
  canOdometerAttribute: string | null;
  gpsDistanceAttribute: string | null;
  fuel: { attribute: string; unit: 'L' | '%'; kind: ProviderFuelKind } | null;
  ignitionAttribute: string;
  historyChunkHours: number;
  maxRequestsPerMinute: number | null;
  allowPlainHttp: boolean;
}

const FUEL_KINDS: readonly ProviderFuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];

/** null explicite : nature désactivée ; clé absente : nom d'attribut par défaut. */
function nullableAttribute(reader: SettingsReader, key: string, fallback: string): string | null {
  return reader.isExplicitNull(key) ? null : reader.string(key, fallback);
}

/** Paramètres Traccar validés (erreur CONFIGURATION explicite sinon) ; réutilisable à l'enregistrement. */
export function parseTraccarSettings(settings: Record<string, unknown>): TraccarSettings {
  const r = new SettingsReader(TRACCAR_PROVIDER, settings);
  const source = r.string('registrationSource', 'name');
  let registrationSource: RegistrationSource;
  if (source === 'name' || source === 'uniqueId') registrationSource = { kind: source };
  else if (source.startsWith('attribute:') && source.length > 'attribute:'.length) registrationSource = { kind: 'attribute', key: source.slice('attribute:'.length) };
  else throw new ProviderError('CONFIGURATION', `${TRACCAR_PROVIDER} : paramètre « registrationSource » doit valoir name, uniqueId ou attribute:<clé>.`);
  const fuelAttribute = r.optionalString('fuelAttribute');
  let fuel: TraccarSettings['fuel'] = null;
  if (fuelAttribute) {
    fuel = { attribute: fuelAttribute, unit: r.choice('fuelUnit', ['L', '%'] as const), kind: r.choice('fuelKind', FUEL_KINDS) };
  } else if (r.has('fuelUnit') || r.has('fuelKind')) {
    throw new ProviderError('CONFIGURATION', `${TRACCAR_PROVIDER} : fuelUnit et fuelKind exigent fuelAttribute.`);
  }
  const canOdometerAttribute = nullableAttribute(r, 'canOdometerAttribute', 'odometer');
  const gpsDistanceAttribute = nullableAttribute(r, 'gpsDistanceAttribute', 'totalDistance');
  if (canOdometerAttribute !== null && canOdometerAttribute === gpsDistanceAttribute) {
    throw new ProviderError('CONFIGURATION', `${TRACCAR_PROVIDER} : un même attribut ne peut pas être à la fois COMPTEUR_CAN et DISTANCE_GPS.`);
  }
  return {
    registrationSource,
    timeSource: r.choice('timeSource', ['fixTime', 'deviceTime'] as const, 'fixTime'),
    staleFixToleranceSeconds: r.integer('staleFixToleranceSeconds', 0, 86_400, 60) ?? 60,
    canOdometerAttribute,
    gpsDistanceAttribute,
    fuel,
    ignitionAttribute: r.string('ignitionAttribute', 'ignition'),
    historyChunkHours: r.integer('historyChunkHours', 1, 168, 24) ?? 24,
    maxRequestsPerMinute: r.integer('maxRequestsPerMinute', 1, 6000, null),
    allowPlainHttp: r.boolean('allowPlainHttp', false),
  };
}

export interface TraccarDevice {
  id: number;
  name: string;
  uniqueId: string;
  attributes: Record<string, unknown>;
}

export interface TraccarPosition {
  id: number;
  deviceId: number;
  valid: boolean;
  fixTime: unknown;
  deviceTime: unknown;
  speed: unknown;
  attributes: Record<string, unknown>;
}

export function asDevice(value: unknown): TraccarDevice | null {
  if (!isRecord(value) || typeof value['id'] !== 'number' || !Number.isSafeInteger(value['id'])) return null;
  return {
    id: value['id'],
    name: typeof value['name'] === 'string' ? value['name'] : '',
    uniqueId: typeof value['uniqueId'] === 'string' ? value['uniqueId'] : '',
    attributes: isRecord(value['attributes']) ? value['attributes'] : {},
  };
}

export function asPosition(value: unknown): TraccarPosition | null {
  if (!isRecord(value) || typeof value['id'] !== 'number' || typeof value['deviceId'] !== 'number') return null;
  return {
    id: value['id'],
    deviceId: value['deviceId'],
    valid: value['valid'] === true,
    fixTime: value['fixTime'],
    deviceTime: value['deviceTime'],
    speed: value['speed'],
    attributes: isRecord(value['attributes']) ? value['attributes'] : {},
  };
}

function declaredRegistration(device: TraccarDevice, source: RegistrationSource): string | null {
  let raw: unknown;
  if (source.kind === 'name') raw = device.name;
  else if (source.kind === 'uniqueId') raw = device.uniqueId;
  else raw = device.attributes[source.key];
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Unité normalisée ; natures constatées sur la dernière position connue. */
export function traccarUnit(device: TraccarDevice, latest: TraccarPosition | undefined, settings: TraccarSettings): ProviderUnit {
  const odometerKinds: ProviderOdometerKind[] = [];
  const fuelKinds: ProviderFuelKind[] = [];
  if (latest) {
    if (settings.canOdometerAttribute && decimalFromJson(latest.attributes[settings.canOdometerAttribute])) odometerKinds.push('COMPTEUR_CAN');
    if (settings.gpsDistanceAttribute && decimalFromJson(latest.attributes[settings.gpsDistanceAttribute])) odometerKinds.push('DISTANCE_GPS');
    if (settings.fuel && decimalFromJson(latest.attributes[settings.fuel.attribute])) fuelKinds.push(settings.fuel.kind);
  }
  return {
    externalId: String(device.id),
    label: device.name.trim() || device.uniqueId || String(device.id),
    declaredRegistration: declaredRegistration(device, settings.registrationSource),
    odometerKinds,
    fuelKinds,
  };
}

const UNDATED = 'position sans horodatage exploitable';
const STALE_FIX = 'position sans fix GPS récent (fixTime antérieur à deviceTime) : instant de mesure incertain';

/**
 * Instant de mesure d'une position, ou motif de rejet. En mode fixTime, un fix antérieur à deviceTime
 * au-delà de la tolérance signale un fix recopié par Traccar (position reçue sans fix GPS) : les
 * attributs ne datent pas de fixTime, l'échantillon est écarté.
 */
function observedAt(position: TraccarPosition, settings: TraccarSettings): Date | typeof UNDATED | typeof STALE_FIX {
  if (settings.timeSource === 'deviceTime') return parseIsoInstant(position.deviceTime) ?? UNDATED;
  const fix = parseIsoInstant(position.fixTime);
  if (!fix) return UNDATED;
  const device = parseIsoInstant(position.deviceTime);
  if (device && device.getTime() - fix.getTime() > settings.staleFixToleranceSeconds * 1000) return STALE_FIX;
  return fix;
}

/** Compteurs d'une position (0, 1 ou 2 natures) ; valeurs absentes omises, invalides comptées. */
export function traccarOdometerSamples(position: TraccarPosition, settings: TraccarSettings, diag: DiagnosticsCollector): OdometerSample[] {
  const candidates: Array<[ProviderOdometerKind, string]> = [];
  if (settings.canOdometerAttribute && settings.canOdometerAttribute in position.attributes) candidates.push(['COMPTEUR_CAN', settings.canOdometerAttribute]);
  if (settings.gpsDistanceAttribute && settings.gpsDistanceAttribute in position.attributes) candidates.push(['DISTANCE_GPS', settings.gpsDistanceAttribute]);
  if (candidates.length === 0) return [];
  const at = observedAt(position, settings);
  if (!(at instanceof Date)) {
    diag.reject(at, candidates.length);
    return [];
  }
  const samples: OdometerSample[] = [];
  for (const [kind, attribute] of candidates) {
    const meters = decimalFromJson(position.attributes[attribute]);
    const valueKm = meters ? metersToKm(meters) : null;
    if (valueKm === null) {
      diag.reject(`compteur ${kind} invalide`);
      continue;
    }
    samples.push({ unitExternalId: String(position.deviceId), kind, valueKm, observedAt: at, sourceReference: `pos:${position.id}:${kind}` });
  }
  return samples;
}

/** Échantillon carburant d'une position (attribut configuré), ou null s'il est absent. */
export function traccarFuelSample(position: TraccarPosition, settings: TraccarSettings, diag: DiagnosticsCollector): FuelSample | null {
  const fuel = settings.fuel;
  if (!fuel || !(fuel.attribute in position.attributes)) return null;
  const at = observedAt(position, settings);
  if (!(at instanceof Date)) {
    diag.reject(at);
    return null;
  }
  const raw = decimalFromJson(position.attributes[fuel.attribute]);
  const value = raw ? measure(raw, fuel.unit === 'L' ? 'litres' : 'pourcentage') : null;
  if (value === null) {
    diag.reject('niveau de carburant invalide');
    return null;
  }
  const ignition = position.attributes[settings.ignitionAttribute];
  const knots: Decimal | null = position.valid ? decimalFromJson(position.speed) : null;
  return {
    unitExternalId: String(position.deviceId),
    kind: fuel.kind,
    liters: fuel.unit === 'L' ? value : null,
    percent: fuel.unit === '%' ? value : null,
    engineOn: typeof ignition === 'boolean' ? ignition : null,
    speedKmh: knots && !knots.isNegative() ? knotsToKmh(knots) : null,
    observedAt: at,
    sourceReference: `pos:${position.id}`,
  };
}

/** Traccar renvoie 400 (trace Java) pour un appareil non autorisé ou un jeton mal formé. */
function classifyTraccarStatus(status: number, body: string): ProviderError | null {
  if (status !== 400) return null;
  if (body.includes('SecurityException')) return new ProviderError('AUTHENTIFICATION', `${TRACCAR_PROVIDER} : droits insuffisants du compte de lecture sur un appareil (HTTP 400).`);
  if (body.includes('TokenManager') || body.includes('CryptoManager')) return new ProviderError('AUTHENTIFICATION', `${TRACCAR_PROVIDER} : jeton API invalide (HTTP 400).`);
  return null;
}

export class TraccarAdapter implements TelemetryProvider {
  private readonly settings: TraccarSettings;
  private readonly base: URL;
  private readonly pacer: RequestPacer;
  private readonly diag = new DiagnosticsCollector();

  constructor(private readonly config: AdapterConfig) {
    this.settings = parseTraccarSettings(config.settings);
    const base = apiBaseUrl(TRACCAR_PROVIDER, config.baseUrl, this.settings.allowPlainHttp);
    // Une URL saisie avec le suffixe /api est acceptée telle quelle.
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    this.base = base;
    this.pacer = new RequestPacer(this.settings.maxRequestsPerMinute);
  }

  private authorization(): string {
    const token = this.config.secrets.JETON_API;
    if (token !== undefined) return `Bearer ${token}`;
    const { user, secret } = splitCredential(TRACCAR_PROVIDER, 'IDENTIFIANTS_API', this.config.secrets.IDENTIFIANTS_API);
    return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
  }

  private async get(path: string, query: Array<[string, string]> = [], authenticated = true): Promise<unknown> {
    const url = joinUrl(this.base, `/api${path}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    const headers: Record<string, string> = authenticated ? { Authorization: this.authorization() } : {};
    const response = await httpCall(TRACCAR_PROVIDER, { method: 'GET', url, headers }, { timeoutMs: this.config.timeoutMs, pacer: this.pacer, classify: classifyTraccarStatus });
    return parseJson(TRACCAR_PROVIDER, response.body);
  }

  private async list<T>(path: string, query: Array<[string, string]>, convert: (v: unknown) => T | null, what: string): Promise<T[]> {
    const body = await this.get(path, query);
    if (!Array.isArray(body)) throw new ProviderError('REPONSE_INVALIDE', `${TRACCAR_PROVIDER} : liste de ${what} attendue.`);
    const out: T[] = [];
    for (const item of body) {
      const converted = convert(item);
      if (converted) out.push(converted);
      else this.diag.reject(`${what} illisible`);
    }
    return out;
  }

  private async latestPositions(): Promise<Map<number, TraccarPosition>> {
    const positions = await this.list('/positions', [], asPosition, 'position');
    const byDevice = new Map<number, TraccarPosition>();
    for (const p of positions) byDevice.set(p.deviceId, p);
    return byDevice;
  }

  private async history(unitExternalIds: string[], from: Date, to: Date): Promise<TraccarPosition[]> {
    const seen = new Set<number>();
    const out: TraccarPosition[] = [];
    for (const deviceId of this.deviceIds(unitExternalIds)) {
      for (const chunk of timeChunks(from, to, this.settings.historyChunkHours)) {
        const positions = await this.list(
          '/positions',
          [
            ['deviceId', String(deviceId)],
            ['from', chunk.from.toISOString()],
            ['to', chunk.to.toISOString()],
          ],
          asPosition,
          'position',
        );
        for (const p of positions) {
          if (p.deviceId !== deviceId || seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
        }
      }
    }
    return out;
  }

  private deviceIds(unitExternalIds: string[]): number[] {
    const ids: number[] = [];
    for (const id of new Set(unitExternalIds)) {
      if (/^\d{1,15}$/.test(id)) ids.push(Number(id));
      else this.diag.reject('identifiant d’unité Traccar invalide');
    }
    return ids;
  }

  async listUnits(): Promise<ProviderUnit[]> {
    const devices = await this.list('/devices', [], asDevice, 'appareil');
    const latest = await this.latestPositions();
    return devices.map((d) => traccarUnit(d, latest.get(d.id), this.settings));
  }

  async getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]> {
    const wanted = new Set(this.deviceIds(unitExternalIds));
    if (wanted.size === 0) return [];
    const latest = await this.latestPositions();
    const samples: OdometerSample[] = [];
    for (const [deviceId, position] of latest) {
      if (wanted.has(deviceId)) samples.push(...traccarOdometerSamples(position, this.settings, this.diag));
    }
    return samples.sort(byObservedAt);
  }

  async getOdometerHistory(unitExternalIds: string[], from: Date, to: Date): Promise<OdometerSample[]> {
    const positions = await this.history(unitExternalIds, from, to);
    return positions.flatMap((p) => traccarOdometerSamples(p, this.settings, this.diag)).sort(byObservedAt);
  }

  async getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]> {
    if (!this.settings.fuel) return [];
    const positions = await this.history(unitExternalIds, from, to);
    const samples: FuelSample[] = [];
    for (const p of positions) {
      const sample = traccarFuelSample(p, this.settings, this.diag);
      if (sample) samples.push(sample);
    }
    return samples.sort(byObservedAt);
  }

  healthCheck(): Promise<ProviderHealth> {
    return runHealthCheck(this.config.clock, async () => {
      const server = await this.get('/server', [], false);
      const version = isRecord(server) && typeof server['version'] === 'string' ? server['version'] : null;
      // /api/server est public : l'authentification est vérifiée par une lecture minimale des appareils.
      const devices = await this.get('/devices', [['limit', '1']]);
      if (!Array.isArray(devices)) throw new ProviderError('REPONSE_INVALIDE', `${TRACCAR_PROVIDER} : liste d’appareils attendue.`);
      return `${TRACCAR_PROVIDER}${version ? ` ${version}` : ''} joignable ; compte de lecture authentifié.`;
    });
  }

  diagnostics(): AdapterDiagnostics {
    return this.diag.snapshot();
  }
}

export const createTraccarAdapter = (config: AdapterConfig): TelemetryProvider => new TraccarAdapter(config);
