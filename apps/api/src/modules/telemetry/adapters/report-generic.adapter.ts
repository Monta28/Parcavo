import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { ImapFlow } from 'imapflow';
import { DateTime, IANAZone } from 'luxon';
import { simpleParser } from 'mailparser';
import SftpClient from 'ssh2-sftp-client';
import { BusinessRuleError } from '../../../common/errors.js';
import { type Table, readTable } from '../../imports/parsers/tabular.js';
import { type Cell, cellText } from '../../imports/parsers/values.js';
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
  type ReportLedger,
  type TelemetryProvider,
} from '../telemetry-provider.interface.js';
import { DiagnosticsCollector, SettingsReader, byObservedAt, kmToKm, measure, metersToKm, networkError, runHealthCheck, splitCredential } from './adapter-support.js';

/**
 * Canal RAPPORT générique (CDC 14.3 canal 2 ; D-184, D-292, D-294) : rapports planifiés CSV/XLSX du
 * fournisseur déposés dans une boîte e-mail dédiée (IMAP) ou un répertoire SFTP.
 *  - IMAP : pièces jointes .csv/.xlsx des messages non lus du dossier configuré, lus en lecture seule
 *    (EXAMINE) ; après acquittement, les messages sont marqués lus ou déplacés.
 *  - SFTP : fichiers .csv/.xlsx du répertoire configuré ; après acquittement, déplacés dans le
 *    sous-dossier des fichiers traités (ou laissés en place : l'empreinte suffit alors).
 *  - Idempotence : SHA-256 de chaque fichier via config.reportLedger ; un fichier connu n'est pas relu.
 *  - Lecture : lecteur unique CSV/XLSX des imports (imports/parsers/tabular.ts) et mappage des colonnes
 *    dans settings.columns. Une valeur invalide est écartée et comptée, jamais remplacée.
 *  - Le lot est le contenu des fichiers nouveaux : getOdometers renvoie tous leurs relevés, triés par
 *    instant ; il n'existe pas d'historique rejouable (getOdometerHistory absent, D-294).
 */

export const REPORT_PROVIDER = 'Rapport générique';

export interface ReportColumns {
  unit: string;
  label: string | null;
  registration: string | null;
  timestamp: string;
  odometer: string | null;
  fuelLiters: string | null;
  fuelPercent: string | null;
  engine: string | null;
  speed: string | null;
  reference: string | null;
}

export interface ImapSourceSettings {
  host: string;
  port: number;
  tls: 'implicite' | 'starttls' | 'aucun';
  mailbox: string;
  processedMailbox: string | null;
  maxMessages: number;
  maxMessageBytes: number;
}

export interface SftpSourceSettings {
  host: string;
  port: number;
  directory: string;
  processedDirectory: string | null;
  hostKeySha256: string;
  maxFiles: number;
}

export interface ReportSettings {
  source: 'IMAP' | 'SFTP';
  imap: ImapSourceSettings | null;
  sftp: SftpSourceSettings | null;
  columns: ReportColumns;
  /** ISO | EPOCH_S | EPOCH_MS | format Luxon (ex. « dd/MM/yyyy HH:mm:ss »). */
  timestampFormat: string;
  timezone: string | null;
  decimalSeparator: '.' | ',';
  odometerUnit: 'km' | 'm' | null;
  odometerKind: ProviderOdometerKind | null;
  fuelKind: ProviderFuelKind | null;
  engineOnValues: string[];
  engineOffValues: string[];
  maxRowsPerFile: number;
  maxFileBytes: number;
}

const FUEL_KINDS: readonly ProviderFuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const REPORT_FILE = /\.(csv|xlsx)$/i;

function fail(message: string): never {
  throw new ProviderError('CONFIGURATION', `${REPORT_PROVIDER} : ${message}`);
}

