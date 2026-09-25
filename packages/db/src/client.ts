import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * Délai maximal d'obtention d'une connexion du pool pg (connexion nouvelle ou libérée), en millisecondes.
 * Au-delà, la requête échoue au lieu d'attendre indéfiniment une connexion (pool saturé, base injoignable).
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export interface PrismaClientOptions {
  /** URL PostgreSQL (jamais journalisée). */
  databaseUrl: string;
  /** Taille maximale du pool de connexions pg. */
  maxConnections?: number;
  /**
   * Délai borné d'attente d'une connexion du pool (ms, entier strictement positif) ; 10 s par défaut.
   * L'API et le worker le lisent dans DATABASE_CONNECTION_TIMEOUT_MS (.env.example).
   */
  connectionTimeoutMs?: number;
  /** Journalisation Prisma : uniquement les erreurs et avertissements par défaut. */
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

export type ParcAutoPrismaClient = PrismaClient;

/**
 * Fabrique le client Prisma 7 avec l'adaptateur pg. Le fuseau de session PostgreSQL est forcé en UTC
 * pour que tous les horodatages circulent en UTC (CDC 9.3) ; les dates civiles restent des DATE.
 */
export function createPrismaClient(options: PrismaClientOptions): ParcAutoPrismaClient {
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis <= 0) {
    throw new Error('Délai de connexion au pool invalide : entier strictement positif (millisecondes) attendu.');
  }
  const adapter = new PrismaPg(
    {
      connectionString: options.databaseUrl,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis,
      options: '-c timezone=UTC',
    },
  );
  return new PrismaClient({ adapter, log: options.log ?? ['warn', 'error'] });
}
