import { Injectable } from '@nestjs/common';
import { Clock, PrismaService } from '@parc-auto/api';
import { HeartbeatService } from '../heartbeat.service.js';

export interface LeaseState {
  name: string;
  holder: string;
  acquiredAt: Date;
  expiresAt: Date;
  heartbeatAt: Date;
}

/**
 * Élection par bail PostgreSQL (CDC 9.4, 14.4 ; table JobLease) : un seul worker actif par tâche. Le bail
 * est pris ou renouvelé par une instruction unique (INSERT … ON CONFLICT DO UPDATE … WHERE) : il revient à
 * son titulaire tant qu'il le renouvelle, et à un autre worker dès qu'il a expiré (arrêt, panne). Le
 * titulaire est l'identifiant du processus publié par le battement.
 */
@Injectable()
export class JobLeaseService {
  private readonly held = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly heartbeat: HeartbeatService,
  ) {}

  get holderId(): string {
    return this.heartbeat.workerId;
  }

  /** Prend ou renouvelle le bail `name` pour `ttlMs` ; faux s'il est détenu par un autre worker non expiré. */
  async acquire(name: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const rows = await this.prisma.client.$queryRaw<Array<{ holder: string }>>`
      INSERT INTO "JobLease" ("name", "holder", "acquiredAt", "expiresAt", "heartbeatAt")
      VALUES (${name}, ${this.holderId}, ${now}, ${expiresAt}, ${now})
      ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "acquiredAt" = CASE WHEN "JobLease"."holder" = EXCLUDED."holder" THEN "JobLease"."acquiredAt" ELSE EXCLUDED."acquiredAt" END,
          "expiresAt" = EXCLUDED."expiresAt",
          "heartbeatAt" = EXCLUDED."heartbeatAt"
      WHERE "JobLease"."holder" = EXCLUDED."holder" OR "JobLease"."expiresAt" <= EXCLUDED."heartbeatAt"
      RETURNING "holder"`;
    const acquired = rows.length === 1 && rows[0]?.holder === this.holderId;
    if (acquired) this.held.add(name);
    else this.held.delete(name);
    return acquired;
  }

  async state(name: string): Promise<LeaseState | null> {
    return this.prisma.client.jobLease.findUnique({ where: { name } });
  }

  /** Baux détenus par ce processus (d'après ses dernières prises). */
  heldLeases(): string[] {
    return [...this.held];
  }

  /** Libère les baux détenus (arrêt propre) : un autre worker peut les reprendre immédiatement. */
  async releaseAll(): Promise<number> {
    const names = this.heldLeases();
    if (names.length === 0) return 0;
    const now = this.clock.now();
    const result = await this.prisma.client.jobLease.updateMany({ where: { name: { in: names }, holder: this.holderId }, data: { expiresAt: now, heartbeatAt: now } });
    this.held.clear();
    return result.count;
  }
}
