import { Decimal } from 'decimal.js';
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
  kmToKm,
  measure,
  metersToKm,
  milesToKm,
  parseJson,
  runHealthCheck,
  timeChunks,
} from './adapter-support.js';

/**
 * Adaptateur Wialon Remote API (help.wialon.com/en/api ; CDC 14.3, D-292, D-294). Lecture seule.
 *  - Requêtes : POST <hôte>/wialon/ajax.html, corps application/x-www-form-urlencoded (svc, params JSON,
 *    sid) — page « Request format » (user-guide/api-reference/reqformat). Le jeton et la session ne
 *    figurent jamais dans l'URL.
 *  - Session : token/login (secret JETON_API) → eid ; erreur 1 (session invalide) → une seule
 *    reconnexion ; core/logout à la fermeture.
 *  - Unités : core/search_items (avl_unit) avec les drapeaux base (1), propriétés avancées (256 : uid),
 *    dernier message et position (1024), capteurs (4096), compteurs (8192), champs personnalisés (8) et
 *    champs de profil (8388608) — page « Data format / Units ».
 *  - Kilométrage : unit/calc_last (mileage.value, km ou miles selon le système de mesure de l'unité).
 *    Cette réponse ne porte pas d'horodatage : l'instant est celui du dernier message (lmsg.t) lu par
 *    core/search_items avant ET après calc_last ; si un message est arrivé entre les deux lectures,
 *    l'échantillon est écarté (repris au run suivant) plutôt que daté faussement. La nature
 *    (COMPTEUR_CAN ou DISTANCE_GPS) est obligatoire dans settings.odometerKind : Wialon calcule le
 *    compteur par GPS ou le lit sur un capteur selon son paramétrage (annexe A).
 *  - Carburant et historique : messages/load_interval (messages de données) puis unit/calc_sensors sur le
 *    chargeur de messages (valeurs calculées des capteurs, message par message, avec leur instant t) ;
 *    messages/unload ensuite. L'historique du kilométrage exige un capteur de kilométrage déclaré dans
 *    settings.mileageSensor ; sans lui, getOdometerHistory est absent (D-294).
 *  - Codes d'erreur : 1 session, 4 entrée invalide, 7 droits insuffisants, 8 identifiants refusés,
 *    5/6 erreur serveur, 1003 requête concurrente refusée.
 */

export const WIALON_PROVIDER = 'Wialon';

/** Drapeaux de données d'unité (décimal : l'API refuse l'hexadécimal). */
export const UNIT_FLAGS = {
  base: 1,
  customFields: 8,
  advanced: 256,
  lastMessage: 1024,
  sensors: 4096,
  counters: 8192,
  profile: 8388608,
} as const;
/** Messages de données uniquement (type 0x0000 sous le masque 0xFF00). */
const DATA_MESSAGES = { flags: 0, flagsMask: 65280 } as const;
const LOAD_ALL = 4294967295;
/** Valeur « inconnue » renvoyée par Wialon pour un capteur non calculable. */
const UNKNOWN_SENSOR_VALUE = -348201.3876;

export type WialonRegistrationSource = { kind: 'name' } | { kind: 'uid' } | { kind: 'profile'; field: string } | { kind: 'custom'; field: string };

export interface SensorSelector {
  type: string | null;
  name: string | null;
}

export interface WialonSettings {
  odometerKind: ProviderOdometerKind;
  registrationSource: WialonRegistrationSource;
  fuelSensors: Array<SensorSelector & { kind: ProviderFuelKind }>;
  engineSensor: SensorSelector | null;
  mileageSensor: SensorSelector | null;
  historyChunkHours: number;
  maxRequestsPerMinute: number | null;
  allowPlainHttp: boolean;
}

const FUEL_KINDS: readonly ProviderFuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];

function selector(r: SettingsReader): SensorSelector {
  const type = r.optionalString('type');
  const name = r.optionalString('name');
  if (!type && !name) throw new ProviderError('CONFIGURATION', `${WIALON_PROVIDER} : un capteur se désigne par son type (t) ou son nom (n).`);
  return { type, name };
}

