import { Injectable } from '@nestjs/common';
import { Prisma } from '@parc-auto/db';
import { Decimal } from 'decimal.js';
import { isSensitiveAuditKey } from '../common/audit-redaction.js';
import type { RequestContext } from '../common/request-context.js';
import { PrismaService, type Tx } from './prisma.service.js';

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  companyId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Journal d'audit (CDC 16.1) : acteur, date, objet, motif et valeurs avant/après expurgées.
 * Les mots de passe, jetons et secrets ne sont jamais écrits. Table append-only (trigger SQL).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: RequestContext, entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma.client;
    await client.auditEvent.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: entry.companyId ?? null,
        actorType: 'UTILISATEUR',
        actorUserId: ctx.userId,
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId ?? null,
        reason: entry.reason ?? null,
        before: redact(entry.before) as Prisma.InputJsonValue | undefined,
        after: redact(entry.after) as Prisma.InputJsonValue | undefined,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      },
    });
  }

  /** Audit d'un traitement système (worker, CLI) rattaché à une organisation. */
  async recordSystem(organizationId: string, entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma.client;
    await client.auditEvent.create({
      data: {
        organizationId,
        companyId: entry.companyId ?? null,
        actorType: 'SYSTEME',
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId ?? null,
        reason: entry.reason ?? null,
        before: redact(entry.before) as Prisma.InputJsonValue | undefined,
        after: redact(entry.after) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

export function redact(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal || value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Règle de clés unique, partagée avec la lecture défensive de GET /audit (common/audit-redaction.ts).
      if (isSensitiveAuditKey(k)) {
        out[k] = '[expurgé]';
      } else if (Buffer.isBuffer(v)) {
        out[k] = '[binaire]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
