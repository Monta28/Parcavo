import { BusinessRuleError } from '../common/errors.js';

/**
 * Configuration lue depuis l'environnement, validée au démarrage. Aucune valeur secrète par défaut.
 * Les secrets ne sont jamais renvoyés par l'API ni journalisés.
 */
export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  /**
   * Délai borné d'obtention d'une connexion du pool PostgreSQL (DATABASE_CONNECTION_TIMEOUT_MS, 10 000 ms
   * par défaut) : au-delà, la requête échoue au lieu d'attendre sans limite une connexion libre.
   */
  databaseConnectionTimeoutMs: number;
  /** Origine publique du site (contrôle d'origine des mutations, cookies). */
  appOrigin: string;
  cookieSecure: boolean;
  storageDir: string;
  /** Clé de chiffrement au repos des secrets télématiques (32 octets en base64). */
  secretsEncryptionKey: Buffer | null;
  secretsEncryptionKeyId: string;
  smtp: { host: string; port: number; secure: boolean; user: string | null; pass: string | null; from: string } | null;
  /** Le simulateur télématique ne peut être activé qu'hors production. */
  telemetrySimulatorEnabled: boolean;
  logLevel: string;
  trustProxy: boolean;
  /** Limitation de débit en mémoire (par IP) ; désactivable uniquement pour les tests automatisés. */
  rateLimitEnabled: boolean;
  /** Version déployée (APP_VERSION, facultative), affichée par le worker et la santé. */
  appVersion: string | null;
}

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function readInt(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Variable ${name} invalide : entier attendu.`);
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = read(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'oui', 'yes'].includes(raw.toLowerCase());
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const prev = process.env;
  process.env = source;
  try {
    const nodeEnv = (read('NODE_ENV') ?? 'development') as AppEnv['nodeEnv'];
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
      throw new Error('NODE_ENV doit valoir development, test ou production.');
    }
    const databaseUrl = read('DATABASE_URL');
    if (!databaseUrl) throw new Error('DATABASE_URL est obligatoire.');
    const databaseConnectionTimeoutMs = readInt('DATABASE_CONNECTION_TIMEOUT_MS', 10_000);
    if (databaseConnectionTimeoutMs <= 0) throw new Error('DATABASE_CONNECTION_TIMEOUT_MS doit être un nombre de millisecondes strictement positif.');
    const appOrigin = read('APP_ORIGIN') ?? 'http://localhost:3000';
    const keyB64 = read('SECRETS_ENCRYPTION_KEY');
    let secretsEncryptionKey: Buffer | null = null;
    if (keyB64) {
      secretsEncryptionKey = Buffer.from(keyB64, 'base64');
      if (secretsEncryptionKey.length !== 32) {
        throw new Error('SECRETS_ENCRYPTION_KEY doit contenir 32 octets encodés en base64.');
      }
    }
    if (nodeEnv === 'production' && !secretsEncryptionKey) {
      throw new Error('SECRETS_ENCRYPTION_KEY est obligatoire en production.');
    }
    const smtpHost = read('SMTP_HOST');
    const smtp = smtpHost
      ? {
          host: smtpHost,
          port: readInt('SMTP_PORT', 587),
          secure: readBool('SMTP_SECURE', false),
          user: read('SMTP_USER') ?? null,
          pass: read('SMTP_PASSWORD') ?? null,
          from: read('SMTP_FROM') ?? 'parc-auto@localhost',
        }
      : null;
    const simulatorRequested = readBool('TELEMETRY_SIMULATOR_ENABLED', false);
    if (simulatorRequested && nodeEnv === 'production') {
      throw new Error('TELEMETRY_SIMULATOR_ENABLED ne peut pas être activé en production.');
    }
    return {
      nodeEnv,
      port: readInt('PORT', 3001),
      databaseUrl,
      databaseConnectionTimeoutMs,
      appOrigin,
      cookieSecure: readBool('COOKIE_SECURE', nodeEnv === 'production'),
      storageDir: read('STORAGE_DIR') ?? './storage',
      secretsEncryptionKey,
      secretsEncryptionKeyId: read('SECRETS_ENCRYPTION_KEY_ID') ?? 'k1',
      smtp,
      telemetrySimulatorEnabled: simulatorRequested && nodeEnv !== 'production',
      logLevel: read('LOG_LEVEL') ?? (nodeEnv === 'production' ? 'info' : 'debug'),
      trustProxy: readBool('TRUST_PROXY', nodeEnv === 'production'),
      rateLimitEnabled: nodeEnv === 'production' ? true : readBool('RATE_LIMIT_ENABLED', true),
      appVersion: read('APP_VERSION') ?? null,
    };
  } finally {
    process.env = prev;
  }
}

export const APP_ENV = Symbol('APP_ENV');

/** Garde d'exécution : refuse une opération réservée aux environnements de test. */
export function assertNotProduction(env: AppEnv, what: string): void {
  if (env.nodeEnv === 'production') {
    throw new BusinessRuleError('INTERDIT_EN_PRODUCTION', `${what} est interdit en production.`);
  }
}