/** Paramètres Wialon validés (erreur CONFIGURATION explicite sinon) ; réutilisable à l'enregistrement. */
export function parseWialonSettings(settings: Record<string, unknown>): WialonSettings {
  const r = new SettingsReader(WIALON_PROVIDER, settings);
  const source = r.string('registrationSource', 'name');
  let registrationSource: WialonRegistrationSource;
  if (source === 'name' || source === 'uid') registrationSource = { kind: source };
  else if (/^profile:.+/.test(source)) registrationSource = { kind: 'profile', field: source.slice('profile:'.length) };
  else if (/^custom:.+/.test(source)) registrationSource = { kind: 'custom', field: source.slice('custom:'.length) };
  else throw new ProviderError('CONFIGURATION', `${WIALON_PROVIDER} : paramètre « registrationSource » doit valoir name, uid, profile:<champ> ou custom:<champ>.`);
  const engine = r.isExplicitNull('engineSensor') ? null : r.object('engineSensor', false);
  const mileage = r.object('mileageSensor', false);
  return {
    odometerKind: r.choice('odometerKind', ['COMPTEUR_CAN', 'DISTANCE_GPS'] as const),
    registrationSource,
    fuelSensors: r.objectList('fuelSensors').map((f) => ({ ...selector(f), kind: f.choice('kind', FUEL_KINDS) })),
    engineSensor: r.isExplicitNull('engineSensor') ? null : engine ? selector(engine) : { type: 'engine operation', name: null },
    mileageSensor: mileage ? selector(mileage) : null,
    historyChunkHours: r.integer('historyChunkHours', 1, 168, 24) ?? 24,
    maxRequestsPerMinute: r.integer('maxRequestsPerMinute', 1, 6000, null),
    allowPlainHttp: r.boolean('allowPlainHttp', false),
  };
}

export interface WialonSensor {
  id: number;
  name: string;
  type: string;
  unit: string;
}

export interface WialonUnit {
  id: number;
  name: string;
  /** Système de mesure : 0 SI, 1 US, 2 impérial, 3 métrique avec gallons. */
  mu: number | null;
  uid: string | null;
  lastMessageAt: number | null;
  mileageCounter: number | null;
  sensors: WialonSensor[];
  profile: Record<string, string>;
  custom: Record<string, string>;
}

function fieldMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const field of Object.values(value)) {
    if (isRecord(field) && typeof field['n'] === 'string' && typeof field['v'] === 'string') out[field['n']] = field['v'];
  }
  return out;
}

/** Élément avl_unit de core/search_items → structure typée (null si illisible). */
export function asWialonUnit(value: unknown): WialonUnit | null {
  if (!isRecord(value) || typeof value['id'] !== 'number' || !Number.isSafeInteger(value['id'])) return null;
  const lmsg = isRecord(value['lmsg']) ? value['lmsg'] : null;
  const pos = isRecord(value['pos']) ? value['pos'] : null;
  const t = typeof lmsg?.['t'] === 'number' ? lmsg['t'] : typeof pos?.['t'] === 'number' ? pos['t'] : null;
  const sensors: WialonSensor[] = [];
  if (isRecord(value['sens'])) {
    for (const s of Object.values(value['sens'])) {
      if (isRecord(s) && typeof s['id'] === 'number') {
        sensors.push({ id: s['id'], name: typeof s['n'] === 'string' ? s['n'] : '', type: typeof s['t'] === 'string' ? s['t'] : '', unit: typeof s['m'] === 'string' ? s['m'] : '' });
      }
    }
  }
  return {
    id: value['id'],
    name: typeof value['nm'] === 'string' ? value['nm'] : '',
    mu: typeof value['mu'] === 'number' ? value['mu'] : null,
    uid: typeof value['uid'] === 'string' ? value['uid'] : null,
    lastMessageAt: t !== null && Number.isSafeInteger(t) && t > 0 ? t : null,
    mileageCounter: typeof value['cnm'] === 'number' ? value['cnm'] : null,
    sensors,
    profile: fieldMap(value['pflds']),
    custom: fieldMap(value['flds']),
  };
}

function matches(sensor: WialonSensor, wanted: SensorSelector): boolean {
  return (wanted.type === null || sensor.type.toLowerCase() === wanted.type.toLowerCase()) && (wanted.name === null || sensor.name === wanted.name);
}

