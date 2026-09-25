import { Decimal } from 'decimal.js';
import type { Clock } from '../../../common/clock.js';
import { type AdapterDiagnostics, ProviderError, type ProviderHealth } from '../telemetry-provider.interface.js';

/**
 * Outils communs aux adaptateurs réels (TRACCAR, WIALON, RAPPORT_GENERIQUE) : conversions exactes en
 * kilomètres (D-195 : mètres arrondis au mètre, demi vers le haut), lecture typée des paramètres non
 * secrets, client HTTP borné (délai, cadence, erreurs typées D-297) et compteurs de valeurs écartées.
 * Aucun message produit ici ne contient de secret, d'URL complète ni de corps de réponse brut (T44).
 */

/** Capacité des colonnes Decimal(15, 3) des kilomètres. */
const MAX_KM = new Decimal('999999999999.999');
const KM_PER_MILE = new Decimal('1.609344');
const KMH_PER_KNOT = new Decimal('1.852');

/** Nombre fini issu d'un JSON fournisseur → décimal exact de sa représentation, sinon null. */
export function decimalFromJson(value: unknown): Decimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Decimal(value);
}

/** Mètres → kilomètres « 80450.125 » ; null si négatif ou hors capacité. */
export function metersToKm(meters: Decimal): string | null {
  if (meters.isNegative()) return null;
  const km = meters.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).div(1000);
  return km.gt(MAX_KM) ? null : km.toFixed(3);
}

/** Kilomètres → chaîne à 3 décimales (arrondi au mètre, demi vers le haut). */
export function kmToKm(km: Decimal): string | null {
  if (km.isNegative()) return null;
  const rounded = km.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return rounded.gt(MAX_KM) ? null : rounded.toFixed(3);
}

/** Miles internationaux → kilomètres. */
export function milesToKm(miles: Decimal): string | null {
  return kmToKm(miles.times(KM_PER_MILE));
}

/** Nœuds → km/h, 3 décimales. */
export function knotsToKmh(knots: Decimal): string {
  return knots.times(KMH_PER_KNOT).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
}

/** Litres, pourcentage ou vitesse : 3 décimales, négatif refusé ; pourcentage borné à 100. */
export function measure(value: Decimal, kind: 'litres' | 'pourcentage' | 'vitesse'): string | null {
  if (value.isNegative()) return null;
  if (kind === 'pourcentage' && value.gt(100)) return null;
  const limit = kind === 'litres' ? new Decimal('999999999999999.999') : new Decimal('999999.999');
  const rounded = value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return rounded.gt(limit) ? null : rounded.toFixed(3);
}

/** Instant ISO 8601 avec décalage explicite (Z ou ±hh:mm) ; toute autre forme est refusée. */
export function parseIsoInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Secret « identifiant:secret » (IDENTIFIANTS_API, IMAP, SFTP) : coupé au premier deux-points. */
export function splitCredential(provider: string, kind: string, raw: string | undefined): { user: string; secret: string } {
  if (raw === undefined) throw new ProviderError('CONFIGURATION', `${provider} : secret ${kind} non déposé.`);
  const index = raw.indexOf(':');
  if (index <= 0 || index === raw.length - 1) {
    throw new ProviderError('CONFIGURATION', `${provider} : le secret ${kind} doit avoir la forme « identifiant:motdepasse ».`);
  }
  return { user: raw.slice(0, index), secret: raw.slice(index + 1) };
}

/** Compteurs de valeurs écartées (jamais remplacées), exposés par diagnostics(). */
export class DiagnosticsCollector {
  private readonly rejected = new Map<string, number>();
  files: { read: number; alreadyProcessed: number; unreadable: number; rows: number } | null = null;

  reject(reason: string, count = 1): void {
    if (count <= 0) return;
    this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + count);
  }

  snapshot(): AdapterDiagnostics {
    const out: AdapterDiagnostics = { rejected: Object.fromEntries(this.rejected) };
    if (this.files) out.files = { ...this.files };
    return out;
  }
}

/** Lecture typée des paramètres non secrets ; toute incohérence est une erreur CONFIGURATION explicite. */
export class SettingsReader {
  constructor(
    private readonly provider: string,
    private readonly settings: Record<string, unknown>,
    private readonly prefix = '',
  ) {}

