import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type ParcAutoPrismaClient, Prisma } from '@parc-auto/db';
import { APP_ENV, type AppEnv } from './env.js';
import { ConflictError, ErrorCodes } from '../common/errors.js';

export type Tx = Prisma.TransactionClient;

/** Codes Prisma de conflit de concurrence : sérialisation (P2034) et contrainte unique (P2002). */
const RETRYABLE_CODES = new Set(['P2034']);

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: ParcAutoPrismaClient;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.client = createPrismaClient({ databaseUrl: env.databaseUrl, log: env.nodeEnv === 'test' ? ['error'] : ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Transaction Serializable avec reprise bornée sur conflit de sérialisation (CDC 13.3, [R2]).
   * Les opérations critiques (remise, retour, correction, clôture, transfert, ingestion) l'utilisent.
   */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, options?: { maxRetries?: number }): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    let attempt = 0;
    for (;;) {
      try {
        return await this.client.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 20_000,
        });
      } catch (error) {
        if (isRetryable(error) && attempt < maxRetries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
          continue;
        }
        if (isRetryable(error)) {
          throw new ConflictError(ErrorCodes.CONCURRENCE, 'Une opération concurrente a modifié les mêmes données ; veuillez réessayer.');
        }
        throw error;
      }
    }
  }

  /** Transaction Read Committed classique pour les écritures simples. */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn, { maxWait: 5_000, timeout: 20_000 });
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && RETRYABLE_CODES.has(error.code);
}

/** Nom de la contrainte violée, extrait des métadonnées de l'adaptateur (jamais du texte source). */
export function violatedConstraint(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) && !(error instanceof Prisma.PrismaClientUnknownRequestError)) {
    return null;
  }
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  const cause = (meta?.['driverAdapterError'] as { cause?: { constraint?: { index?: string; fields?: string[] }; originalMessage?: string } } | undefined)?.cause;
  if (cause?.constraint?.index) return cause.constraint.index;
  if (cause?.constraint?.fields) return cause.constraint.fields.join(',');
  const target: unknown = meta?.['target'];
  if (Array.isArray(target)) return target.map(String).join(',');
  if (typeof target === 'string') return target;
  const fromMessage = /violates (?:unique|exclusion|check) constraint "([^"]+)"/.exec(cause?.originalMessage ?? error.message);
  return fromMessage?.[1] ?? null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  if (!constraint) return true;
  const name = violatedConstraint(error);
  return name !== null && name.includes(constraint);
}

/** Violation d'une contrainte d'exclusion ou CHECK (erreur PostgreSQL relayée par l'adaptateur). */
export function isConstraintViolation(error: unknown, constraint: string): boolean {
  const name = violatedConstraint(error);
  if (name !== null) return name.includes(constraint);
  return error instanceof Error && /constraint "([^"]+)"/.exec(error.message)?.[1]?.includes(constraint) === true;
}
