import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma.service.js';

/** Bail d'exécution d'un couple fournisseur-société (D-296). */
export function syncLeaseName(providerId: string, companyId: string): string {
  return `telemetry-sync:${providerId}:${companyId}`;
}

/** Bail de la liste des unités d'un fournisseur (au plus une par heure, D-296). */
export function discoveryLeaseName(providerId: string): string {
  return `telemetry-units:${providerId}`;
}

/**
 * Baux PostgreSQL de la synchronisation télématique (table JobLease, CDC 14.4) : une instruction unique
 * INSERT … ON CONFLICT DO UPDATE … WHERE prend le bail s'il est libre ou expiré, ou le renouvelle pour
 * son titulaire. Plusieurs répliques de worker (et l'API pour une synchronisation manuelle) peuvent
 * coexister : un seul run par couple fournisseur-société à la fois. Les instants viennent de l'horloge
 * injectée (jamais de now() SQL) pour rester contrôlables en test.
 */
@Injectable()
export class TelemetryLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  /** Prend ou renouvelle le bail ; faux s'il est détenu par un autre titulaire non expiré. */
  async acquire(name: string, holder: string, ttlMs: number, now: Date): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + ttlMs);
    const rows = await this.prisma.client.$queryRaw<Array<{ holder: string }>>`
      INSERT INTO "JobLease" ("name", "holder", "acquiredAt", "expiresAt", "heartbeatAt")
      VALUES (${name}, ${holder}, ${now}, ${expiresAt}, ${now})
      ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "acquiredAt" = CASE WHEN "JobLease"."holder" = EXCLUDED."holder" THEN "JobLease"."acquiredAt" ELSE EXCLUDED."acquiredAt" END,
          "expiresAt" = EXCLUDED."expiresAt",
          "heartbeatAt" = EXCLUDED."heartbeatAt"
      WHERE "JobLease"."holder" = EXCLUDED."holder" OR "JobLease"."expiresAt" <= EXCLUDED."heartbeatAt"
      RETURNING "holder"`;
    return rows.length === 1 && rows[0]?.holder === holder;
  }

  /** Libère le bail détenu (fin de run) : un autre titulaire peut le prendre immédiatement. */
  async release(name: string, holder: string, now: Date): Promise<void> {
    await this.prisma.client.jobLease.updateMany({ where: { name, holder }, data: { expiresAt: now, heartbeatAt: now } });
  }

  /** Vrai si un titulaire détient encore le bail à cet instant. */
  async isHeld(name: string, now: Date): Promise<boolean> {
    const lease = await this.prisma.client.jobLease.findUnique({ where: { name }, select: { expiresAt: true } });
    return lease !== null && lease.expiresAt.getTime() > now.getTime();
  }
}
