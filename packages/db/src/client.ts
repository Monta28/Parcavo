import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export interface PrismaClientOptions {
  /** URL PostgreSQL (jamais journalisée). */
  databaseUrl: string;
  /** Taille maximale du pool de connexions pg. */
  maxConnections?: number;
  /** Journalisation Prisma : uniquement les erreurs et avertissements par défaut. */
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

export type ParcAutoPrismaClient = PrismaClient;

/**
 * Fabrique le client Prisma 7 avec l'adaptateur pg. Le fuseau de session PostgreSQL est forcé en UTC
 * pour que tous les horodatages circulent en UTC (CDC 9.3) ; les dates civiles restent des DATE.
 */
export function createPrismaClient(options: PrismaClientOptions): ParcAutoPrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: options.databaseUrl,
      max: options.maxConnections ?? 10,
      options: '-c timezone=UTC',
    },
  );
  return new PrismaClient({ adapter, log: options.log ?? ['warn', 'error'] });
}
