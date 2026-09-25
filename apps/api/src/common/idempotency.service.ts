import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@parc-auto/db';
import { PrismaService, type Tx } from '../infra/prisma.service.js';
import { Clock } from './clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes } from './errors.js';

export interface IdempotencyScope {
  organizationId: string;
  userId: string;
  operation: string;
  key: string;
}

export interface ReplayedResponse<T> {
  replayed: true;
  status: number;
  body: T;
}

/** Conservation des clés d’idempotence : 24 h (D-286, D-308), purge par le worker. */
const RETENTION_HOURS = 24;

/**
 * Idempotence des opérations critiques (CDC 15.3) : clé liée à l'utilisateur, à l'organisation et à
 * l'opération. Même clé + même corps : réponse initiale rejouée ; même clé + corps différent : 409.
 * Une exécution concurrente avec la même clé reçoit 409 « en cours ».
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  hashBody(body: unknown): string {
    return createHash('sha256').update(stableStringify(body)).digest('hex');
  }

  /**
   * Idempotence facultative (D-308) : sans clé, l'opération s'exécute normalement ; avec une clé (8 à 128
   * caractères), elle est protégée comme par run() et la réponse initiale est rejouée.
   */
  async runOptional<T>(scope: Omit<IdempotencyScope, 'key'>, key: string | undefined, body: unknown, work: () => Promise<{ status: number; body: T; resourceId?: string }>): Promise<T> {
    if (key === undefined) return (await work()).body;
    if (key.length < 8 || key.length > 128) {
      throw new BusinessRuleError('IDEMPOTENCE_CLE_INVALIDE', 'La clé d’idempotence doit compter de 8 à 128 caractères.', { fieldErrors: { idempotencyKey: ['Clé de 8 à 128 caractères.'] } });
    }
    return (await this.run({ ...scope, key }, body, work)).body;
  }

  /**
   * Exécute `work` sous protection d'idempotence. Retourne soit le résultat frais, soit la réponse
   * enregistrée lors de la première exécution.
   */
  async run<T>(
    scope: IdempotencyScope,
    body: unknown,
    work: () => Promise<{ status: number; body: T; resourceId?: string }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    const requestHash = this.hashBody(body);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + RETENTION_HOURS * 3600 * 1000);

    let record;
    try {
      record = await this.prisma.client.idempotencyRecord.create({
        data: { ...scope, requestHash, status: 'EN_COURS', expiresAt },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.client.idempotencyRecord.findUnique({
          where: { organizationId_userId_operation_key: scope },
        });
        if (!existing) throw error;
        if (existing.requestHash !== requestHash) {
          throw new ConflictError(
            ErrorCodes.IDEMPOTENCE_CORPS_DIFFERENT,
            'Cette clé d’idempotence a déjà été utilisée avec un contenu différent.',
          );
        }
        if (existing.status === 'EN_COURS') {
          throw new ConflictError(ErrorCodes.IDEMPOTENCE_EN_COURS, 'Une requête identique est déjà en cours de traitement.');
        }
        return { status: existing.responseStatus ?? 200, body: existing.responseBody as T, replayed: true };
      }
      throw error;
    }

    try {
      const result = await work();
      await this.prisma.client.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: 'TERMINE',
          responseStatus: result.status,
          responseBody: result.body as Prisma.InputJsonValue,
          resourceId: result.resourceId ?? null,
        },
      });
      return { status: result.status, body: result.body, replayed: false };
    } catch (error) {
      // L'opération a échoué : la clé redevient disponible pour une nouvelle tentative.
      await this.prisma.client.idempotencyRecord.delete({ where: { id: record.id } }).catch(() => undefined);
      throw error;
    }
  }

  async purgeExpired(tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: this.clock.now() } } });
    return result.count;
  }
}

/** Sérialisation JSON déterministe (clés triées) pour l'empreinte du corps. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