/** Paramètres du canal RAPPORT validés (erreur CONFIGURATION explicite sinon). */
export function parseReportSettings(settings: Record<string, unknown>): ReportSettings {
  const r = new SettingsReader(REPORT_PROVIDER, settings);
  const source = r.choice('source', ['IMAP', 'SFTP'] as const);
  let imap: ImapSourceSettings | null = null;
  let sftp: SftpSourceSettings | null = null;
  if (source === 'IMAP') {
    const i = r.object('imap', true) as SettingsReader;
    const tls = i.choice('tls', ['implicite', 'starttls', 'aucun'] as const, 'implicite');
    const host = i.string('host');
    if (tls === 'aucun' && !LOOPBACK.has(host) && !i.boolean('allowUnencrypted', false)) {
      fail('IMAP sans chiffrement refusé pour un hôte distant (tls « implicite » ou « starttls », ou imap.allowUnencrypted pour un serveur interne).');
    }
    const after = i.choice('afterProcessing', ['marquer_lu', 'deplacer'] as const, 'marquer_lu');
    const processedMailbox = after === 'deplacer' ? i.string('processedMailbox') : null;
    imap = {
      host,
      port: i.integer('port', 1, 65535, tls === 'implicite' ? 993 : 143) ?? 993,
      tls,
      mailbox: i.string('mailbox', 'INBOX'),
      processedMailbox,
      maxMessages: i.integer('maxMessages', 1, 500, 50) ?? 50,
      maxMessageBytes: (i.integer('maxMessageMegabytes', 1, 100, 25) ?? 25) * 1024 * 1024,
    };
    if (processedMailbox === imap.mailbox) fail('imap.processedMailbox doit différer du dossier lu.');
  } else {
    const s = r.object('sftp', true) as SettingsReader;
    const directory = s.string('directory').replace(/\/+$/, '') || '/';
    const after = s.choice('afterProcessing', ['deplacer', 'laisser'] as const, 'deplacer');
    const processedDirectory = after === 'deplacer' ? s.string('processedDirectory', `${directory === '/' ? '' : directory}/traites`).replace(/\/+$/, '') : null;
    const fingerprint = s.string('hostKeySha256').replace(/^SHA256:/, '').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]{43}$/.test(fingerprint)) fail('sftp.hostKeySha256 doit être l’empreinte SHA256 de la clé d’hôte (format OpenSSH « SHA256:… »).');
    sftp = {
      host: s.string('host'),
      port: s.integer('port', 1, 65535, 22) ?? 22,
      directory,
      processedDirectory,
      hostKeySha256: fingerprint,
      maxFiles: s.integer('maxFiles', 1, 1000, 100) ?? 100,
    };
    if (processedDirectory === directory) fail('sftp.processedDirectory doit différer du répertoire lu.');
  }
  const c = r.object('columns', true) as SettingsReader;
  const columns: ReportColumns = {
    unit: c.string('unit'),
    label: c.optionalString('label'),
    registration: c.optionalString('registration'),
    timestamp: c.string('timestamp'),
    odometer: c.optionalString('odometer'),
    fuelLiters: c.optionalString('fuelLiters'),
    fuelPercent: c.optionalString('fuelPercent'),
    engine: c.optionalString('engine'),
    speed: c.optionalString('speed'),
    reference: c.optionalString('reference'),
  };
  if (!columns.odometer && !columns.fuelLiters && !columns.fuelPercent) fail('au moins une colonne de mesure (odometer, fuelLiters ou fuelPercent) est requise.');
  const timestampFormat = r.string('timestampFormat');
  if (!['ISO', 'EPOCH_S', 'EPOCH_MS'].includes(timestampFormat) && !/[Hh]/.test(timestampFormat)) {
    fail('timestampFormat doit contenir l’heure (jeton H ou h) : une date seule ne date pas une mesure.');
  }
  const timezone = r.optionalString('timezone');
  if (timezone && !IANAZone.isValidZone(timezone)) fail(`fuseau horaire inconnu « ${timezone} ».`);
  const odometerUnit = columns.odometer ? r.choice('odometerUnit', ['km', 'm'] as const) : null;
  const odometerKind = columns.odometer ? r.choice('odometerKind', ['COMPTEUR_CAN', 'DISTANCE_GPS'] as const) : null;
  const fuelKind = columns.fuelLiters || columns.fuelPercent ? r.choice('fuelKind', FUEL_KINDS) : null;
  return {
    source,
    imap,
    sftp,
    columns,
    timestampFormat,
    timezone,
    decimalSeparator: r.choice('decimalSeparator', ['.', ','] as const, '.'),
    odometerUnit,
    odometerKind,
    fuelKind,
    engineOnValues: r.stringList('engineOnValues', ['1', 'oui', 'on', 'true', 'vrai', 'marche', 'allumé']).map((v) => v.toLowerCase()),
    engineOffValues: r.stringList('engineOffValues', ['0', 'non', 'off', 'false', 'faux', 'arrêt', 'arret', 'éteint']).map((v) => v.toLowerCase()),
    maxRowsPerFile: r.integer('maxRowsPerFile', 1, 1_000_000, 200_000) ?? 200_000,
    maxFileBytes: (r.integer('maxFileMegabytes', 1, 100, 20) ?? 20) * 1024 * 1024,
  };
}

