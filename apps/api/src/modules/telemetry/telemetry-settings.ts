import type { TelemetryChannel, TelemetryCredentialKind, TelemetryProviderKind } from '@parc-auto/db';
import { TELEMETRY_PROVIDER_KIND_LABELS } from '@parc-auto/contracts';
import { BusinessRuleError, type FieldErrors } from '../../common/errors.js';

/**
 * Règles de configuration d'un fournisseur télématique (CDC 14.3, 14.6 ; D-112, D-292, D-303, D-304) :
 * canal déduit du type, natures de secrets admises, validation de l'URL de base et des paramètres non
 * secrets. Une seule implémentation, utilisée par l'API et le worker.
 */

export const PROVIDER_KINDS = ['TRACCAR', 'WIALON', 'RAPPORT_GENERIQUE', 'WEBHOOK_GENERIQUE', 'RPA', 'SIMULATEUR'] as const satisfies readonly TelemetryProviderKind[];
export const CREDENTIAL_KINDS = ['JETON_API', 'IDENTIFIANTS_API', 'IMAP', 'SFTP', 'RPA', 'SIGNATURE_WEBHOOK'] as const satisfies readonly TelemetryCredentialKind[];
export type AdapterSecretKind = 'JETON_API' | 'IDENTIFIANTS_API' | 'IMAP' | 'SFTP';
export const ADAPTER_SECRET_KINDS: readonly AdapterSecretKind[] = ['JETON_API', 'IDENTIFIANTS_API', 'IMAP', 'SFTP'];

/** Libellé imposé au simulateur partout où il apparaît (D-303). */
export const SIMULATOR_LABEL = 'SIMULATEUR — données fictives';

/** Refus du canal RPA en V1 (D-292). */
export const RPA_REFUSAL_MESSAGE = 'Canal RPA non disponible en V1 : interface documentée, accord écrit du fournisseur requis (D-292)';

/** Canal déduit du type de fournisseur (jamais saisi). */
export const CHANNEL_BY_KIND: Readonly<Record<TelemetryProviderKind, TelemetryChannel>> = {
  TRACCAR: 'API',
  WIALON: 'API',
  RAPPORT_GENERIQUE: 'RAPPORT',
  WEBHOOK_GENERIQUE: 'WEBHOOK',
  RPA: 'RPA',
  SIMULATEUR: 'API',
};

/** Natures de secrets acceptées par type de fournisseur. */
export const CREDENTIAL_KINDS_BY_PROVIDER: Readonly<Record<TelemetryProviderKind, readonly TelemetryCredentialKind[]>> = {
  TRACCAR: ['JETON_API', 'IDENTIFIANTS_API'],
  WIALON: ['JETON_API'],
  RAPPORT_GENERIQUE: ['IMAP', 'SFTP'],
  // Secret de signature HMAC des lots reçus (D-298) : jamais transmis à un adaptateur.
  WEBHOOK_GENERIQUE: ['SIGNATURE_WEBHOOK'],
  RPA: [],
  SIMULATEUR: ['JETON_API'],
};

/** Types de fournisseur dont l'URL de base (API) est obligatoire avant activation. */
const BASE_URL_REQUIRED: ReadonlySet<TelemetryProviderKind> = new Set(['TRACCAR', 'WIALON']);

export const SYNC_INTERVAL_MIN = 5;
export const SYNC_INTERVAL_MAX = 1440;
export const BACKFILL_DAYS_MAX = 90;
/** Délai maximal d'un appel réseau fournisseur (AdapterConfig.timeoutMs). */
export const PROVIDER_TIMEOUT_MS = 15_000;
/** Taille maximale des paramètres non secrets sérialisés (scénario du simulateur compris). */
const SETTINGS_MAX_BYTES = 256 * 1024;

export function kindLabel(kind: TelemetryProviderKind): string {
  return kind === 'SIMULATEUR' ? SIMULATOR_LABEL : TELEMETRY_PROVIDER_KIND_LABELS[kind];
}

/** Clés refusées dans les paramètres non secrets : un secret se dépose uniquement via /credentials (D-304). */
const SECRET_KEY_PATTERN = /(pass(word|wd|phrase)?|^pwd$|secret|token|jeton|api[-_]?key|apikey|private[-_]?key|credential|identifiant[s]?_?api|^sid$|^eid$|authorization|mot[-_]?de[-_]?passe)/i;