/** Capteurs carburant de l'unité, un seul par nature (sinon ambiguïté comptée et nature ignorée). */
export function fuelSensorsOf(unit: WialonUnit, settings: WialonSettings, diag: DiagnosticsCollector): Array<{ sensor: WialonSensor; kind: ProviderFuelKind }> {
  const byKind = new Map<ProviderFuelKind, WialonSensor[]>();
  for (const wanted of settings.fuelSensors) {
    for (const s of unit.sensors.filter((x) => matches(x, wanted))) {
      const list = byKind.get(wanted.kind) ?? [];
      if (!list.some((x) => x.id === s.id)) list.push(s);
      byKind.set(wanted.kind, list);
    }
  }
  const out: Array<{ sensor: WialonSensor; kind: ProviderFuelKind }> = [];
  for (const [kind, list] of byKind) {
    if (list.length === 1 && list[0]) out.push({ sensor: list[0], kind });
    else diag.reject(`plusieurs capteurs carburant ${kind} sur une unité (préciser le nom)`);
  }
  return out;
}

function uniqueSensor(unit: WialonUnit, wanted: SensorSelector | null): WialonSensor | null {
  if (!wanted) return null;
  const found = unit.sensors.filter((s) => matches(s, wanted));
  return found.length === 1 ? (found[0] ?? null) : null;
}

export function wialonDeclaredRegistration(unit: WialonUnit, source: WialonRegistrationSource): string | null {
  const raw = source.kind === 'name' ? unit.name : source.kind === 'uid' ? unit.uid : source.kind === 'profile' ? unit.profile[source.field] : unit.custom[source.field];
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function wialonUnit(unit: WialonUnit, settings: WialonSettings, diag: DiagnosticsCollector): ProviderUnit {
  return {
    externalId: String(unit.id),
    label: unit.name.trim() || String(unit.id),
    declaredRegistration: wialonDeclaredRegistration(unit, settings.registrationSource),
    odometerKinds: unit.mileageCounter !== null && unit.mileageCounter > 0 ? [settings.odometerKind] : [],
    fuelKinds: fuelSensorsOf(unit, settings, diag).map((f) => f.kind),
  };
}

/** Unité de longueur d'un compteur : suffixe du format (« 24498.82 km ») sinon système de mesure. */
function lengthUnit(formatted: unknown, mu: number | null): 'km' | 'mi' | null {
  if (typeof formatted === 'string') {
    if (/\bkm\b|\bкм\b/i.test(formatted)) return 'km';
    if (/\bmi\b|\bmiles?\b/i.test(formatted)) return 'mi';
  }
  if (mu === 0 || mu === 3) return 'km';
  if (mu === 1 || mu === 2) return 'mi';
  return null;
}

/** Élément de unit/calc_last → kilomètres, ou null (compteur absent, unité ou valeur invalide). */
export function mileageFromCalcLast(entry: Record<string, unknown>, mu: number | null): string | null {
  const mileage = entry['mileage'];
  if (!isRecord(mileage)) return null;
  const value = decimalFromJson(mileage['value']);
  if (!value) return null;
  const format = isRecord(mileage['format']) ? mileage['format']['value'] : undefined;
  const unit = lengthUnit(format, mu);
  if (unit === null) return null;
  return unit === 'km' ? kmToKm(value) : milesToKm(value);
}

function sensorLengthToKm(value: Decimal, unit: string): string | null {
  const u = unit.trim().toLowerCase();
  if (u === 'km' || u === 'км') return kmToKm(value);
  if (u === 'mi' || u === 'mile' || u === 'miles') return milesToKm(value);
  if (u === 'm' || u === 'м') return metersToKm(value);
  return null;
}

function fuelUnit(unit: string): 'litres' | 'pourcentage' | null {
  const u = unit.trim().toLowerCase();
  if (['l', 'lt', 'ltr', 'litre', 'litres', 'liter', 'liters', 'л'].includes(u)) return 'litres';
  if (u === '%') return 'pourcentage';
  return null;
}

function sensorNumber(values: unknown, sensorId: number): Decimal | null {
  if (!isRecord(values)) return null;
  const raw = values[String(sensorId)];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === UNKNOWN_SENSOR_VALUE) return null;
  return new Decimal(raw);
}

interface LoadedMessage {
  t: number;
  speed: Decimal | null;
  sensors: unknown;
}

export class WialonAdapter implements TelemetryProvider {
  private readonly settings: WialonSettings;
  private readonly endpoint: URL;
  private readonly pacer: RequestPacer;
  private readonly diag = new DiagnosticsCollector();
  private sid: string | null = null;
  private messagesLoaded = false;
  readonly getOdometerHistory?: (unitExternalIds: string[], from: Date, to: Date) => Promise<OdometerSample[]>;