export interface ParsedReport {
  odometer: OdometerSample[];
  fuel: FuelSample[];
  units: Map<string, ProviderUnit>;
  rows: number;
}

type ColumnIndex = Record<keyof ReportColumns, number | null>;

function resolveColumns(headers: string[], columns: ReportColumns): ColumnIndex | string {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const index = {} as ColumnIndex;
  for (const key of Object.keys(columns) as Array<keyof ReportColumns>) {
    const wanted = columns[key];
    if (wanted === null) {
      index[key] = null;
      continue;
    }
    const at = normalized.indexOf(wanted.trim().toLowerCase());
    if (at < 0) return `colonne absente « ${wanted} »`;
    index[key] = at;
  }
  return index;
}

/** Nombre décimal strict (séparateur configuré ; point toujours admis pour une cellule numérique XLSX). */
export function parseReportDecimal(cell: Cell, separator: '.' | ',', xlsx: boolean): Decimal | 'vide' | null {
  const s = cellText(cell);
  if (s === '') return 'vide';
  const dot = /^\d+(\.\d+)?$/.test(s);
  const comma = /^\d+(,\d+)?$/.test(s);
  if ((separator === '.' || xlsx) && dot) return new Decimal(s);
  if (separator === ',' && comma) return new Decimal(s.replace(',', '.'));
  return null;
}

/** Instant d'une cellule selon le format configuré ; null si invalide, sans heure ou inexistant (DST). */
export function parseReportTimestamp(cell: Cell, format: string, zone: string): Date | null {
  if (cell !== null && typeof cell === 'object') {
    if (!cell.time) return null;
    const dt = DateTime.fromISO(`${cell.date}T${cell.time}`, { zone });
    return dt.isValid && dt.toFormat("HH:mm:ss.SSS") === cell.time ? dt.toUTC().toJSDate() : null;
  }
  const s = cellText(cell);
  if (s === '') return null;
  if (format === 'EPOCH_S' || format === 'EPOCH_MS') {
    if (!/^\d{1,15}$/.test(s)) return null;
    const ms = format === 'EPOCH_S' ? Number(s) * 1000 : Number(s);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) || ms <= 0 ? null : date;
  }
  if (format === 'ISO') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
    const dt = DateTime.fromISO(s, { zone, setZone: true });
    if (!dt.isValid) return null;
    // Heure locale inexistante (passage à l'heure d'été) : Luxon la décale, on la refuse.
    const hasOffset = /(Z|[+-]\d{2}(:?\d{2})?)$/.test(s);
    if (!hasOffset && dt.toFormat("yyyy-MM-dd'T'HH:mm") !== s.slice(0, 16)) return null;
    return dt.toUTC().toJSDate();
  }
  const dt = DateTime.fromFormat(s, format, { zone, setZone: true });
  if (!dt.isValid || dt.toFormat(format) !== s) return null;
  return dt.toUTC().toJSDate();
}

/**
 * Lignes d'un rapport → échantillons normalisés. Ligne sans unité ou sans horodatage valide : écartée ;
 * valeur de mesure invalide : écartée seule ; cellule vide : mesure absente (ni erreur ni zéro).
 */