/**
 * URL de base : http(s) uniquement, sans identifiants intégrés, sans paramètres ni fragment (un jeton
 * dans l'URL serait stocké en clair). La barre oblique finale est retirée.
 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('baseUrl', 'URL invalide (http:// ou https:// attendu).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('baseUrl', 'Seuls les protocoles http et https sont acceptés.');
  if (url.username || url.password) throw invalid('baseUrl', 'L’URL ne doit contenir aucun identifiant : déposez les secrets via la configuration des accès.');
  if (url.search || url.hash) throw invalid('baseUrl', 'L’URL ne doit contenir ni paramètre ni fragment (aucun jeton dans l’URL).');
  return url.toString().replace(/\/+$/, '');
}

/**
 * Contrôle générique des paramètres non secrets : objet JSON, taille bornée, aucune clé évoquant un
 * secret (à n'importe quelle profondeur). Le contrôle propre au type est fait par l'appelant.
 */
export function assertNonSecretSettings(settings: unknown): Record<string, unknown> {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw invalid('settings', 'Les paramètres doivent être un objet JSON.');
  }
  const serialized = JSON.stringify(settings);
  if (Buffer.byteLength(serialized, 'utf8') > SETTINGS_MAX_BYTES) {
    throw invalid('settings', `Paramètres trop volumineux (${SETTINGS_MAX_BYTES / 1024} Kio au plus).`);
  }
  const offending: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (SECRET_KEY_PATTERN.test(k)) offending.push(p);
        walk(v, p);
      }
    }
  };
  walk(settings, '');
  if (offending.length > 0) {
    throw new BusinessRuleError('SECRET_DANS_PARAMETRES', 'Les paramètres ne doivent contenir aucun secret : déposez jetons et mots de passe via PUT /telemetry/providers/:id/credentials/:kind.', {
      fieldErrors: Object.fromEntries(offending.map((p) => [`settings.${p}`, ['Clé réservée aux secrets (écriture seule).']])),
    });
  }
  return settings as Record<string, unknown>;
}

export function assertCredentialKindAllowed(providerKind: TelemetryProviderKind, credentialKind: TelemetryCredentialKind): void {
  if (!CREDENTIAL_KINDS_BY_PROVIDER[providerKind].includes(credentialKind)) {
    const allowed = CREDENTIAL_KINDS_BY_PROVIDER[providerKind];
    throw new BusinessRuleError(
      'NATURE_SECRET_NON_ADMISE',
      allowed.length === 0
        ? `Le type ${providerKind} n’accepte aucun secret.`
        : `Nature de secret non admise pour ${providerKind} : ${allowed.join(' ou ')} attendu.`,
    );
  }
}

/**
 * Conditions d'activation (BROUILLON/SUSPENDU → ACTIF) indépendantes du réseau : au moins une société
 * couverte, URL de base si l'API l'exige, secret déposé si le type en exige un.
 */
export function activationProblems(input: {
  kind: TelemetryProviderKind;
  baseUrl: string | null;
  coveredCompanies: number;
  configuredCredentials: ReadonlySet<TelemetryCredentialKind>;
  simulatorRequiresToken: boolean;
}): string[] {
  const problems: string[] = [];
  if (input.coveredCompanies === 0) problems.push('Aucune société couverte par ce fournisseur.');
  if (BASE_URL_REQUIRED.has(input.kind) && !input.baseUrl) problems.push('URL de base de l’API non renseignée.');
  const has = (k: TelemetryCredentialKind) => input.configuredCredentials.has(k);
  switch (input.kind) {
    case 'TRACCAR':
      if (!has('JETON_API') && !has('IDENTIFIANTS_API')) problems.push('Jeton API ou identifiants API non déposés.');
      break;
    case 'WIALON':
      if (!has('JETON_API')) problems.push('Jeton API non déposé.');
      break;
    case 'RAPPORT_GENERIQUE':
      if (!has('IMAP') && !has('SFTP')) problems.push('Accès IMAP ou SFTP non déposé.');
      break;
    case 'WEBHOOK_GENERIQUE':
      if (!has('SIGNATURE_WEBHOOK')) problems.push('Secret de signature du webhook non déposé.');
      break;
    case 'SIMULATEUR':
      if (input.simulatorRequiresToken && !has('JETON_API')) problems.push('Le scénario du simulateur exige un jeton API (authRequired).');
      break;
    case 'RPA':
      problems.push(RPA_REFUSAL_MESSAGE);
      break;
  }
  return problems;
}

export function invalid(field: string, message: string): BusinessRuleError {
  const fieldErrors: FieldErrors = { [field]: [message] };
  return new BusinessRuleError('VALIDATION', message, { fieldErrors });
}