  constructor(private readonly config: AdapterConfig) {
    this.settings = parseWialonSettings(config.settings);
    this.endpoint = joinUrl(apiBaseUrl(WIALON_PROVIDER, config.baseUrl, this.settings.allowPlainHttp), '/wialon/ajax.html');
    this.pacer = new RequestPacer(this.settings.maxRequestsPerMinute);
    if (this.settings.mileageSensor) this.getOdometerHistory = (ids, from, to) => this.odometerHistory(ids, from, to);
  }

  private async post(svc: string, params: unknown, sid: string | null): Promise<unknown> {
    const form = new URLSearchParams({ svc, params: JSON.stringify(params) });
    if (sid) form.set('sid', sid);
    const response = await httpCall(
      WIALON_PROVIDER,
      { method: 'POST', url: this.endpoint, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'gzip' }, body: form.toString() },
      { timeoutMs: this.config.timeoutMs, pacer: this.pacer },
    );
    return parseJson(WIALON_PROVIDER, response.body);
  }

  private static errorCode(body: unknown): number | null {
    return isRecord(body) && typeof body['error'] === 'number' && body['error'] !== 0 ? body['error'] : null;
  }

  private async login(): Promise<string> {
    const token = this.config.secrets.JETON_API;
    if (token === undefined) throw new ProviderError('CONFIGURATION', `${WIALON_PROVIDER} : secret JETON_API non déposé.`);
    const body = await this.post('token/login', { token }, null);
    const code = WialonAdapter.errorCode(body);
    if (code !== null) throw new ProviderError('AUTHENTIFICATION', `${WIALON_PROVIDER} : jeton refusé (code ${code}).`);
    if (!isRecord(body) || typeof body['eid'] !== 'string' || body['eid'] === '') throw new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : session absente de la réponse token/login.`);
    this.sid = body['eid'];
    return body['eid'];
  }

  /** Appel authentifié ; une session expirée (code 1) déclenche une seule reconnexion. */
  private async call(svc: string, params: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sid = this.sid ?? (await this.login());
      const body = await this.post(svc, params, sid);
      const code = WialonAdapter.errorCode(body);
      if (code === null) return body;
      if (code === 1 && attempt === 0) {
        this.sid = null;
        this.messagesLoaded = false;
        continue;
      }
      throw WialonAdapter.mapError(svc, code);
    }
    throw new ProviderError('AUTHENTIFICATION', `${WIALON_PROVIDER} : session refusée après reconnexion (code 1).`);
  }

  static mapError(svc: string, code: number): ProviderError {
    switch (code) {
      case 1:
        return new ProviderError('AUTHENTIFICATION', `${WIALON_PROVIDER} : session invalide (code 1, ${svc}).`);
      case 7:
        return new ProviderError('AUTHENTIFICATION', `${WIALON_PROVIDER} : droits insuffisants du compte de lecture (code 7, ${svc}).`);
      case 8:
        return new ProviderError('AUTHENTIFICATION', `${WIALON_PROVIDER} : identifiants refusés (code 8, ${svc}).`);
      case 5:
      case 6:
        return new ProviderError('INJOIGNABLE', `${WIALON_PROVIDER} : erreur du serveur (code ${code}, ${svc}).`);
      case 1003:
        return new ProviderError('QUOTA', `${WIALON_PROVIDER} : requête concurrente refusée (code 1003, ${svc}).`);
      default:
        return new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : requête refusée (code ${code}, ${svc}).`);
    }
  }

  private async searchUnits(flags: number): Promise<WialonUnit[]> {
    const body = await this.call('core/search_items', {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name', propType: 'property', or_logic: false },
      force: 1,
      flags,
      from: 0,
      to: 0,
    });
    if (!isRecord(body) || !Array.isArray(body['items'])) throw new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : liste d’unités attendue (core/search_items).`);
    const units: WialonUnit[] = [];
    for (const item of body['items']) {
      const unit = asWialonUnit(item);
      if (unit) units.push(unit);
      else this.diag.reject('unité illisible');
    }
    return units;
  }

  private unitIds(unitExternalIds: string[]): Set<number> {
    const ids = new Set<number>();
    for (const id of unitExternalIds) {
      if (/^\d{1,15}$/.test(id)) ids.add(Number(id));
      else this.diag.reject('identifiant d’unité Wialon invalide');
    }
    return ids;
  }

  async listUnits(): Promise<ProviderUnit[]> {
    const f = UNIT_FLAGS;
    const units = await this.searchUnits(f.base | f.customFields | f.advanced | f.lastMessage | f.sensors | f.counters | f.profile);
    return units.map((u) => wialonUnit(u, this.settings, this.diag));
  }

  async getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]> {
    const ids = this.unitIds(unitExternalIds);
    if (ids.size === 0) return [];
    const snapshotFlags = UNIT_FLAGS.base | UNIT_FLAGS.lastMessage;
    const before = new Map((await this.searchUnits(snapshotFlags)).filter((u) => ids.has(u.id)).map((u) => [u.id, u]));
    this.diag.reject('unité absente ou non visible chez le fournisseur', ids.size - before.size);
    if (before.size === 0) return [];
    const calc = await this.call('unit/calc_last', { itemIds: [...before.keys()] });
    if (!Array.isArray(calc)) throw new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : tableau attendu (unit/calc_last).`);
    const after = new Map((await this.searchUnits(snapshotFlags)).map((u) => [u.id, u.lastMessageAt]));
    const samples: OdometerSample[] = [];
    for (const entry of calc) {
      if (!isRecord(entry) || typeof entry['i'] !== 'number') {
        this.diag.reject('élément calc_last illisible');
        continue;
      }
      const unit = before.get(entry['i']);
      if (!unit) continue;
      if (!isRecord(entry['mileage'])) continue;
      if (unit.lastMessageAt === null) {
        this.diag.reject('kilométrage sans horodatage de dernier message');
        continue;
      }
      if (after.get(unit.id) !== unit.lastMessageAt) {
        this.diag.reject('message reçu pendant la lecture (échantillon repris au run suivant)');
        continue;
      }
      const valueKm = mileageFromCalcLast(entry, unit.mu);
      if (valueKm === null) {
        this.diag.reject('kilométrage invalide ou unité de longueur inconnue');
        continue;
      }
      const t = unit.lastMessageAt;
      samples.push({ unitExternalId: String(unit.id), kind: this.settings.odometerKind, valueKm, observedAt: new Date(t * 1000), sourceReference: `msg:${t}:${this.settings.odometerKind}` });
    }
    return samples.sort(byObservedAt);
  }

  /** Messages de données de [from, to] avec les valeurs calculées des capteurs (chargeur de session). */
  private async messagesWithSensors(unitId: number, from: Date, to: Date): Promise<LoadedMessage[]> {
    const out: LoadedMessage[] = [];
    const seen = new Set<number>();
    for (const chunk of timeChunks(from, to, this.settings.historyChunkHours)) {
      const loaded = await this.call('messages/load_interval', {
        itemId: unitId,
        timeFrom: Math.floor(chunk.from.getTime() / 1000),
        timeTo: Math.floor(chunk.to.getTime() / 1000),
        flags: DATA_MESSAGES.flags,
        flagsMask: DATA_MESSAGES.flagsMask,
        loadCount: LOAD_ALL,
      });
      this.messagesLoaded = true;
      if (!isRecord(loaded) || typeof loaded['count'] !== 'number' || !Array.isArray(loaded['messages'])) {
        throw new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : messages attendus (messages/load_interval).`);
      }
      const messages = loaded['messages'];
      if (messages.length === 0) continue;
      const values = await this.call('unit/calc_sensors', { source: '', indexFrom: 0, indexTo: messages.length - 1, unitId, sensorId: 0 });
      if (!Array.isArray(values) || values.length !== messages.length) {
        throw new ProviderError('REPONSE_INVALIDE', `${WIALON_PROVIDER} : valeurs de capteurs non alignées sur les messages (unit/calc_sensors).`);
      }
      messages.forEach((message, index) => {
        const t = isRecord(message) ? message['t'] : undefined;
        if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0) {
          this.diag.reject('message sans horodatage');
          return;
        }
        if (seen.has(t)) return;
        seen.add(t);
        const pos = isRecord(message) && isRecord(message['pos']) ? message['pos'] : null;
        out.push({ t, speed: decimalFromJson(pos?.['s']), sensors: values[index] });
      });
    }
    return out;
  }

  /** Libère le chargeur de messages ; un échec est compté sans masquer l'erreur éventuelle du run. */
  private async unloadMessages(): Promise<void> {
    if (!this.messagesLoaded || !this.sid) return;
    try {
      await this.call('messages/unload', {});
      this.messagesLoaded = false;
    } catch {
      this.diag.reject('libération du chargeur de messages impossible');
    }
  }

  private async unitsWithSensors(unitExternalIds: string[]): Promise<WialonUnit[]> {
    const ids = this.unitIds(unitExternalIds);
    if (ids.size === 0) return [];
    return (await this.searchUnits(UNIT_FLAGS.base | UNIT_FLAGS.sensors)).filter((u) => ids.has(u.id));
  }

  private async odometerHistory(unitExternalIds: string[], from: Date, to: Date): Promise<OdometerSample[]> {
    const samples: OdometerSample[] = [];
    try {
      for (const unit of await this.unitsWithSensors(unitExternalIds)) {
        const sensor = uniqueSensor(unit, this.settings.mileageSensor);
        if (!sensor) {
          this.diag.reject('capteur de kilométrage absent ou ambigu (historique indisponible)');
          continue;
        }
        for (const m of await this.messagesWithSensors(unit.id, from, to)) {
          const value = sensorNumber(m.sensors, sensor.id);
          if (value === null) continue;
          const valueKm = sensorLengthToKm(value, sensor.unit);
          if (valueKm === null) {
            this.diag.reject('kilométrage de capteur invalide ou unité inconnue');
            continue;
          }
          samples.push({ unitExternalId: String(unit.id), kind: this.settings.odometerKind, valueKm, observedAt: new Date(m.t * 1000), sourceReference: `msg:${m.t}:${this.settings.odometerKind}` });
        }
      }
    } finally {
      await this.unloadMessages();
    }
    return samples.sort(byObservedAt);
  }

  async getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]> {
    if (this.settings.fuelSensors.length === 0) return [];
    const samples: FuelSample[] = [];
    try {
      for (const unit of await this.unitsWithSensors(unitExternalIds)) {
        const fuelSensors = fuelSensorsOf(unit, this.settings, this.diag).filter(({ sensor }) => {
          if (fuelUnit(sensor.unit)) return true;
          this.diag.reject('unité de capteur carburant non gérée');
          return false;
        });
        if (fuelSensors.length === 0) continue;
        const engine = uniqueSensor(unit, this.settings.engineSensor);
        const metricSpeed = unit.mu === 0 || unit.mu === 3;
        for (const m of await this.messagesWithSensors(unit.id, from, to)) {
          const engineValue = engine ? sensorNumber(m.sensors, engine.id) : null;
          const speed = metricSpeed && m.speed ? measure(m.speed, 'vitesse') : null;
          for (const { sensor, kind } of fuelSensors) {
            const raw = sensorNumber(m.sensors, sensor.id);
            if (raw === null) continue;
            const unitKind = fuelUnit(sensor.unit);
            const value = unitKind ? measure(raw, unitKind) : null;
            if (value === null) {
              this.diag.reject('niveau de carburant invalide');
              continue;
            }
            samples.push({
              unitExternalId: String(unit.id),
              kind,
              liters: unitKind === 'litres' ? value : null,
              percent: unitKind === 'pourcentage' ? value : null,
              engineOn: engineValue === null ? null : !engineValue.isZero(),
              speedKmh: speed,
              observedAt: new Date(m.t * 1000),
              sourceReference: `msg:${m.t}`,
            });
          }
        }
      }
    } finally {
      await this.unloadMessages();
    }
    return samples.sort(byObservedAt);
  }

  healthCheck(): Promise<ProviderHealth> {
    return runHealthCheck(this.config.clock, async () => {
      const units = await this.searchUnits(UNIT_FLAGS.base);
      return `${WIALON_PROVIDER} joignable ; session ouverte ; ${units.length} unité(s) visible(s) par le compte de lecture.`;
    });
  }

  diagnostics(): AdapterDiagnostics {
    return this.diag.snapshot();
  }

  /** Ferme la session (core/logout) ; un échec de fermeture est compté, la session expire côté Wialon. */
  async close(): Promise<void> {
    const sid = this.sid;
    if (!sid) return;
    this.sid = null;
    try {
      const body = await this.post('core/logout', {}, sid);
      if (WialonAdapter.errorCode(body) !== null) this.diag.reject('fermeture de session refusée');
    } catch {
      this.diag.reject('fermeture de session impossible');
    }
  }
}

export const createWialonAdapter = (config: AdapterConfig): TelemetryProvider => new WialonAdapter(config);