export function parseReportTable(table: Table, fileName: string, settings: ReportSettings, zone: string, diag: DiagnosticsCollector): ParsedReport | string {
  const col = resolveColumns(table.headers, settings.columns);
  if (typeof col === 'string') return col;
  const xlsx = fileName.toLowerCase().endsWith('.xlsx');
  const at = (cells: Cell[], key: keyof ReportColumns): Cell => {
    const i = col[key];
    return i === null ? null : (cells[i] ?? null);
  };
  const result: ParsedReport = { odometer: [], fuel: [], units: new Map(), rows: table.rows.length };
  for (const row of table.rows) {
    const unitId = cellText(at(row.cells, 'unit'));
    if (unitId === '') {
      diag.reject('ligne sans identifiant d’unité');
      continue;
    }
    const observedAt = parseReportTimestamp(at(row.cells, 'timestamp'), settings.timestampFormat, zone);
    if (!observedAt) {
      diag.reject('horodatage invalide ou sans heure');
      continue;
    }
    const unit = result.units.get(unitId) ?? {
      externalId: unitId,
      label: unitId,
      declaredRegistration: null,
      odometerKinds: [],
      fuelKinds: [],
    };
    const label = cellText(at(row.cells, 'label'));
    if (label) unit.label = label;
    const registration = cellText(at(row.cells, 'registration'));
    if (registration) unit.declaredRegistration = registration;
    result.units.set(unitId, unit);
    const reference = cellText(at(row.cells, 'reference')) || null;

    if (settings.odometerKind && settings.odometerUnit) {
      const raw = parseReportDecimal(at(row.cells, 'odometer'), settings.decimalSeparator, xlsx);
      if (raw !== 'vide') {
        const valueKm = raw === null ? null : settings.odometerUnit === 'm' ? metersToKm(raw) : kmToKm(raw);
        if (valueKm === null) diag.reject('kilométrage invalide');
        else {
          const kind = settings.odometerKind;
          result.odometer.push({ unitExternalId: unitId, kind, valueKm, observedAt, sourceReference: reference ? `${reference}:${kind}` : null });
          if (!unit.odometerKinds.includes(kind)) unit.odometerKinds.push(kind);
        }
      }
    }

    if (settings.fuelKind) {
      const read = (key: 'fuelLiters' | 'fuelPercent', kind: 'litres' | 'pourcentage', label: string): string | null => {
        if (settings.columns[key] === null) return null;
        const raw = parseReportDecimal(at(row.cells, key), settings.decimalSeparator, xlsx);
        if (raw === 'vide') return null;
        const value = raw === null ? null : measure(raw, kind);
        if (value === null) diag.reject(label);
        return value;
      };
      const liters = read('fuelLiters', 'litres', 'carburant (L) invalide');
      const percent = read('fuelPercent', 'pourcentage', 'carburant (%) invalide');
      if (liters !== null || percent !== null) {
        let engineOn: boolean | null = null;
        const engineText = cellText(at(row.cells, 'engine')).toLowerCase();
        if (engineText !== '') {
          if (settings.engineOnValues.includes(engineText)) engineOn = true;
          else if (settings.engineOffValues.includes(engineText)) engineOn = false;
          else diag.reject('état moteur non reconnu');
        }
        let speedKmh: string | null = null;
        const speed = parseReportDecimal(at(row.cells, 'speed'), settings.decimalSeparator, xlsx);
        if (speed !== 'vide') {
          speedKmh = speed === null ? null : measure(speed, 'vitesse');
          if (speedKmh === null) diag.reject('vitesse invalide');
        }
        result.fuel.push({ unitExternalId: unitId, kind: settings.fuelKind, liters, percent, engineOn, speedKmh, observedAt, sourceReference: reference });
        if (!unit.fuelKinds.includes(settings.fuelKind)) unit.fuelKinds.push(settings.fuelKind);
      }
    }
  }
  return result;
}

interface ReportFile {
  sourceName: string;
  fileName: string;
  buffer: Buffer;
}

/** Élément acquittable chez la source : un message IMAP (ses pièces jointes) ou un fichier SFTP. */
interface SourceItem {
  ackKey: string;
  files: ReportFile[];
  /** Élément illisible en l'état (trop volumineux…) : ni lu ni acquitté. */
  blocked?: string;
}

interface ReportSource {
  fetch(): Promise<SourceItem[]>;
  acknowledge(ackKeys: string[]): Promise<void>;
  probe(): Promise<string>;
  close(): Promise<void>;
}