  private fail(key: string, message: string): never {
    throw new ProviderError('CONFIGURATION', `${this.provider} : paramètre « ${this.prefix}${key} » ${message}`);
  }

  /** null explicite (nature désactivée), distinct d'une clé absente (valeur par défaut). */
  isExplicitNull(key: string): boolean {
    return this.settings[key] === null;
  }

  has(key: string): boolean {
    const v = this.settings[key];
    return v !== undefined && v !== null && v !== '';
  }

  optionalString(key: string): string | null {
    const v = this.settings[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') this.fail(key, 'doit être une chaîne.');
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }

  string(key: string, fallback?: string): string {
    const v = this.optionalString(key);
    if (v !== null) return v;
    if (fallback !== undefined) return fallback;
    return this.fail(key, 'est obligatoire.');
  }

  choice<T extends string>(key: string, values: readonly T[], fallback?: T): T {
    const v = this.optionalString(key);
    if (v === null) {
      if (fallback !== undefined) return fallback;
      return this.fail(key, `est obligatoire (${values.join(', ')}).`);
    }
    if (!(values as readonly string[]).includes(v)) this.fail(key, `doit valoir ${values.join(', ')}.`);
    return v as T;
  }

  optionalChoice<T extends string>(key: string, values: readonly T[]): T | null {
    return this.has(key) ? this.choice(key, values) : null;
  }

  boolean(key: string, fallback: boolean): boolean {
    const v = this.settings[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') this.fail(key, 'doit être vrai ou faux.');
    return v;
  }

  integer(key: string, min: number, max: number, fallback: number | null): number | null {
    const v = this.settings[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) this.fail(key, `doit être un entier entre ${min} et ${max}.`);
    return v;
  }

  stringList(key: string, fallback: string[]): string[] {
    const v = this.settings[key];
    if (v === undefined || v === null) return fallback;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) this.fail(key, 'doit être une liste de chaînes non vides.');
    return (v as string[]).map((x) => x.trim());
  }

  object(key: string, required: boolean): SettingsReader | null {
    const v = this.settings[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, 'est obligatoire.');
      return null;
    }
    if (typeof v !== 'object' || Array.isArray(v)) this.fail(key, 'doit être un objet.');
    return new SettingsReader(this.provider, v as Record<string, unknown>, `${this.prefix}${key}.`);
  }

  objectList(key: string): SettingsReader[] {
    const v = this.settings[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => x === null || typeof x !== 'object' || Array.isArray(x))) this.fail(key, 'doit être une liste d’objets.');
    return (v as Record<string, unknown>[]).map((x, i) => new SettingsReader(this.provider, x, `${this.prefix}${key}[${i}].`));
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * URL de base d'une API fournisseur : https obligatoire, sauf hôte local ou autorisation explicite
 * (settings.allowPlainHttp) pour un serveur interne. Aucun identifiant ni paramètre dans l'URL.
 */
export function apiBaseUrl(provider: string, raw: string | null, allowPlainHttp: boolean): URL {
  if (!raw) throw new ProviderError('CONFIGURATION', `${provider} : URL de base de l’API non renseignée.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('CONFIGURATION', `${provider} : URL de base invalide.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('CONFIGURATION', `${provider} : seuls http et https sont acceptés.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError('CONFIGURATION', `${provider} : l’URL de base ne doit contenir ni identifiant, ni paramètre, ni fragment.`);
  }
  if (url.protocol === 'http:' && !allowPlainHttp && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ProviderError('CONFIGURATION', `${provider} : HTTP non chiffré refusé pour un hôte distant (activez settings.allowPlainHttp pour un serveur interne).`);
  }
  return url;
}

/** URL d'un chemin d'API sous l'URL de base (préfixe de chemin conservé, barre finale ignorée). */
export function joinUrl(base: URL, path: string): URL {
  return new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`);
}

/** Délai demandé par Retry-After (secondes ou date HTTP), borné à 24 h. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 86_400);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), 86_400);
}

/** Erreur réseau Node (fetch, sockets) → message expurgé. */
export function networkError(provider: string, error: unknown, timeoutMs: number): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ProviderError('INJOIGNABLE', `${provider} injoignable : délai de ${timeoutMs} ms dépassé.`);
  }
  const code = networkCode(error);
  const reason =
    code === 'ECONNREFUSED'
      ? 'connexion refusée'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'nom d’hôte introuvable'
        : code === 'ECONNRESET' || code === 'EPIPE'
          ? 'connexion interrompue'
          : code === 'ETIMEDOUT'
            ? 'délai de connexion dépassé'
            : code?.startsWith('ERR_TLS') || code?.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
              ? 'certificat TLS refusé'
              : 'erreur réseau';
  return new ProviderError('INJOIGNABLE', `${provider} injoignable : ${reason}${code ? ` (${code})` : ''}.`);
}

function networkCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Cadence maximale d'appels (settings.maxRequestsPerMinute, D-297) ; sans valeur, aucune attente. */
export class RequestPacer {
  private nextAt = 0;

  constructor(private readonly perMinute: number | null) {}

  async wait(): Promise<void> {
    if (!this.perMinute) return;
    const gap = 60_000 / this.perMinute;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + gap;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Appel HTTP borné : délai (AbortSignal), cadence, statuts typés. 401/403 → AUTHENTIFICATION,
 * 429 → QUOTA (Retry-After), 5xx → INJOIGNABLE, autre non-2xx → REPONSE_INVALIDE. `classify` permet à
 * l'adaptateur de qualifier un statut propre au fournisseur (sans jamais recopier le corps).
 */
export async function httpCall(
  provider: string,
  request: HttpRequest,
  options: { timeoutMs: number; pacer: RequestPacer; classify?: (status: number, body: string) => ProviderError | null },
): Promise<HttpResponse> {
  await options.pacer.wait();
  let response: Response;
  let body: string;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: { Accept: 'application/json', ...request.headers },
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    body = await response.text();
  } catch (error) {
    throw networkError(provider, error, options.timeoutMs);
  }
  if (response.status >= 200 && response.status < 300) return { status: response.status, body };
  const custom = options.classify?.(response.status, body) ?? null;
  if (custom) throw custom;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), Date.now());
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('AUTHENTIFICATION', `${provider} : accès refusé (HTTP ${response.status}) ; vérifiez le secret du compte de lecture.`);
  }
  if (response.status === 429) {
    throw new ProviderError('QUOTA', `${provider} : quota de requêtes atteint (HTTP 429).`, retryAfter);
  }
  if (response.status >= 500) {
    throw new ProviderError('INJOIGNABLE', `${provider} : service indisponible (HTTP ${response.status}).`, retryAfter);
  }
  throw new ProviderError('REPONSE_INVALIDE', `${provider} : requête refusée (HTTP ${response.status}).`);
}

export function parseJson(provider: string, body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderError('REPONSE_INVALIDE', `${provider} : réponse non JSON.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Contrôle de santé : ne lève jamais ; message expurgé, latence mesurée. */
export async function runHealthCheck(clock: Clock | undefined, probe: () => Promise<string>): Promise<ProviderHealth> {
  const started = performance.now();
  try {
    const message = await probe();
    return { ok: true, message, latencyMs: Math.round(performance.now() - started), checkedAt: clock?.now() ?? new Date() };
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : 'Erreur inattendue pendant le contrôle (détail non communiqué).';
    return { ok: false, message, latencyMs: Math.round(performance.now() - started), checkedAt: clock?.now() ?? new Date() };
  }
}

/** Tranches [début, fin] successives d'au plus `hours` heures couvrant [from, to]. */
export function timeChunks(from: Date, to: Date, hours: number): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  const step = hours * 3_600_000;
  for (let start = from.getTime(); start < to.getTime(); start += step) {
    chunks.push({ from: new Date(start), to: new Date(Math.min(start + step, to.getTime())) });
  }
  return chunks;
}

/** Tri stable par instant d'observation (le dernier élément d'une unité est son état le plus récent). */
export function byObservedAt<T extends { observedAt: Date }>(a: T, b: T): number {
  return a.observedAt.getTime() - b.observedAt.getTime();
}