function imapError(error: unknown, timeoutMs: number): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { authenticationFailed?: boolean; responseStatus?: string; serverResponseCode?: string; message?: string } | null;
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new ProviderError('AUTHENTIFICATION', `${REPORT_PROVIDER} : identifiants IMAP refusés.`);
  }
  if (typeof e?.message === 'string' && /STARTTLS/.test(e.message)) {
    return new ProviderError('CONFIGURATION', `${REPORT_PROVIDER} : le serveur IMAP ne propose pas STARTTLS (imap.tls).`);
  }
  if (e?.responseStatus === 'NO' || e?.responseStatus === 'BAD') {
    return new ProviderError('REPONSE_INVALIDE', `${REPORT_PROVIDER} : commande IMAP refusée par le serveur.`);
  }
  return networkError(`${REPORT_PROVIDER} (IMAP)`, error, timeoutMs);
}

/** Ouverture d'un dossier : un refus (dossier absent ou non autorisé) est une erreur de configuration. */
async function openMailbox(client: ImapFlow, path: string, readOnly: boolean): Promise<{ release(): void }> {
  try {
    return await client.getMailboxLock(path, { readOnly });
  } catch (error) {
    const e = error as { responseStatus?: string } | null;
    if (e?.responseStatus === 'NO' || e?.responseStatus === 'BAD') {
      throw new ProviderError('CONFIGURATION', `${REPORT_PROVIDER} : dossier IMAP « ${path} » introuvable ou inaccessible.`);
    }
    throw error;
  }
}

class ImapReportSource implements ReportSource {
  private client: ImapFlow | null = null;
  private uidValidity: bigint | null = null;

  constructor(
    private readonly settings: ImapSourceSettings,
    private readonly credential: { user: string; secret: string },
    private readonly timeoutMs: number,
    private readonly diag: DiagnosticsCollector,
  ) {}

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.tls === 'implicite',
      doSTARTTLS: this.settings.tls === 'starttls' ? true : this.settings.tls === 'aucun' ? false : undefined,
      auth: { user: this.credential.user, pass: this.credential.secret },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs * 4,
      tls: { rejectUnauthorized: true },
    });
    // Une erreur de socket après connexion ne doit pas interrompre le processus.
    client.on('error', () => this.diag.reject('connexion IMAP interrompue'));
    try {
      await client.connect();
    } catch (error) {
      throw imapError(error, this.timeoutMs);
    }
    this.client = client;
    return client;
  }

  async fetch(): Promise<SourceItem[]> {
    try {
      const client = await this.connect();
      const lock = await openMailbox(client, this.settings.mailbox, true);
      const raw: Array<{ uid: number; source: Buffer }> = [];
      const blocked: SourceItem[] = [];
      try {
        this.uidValidity = client.mailbox ? client.mailbox.uidValidity : null;
        const found = await client.search({ seen: false }, { uid: true });
        const uids = (found || []).sort((a, b) => a - b).slice(0, this.settings.maxMessages);
        if (uids.length === 0) return [];
        const sizes = await client.fetchAll(uids, { uid: true, size: true }, { uid: true });
        const readable = sizes.filter((m) => (m.size ?? 0) <= this.settings.maxMessageBytes).map((m) => m.uid);
        for (const m of sizes) if ((m.size ?? 0) > this.settings.maxMessageBytes) blocked.push({ ackKey: String(m.uid), files: [], blocked: 'message trop volumineux' });
        if (readable.length > 0) {
          for (const m of await client.fetchAll(readable, { uid: true, source: true }, { uid: true })) {
            if (m.source) raw.push({ uid: m.uid, source: m.source });
          }
        }
      } finally {
        lock.release();
      }
      const items: SourceItem[] = [...blocked];
      for (const { uid, source } of raw) {
        const mail = await simpleParser(source);
        const files: ReportFile[] = [];
        for (const a of mail.attachments) {
          const name = a.filename ?? '';
          if (!REPORT_FILE.test(name)) {
            this.diag.reject('pièce jointe ignorée (ni CSV ni XLSX)');
            continue;
          }
          files.push({ sourceName: `IMAP ${this.settings.mailbox} UID ${uid} — ${name}`, fileName: name, buffer: a.content });
        }
        if (files.length === 0) this.diag.reject('message sans pièce jointe CSV/XLSX');
        items.push({ ackKey: String(uid), files });
      }
      return items;
    } catch (error) {
      throw imapError(error, this.timeoutMs);
    }
  }

  async acknowledge(ackKeys: string[]): Promise<void> {
    if (ackKeys.length === 0) return;
    try {
      const client = await this.connect();
      if (this.settings.processedMailbox) {
        const existing = await client.list();
        if (!existing.some((m) => m.path === this.settings.processedMailbox)) await client.mailboxCreate(this.settings.processedMailbox);
      }
      const lock = await openMailbox(client, this.settings.mailbox, false);
      try {
        if (!client.mailbox || client.mailbox.uidValidity !== this.uidValidity) {
          // UIDVALIDITY changée : les UID ne désignent plus les mêmes messages ; le registre SHA-256 suffit.
          this.diag.reject('acquittement IMAP reporté (UIDVALIDITY modifiée)', ackKeys.length);
          return;
        }
        const range = ackKeys.join(',');
        if (this.settings.processedMailbox) await client.messageMove(range, this.settings.processedMailbox, { uid: true });
        else await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    } catch (error) {
      throw imapError(error, this.timeoutMs);
    }
  }

  async probe(): Promise<string> {
    try {
      const client = await this.connect();
      const lock = await openMailbox(client, this.settings.mailbox, true);
      try {
        const unseen = await client.search({ seen: false }, { uid: true });
        return `boîte IMAP joignable ; ${(unseen || []).length} message(s) non lu(s) dans « ${this.settings.mailbox} ».`;
      } finally {
        lock.release();
      }
    } catch (error) {
      throw imapError(error, this.timeoutMs);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/** Empreinte OpenSSH (base64 sans remplissage) du SHA-256 de la clé d'hôte. */
export function sshHostKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function sftpError(error: unknown, timeoutMs: number): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/authentication methods failed|authentication failed/i.test(message)) return new ProviderError('AUTHENTIFICATION', `${REPORT_PROVIDER} : identifiants SFTP refusés.`);
  if (/host denied|verification failed|host key/i.test(message)) {
    return new ProviderError('CONFIGURATION', `${REPORT_PROVIDER} : clé d’hôte SFTP différente de l’empreinte configurée (sftp.hostKeySha256).`);
  }
  if (/no such file|ENOENT/i.test(message)) return new ProviderError('CONFIGURATION', `${REPORT_PROVIDER} : répertoire SFTP introuvable.`);
  if (/permission denied|EACCES/i.test(message)) return new ProviderError('AUTHENTIFICATION', `${REPORT_PROVIDER} : droits SFTP insuffisants.`);
  if (/timed out/i.test(message)) return new ProviderError('INJOIGNABLE', `${REPORT_PROVIDER} (SFTP) injoignable : délai de ${timeoutMs} ms dépassé.`);
  return networkError(`${REPORT_PROVIDER} (SFTP)`, error, timeoutMs);
}

class SftpReportSource implements ReportSource {
  private client: SftpClient | null = null;

  constructor(
    private readonly settings: SftpSourceSettings,
    private readonly credential: { user: string; secret: string },
    private readonly timeoutMs: number,
    private readonly maxFileBytes: number,
    private readonly diag: DiagnosticsCollector,
  ) {}

  private async connect(): Promise<SftpClient> {
    if (this.client) return this.client;
    // Écouteurs explicites : ceux par défaut de la bibliothèque écrivent sur la console (jamais de journal ici).
    const client = new SftpClient('parc-auto-rapports', {
      error: () => this.diag.reject('connexion SFTP interrompue'),
      end: () => undefined,
      close: () => undefined,
    });
    const privateKey = this.credential.secret.startsWith('-----BEGIN') ? this.credential.secret : undefined;
    try {
      await client.connect({
        host: this.settings.host,
        port: this.settings.port,
        username: this.credential.user,
        ...(privateKey ? { privateKey } : { password: this.credential.secret }),
        readyTimeout: this.timeoutMs,
        retries: 0,
        hostVerifier: (key: Buffer) => sshHostKeyFingerprint(key) === this.settings.hostKeySha256,
      });
    } catch (error) {
      await client.end().catch(() => undefined);
      throw sftpError(error, this.timeoutMs);
    }
    this.client = client;
    return client;
  }

  private path(name: string): string {
    return `${this.settings.directory === '/' ? '' : this.settings.directory}/${name}`;
  }

  async fetch(): Promise<SourceItem[]> {
    try {
      const client = await this.connect();
      const listing = await client.list(this.settings.directory);
      const files = listing
        .filter((f) => f.type === '-' && REPORT_FILE.test(f.name))
        .sort((a, b) => a.modifyTime - b.modifyTime || a.name.localeCompare(b.name))
        .slice(0, this.settings.maxFiles);
      const items: SourceItem[] = [];
      for (const f of files) {
        if (f.size > this.maxFileBytes) {
          items.push({ ackKey: f.name, files: [], blocked: 'fichier trop volumineux' });
          continue;
        }
        const content = await client.get(this.path(f.name));
        if (!Buffer.isBuffer(content)) throw new ProviderError('REPONSE_INVALIDE', `${REPORT_PROVIDER} : lecture SFTP inattendue.`);
        items.push({ ackKey: f.name, files: [{ sourceName: `SFTP ${this.path(f.name)}`, fileName: f.name, buffer: content }] });
      }
      return items;
    } catch (error) {
      throw sftpError(error, this.timeoutMs);
    }
  }

  async acknowledge(ackKeys: string[]): Promise<void> {
    const target = this.settings.processedDirectory;
    if (!target || ackKeys.length === 0) return;
    try {
      const client = await this.connect();
      if (!(await client.exists(target))) await client.mkdir(target, true);
      for (const name of ackKeys) {
        let destination = `${target}/${name}`;
        for (let n = 1; await client.exists(destination); n += 1) destination = `${target}/${name.replace(/(\.[^.]+)$/, `-${n}$1`)}`;
        await client.rename(this.path(name), destination);
      }
    } catch (error) {
      throw sftpError(error, this.timeoutMs);
    }
  }

  async probe(): Promise<string> {
    try {
      const client = await this.connect();
      const listing = await client.list(this.settings.directory);
      const pending = listing.filter((f) => f.type === '-' && REPORT_FILE.test(f.name)).length;
      return `répertoire SFTP joignable ; ${pending} fichier(s) de rapport en attente.`;
    } catch (error) {
      throw sftpError(error, this.timeoutMs);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }
}

interface LoadedBatch {
  odometer: OdometerSample[];
  fuel: FuelSample[];
  units: Map<string, ProviderUnit>;
  pendingFiles: Array<{ sourceName: string; sha256: string; rowCount: number }>;
  ackKeys: string[];
}

export class ReportGenericAdapter implements TelemetryProvider {
  readonly partialUnitList = true;
  private readonly settings: ReportSettings;
  private readonly zone: string;
  private readonly ledger: ReportLedger;
  private readonly diag = new DiagnosticsCollector();
  private source: ReportSource | null = null;
  private batch: Promise<LoadedBatch> | null = null;

  constructor(private readonly config: AdapterConfig) {
    this.settings = parseReportSettings(config.settings);
    this.zone = this.settings.timezone ?? config.timezone;
    if (!IANAZone.isValidZone(this.zone)) fail(`fuseau horaire inconnu « ${this.zone} ».`);
    if (!config.reportLedger) fail('registre des fichiers traités (reportLedger) non fourni.');
    this.ledger = config.reportLedger;
    this.diag.files = { read: 0, alreadyProcessed: 0, unreadable: 0, rows: 0 };
  }

  private getSource(): ReportSource {
    if (this.source) return this.source;
    if (this.settings.source === 'IMAP' && this.settings.imap) {
      const credential = splitCredential(REPORT_PROVIDER, 'IMAP', this.config.secrets.IMAP);
      this.source = new ImapReportSource(this.settings.imap, credential, this.config.timeoutMs, this.diag);
    } else if (this.settings.sftp) {
      const credential = splitCredential(REPORT_PROVIDER, 'SFTP', this.config.secrets.SFTP);
      this.source = new SftpReportSource(this.settings.sftp, credential, this.config.timeoutMs, this.settings.maxFileBytes, this.diag);
    } else {
      fail('source de rapports non configurée.');
    }
    return this.source;
  }

  /** Lecture unique par exécution : fichiers nouveaux, empreintes, analyse. */
  private load(): Promise<LoadedBatch> {
    this.batch ??= this.readBatch();
    return this.batch;
  }

  private async readBatch(): Promise<LoadedBatch> {
    const files = this.diag.files as NonNullable<DiagnosticsCollector['files']>;
    const batch: LoadedBatch = { odometer: [], fuel: [], units: new Map(), pendingFiles: [], ackKeys: [] };
    const seen = new Set<string>();
    for (const item of await this.getSource().fetch()) {
      if (item.blocked) {
        files.unreadable += 1;
        this.diag.reject(item.blocked);
        continue;
      }
      let complete = true;
      for (const file of item.files) {
        if (file.buffer.length > this.settings.maxFileBytes) {
          files.unreadable += 1;
          this.diag.reject('fichier trop volumineux');
          complete = false;
          continue;
        }
        const sha256 = createHash('sha256').update(file.buffer).digest('hex');
        if (seen.has(sha256) || (await this.ledger.isProcessed(sha256))) {
          files.alreadyProcessed += 1;
          continue;
        }
        const parsed = await this.parseFile(file);
        if (typeof parsed === 'string') {
          files.unreadable += 1;
          this.diag.reject(`fichier illisible : ${parsed}`);
          complete = false;
          continue;
        }
        seen.add(sha256);
        files.read += 1;
        files.rows += parsed.rows;
        batch.odometer.push(...parsed.odometer);
        batch.fuel.push(...parsed.fuel);
        for (const [id, unit] of parsed.units) batch.units.set(id, mergeUnit(batch.units.get(id), unit));
        batch.pendingFiles.push({ sourceName: file.sourceName, sha256, rowCount: parsed.rows });
      }
      if (complete) batch.ackKeys.push(item.ackKey);
    }
    batch.odometer.sort(byObservedAt);
    batch.fuel.sort(byObservedAt);
    return batch;
  }

  private async parseFile(file: ReportFile): Promise<ParsedReport | string> {
    let table: Table;
    try {
      table = await readTable(file.buffer, file.fileName, this.settings.maxRowsPerFile);
    } catch (error) {
      if (error instanceof BusinessRuleError) {
        // Un rapport sans ligne de données (aucune activité sur la période) est valide.
        if (error.code === 'FICHIER_VIDE') return { odometer: [], fuel: [], units: new Map(), rows: 0 };
        return error.code;
      }
      return 'FORMAT_INCONNU';
    }
    return parseReportTable(table, file.fileName, this.settings, this.zone, this.diag);
  }

  async listUnits(): Promise<ProviderUnit[]> {
    return [...(await this.load()).units.values()];
  }

  async getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]> {
    const wanted = new Set(unitExternalIds);
    return (await this.load()).odometer.filter((s) => wanted.has(s.unitExternalId));
  }

  async getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]> {
    const wanted = new Set(unitExternalIds);
    return (await this.load()).fuel.filter((s) => wanted.has(s.unitExternalId) && s.observedAt >= from && s.observedAt <= to);
  }

  healthCheck(): Promise<ProviderHealth> {
    return runHealthCheck(this.config.clock, async () => `${REPORT_PROVIDER} : ${await this.getSource().probe()}`);
  }

  /** Inscrit les fichiers lus au registre puis les acquitte chez la source (marqués lus ou déplacés). */
  async acknowledge(): Promise<void> {
    if (!this.batch) return;
    let batch: LoadedBatch;
    try {
      batch = await this.batch;
    } catch {
      return; // lecture en échec : rien n'a été renvoyé, donc rien à acquitter.
    }
    for (const file of batch.pendingFiles.splice(0)) await this.ledger.markProcessed(file);
    const keys = batch.ackKeys.splice(0);
    await this.getSource().acknowledge(keys);
  }

  diagnostics(): AdapterDiagnostics {
    return this.diag.snapshot();
  }

  async close(): Promise<void> {
    await this.source?.close();
    this.source = null;
  }
}

function mergeUnit(existing: ProviderUnit | undefined, next: ProviderUnit): ProviderUnit {
  if (!existing) return next;
  return {
    externalId: existing.externalId,
    label: next.label !== next.externalId ? next.label : existing.label,
    declaredRegistration: next.declaredRegistration ?? existing.declaredRegistration,
    odometerKinds: [...new Set([...existing.odometerKinds, ...next.odometerKinds])],
    fuelKinds: [...new Set([...existing.fuelKinds, ...next.fuelKinds])],
  };
}

export const createReportGenericAdapter = (config: AdapterConfig): TelemetryProvider => new ReportGenericAdapter(config);
