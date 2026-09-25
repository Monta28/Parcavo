import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import { Clock, PrismaService, describeErrorSafely } from '@parc-auto/api';

export interface ScheduledRunInput {
  /** Type du job enregistré (ex. planifie.alertes-rattrapage). */
  type: string;
  /** Clé du créneau : une exécution au plus par clé. */
  dedupeKey: string;
  organizationId: string | null;
  holder: string;
  /** Durée au-delà de laquelle une exécution restée EN_COURS est réputée interrompue (worker arrêté). */
  staleAfterMs: number;
}

export type ScheduledRunOutcome<T> = { status: 'TERMINE'; jobId: string; result: T } | { status: 'ECHEC'; jobId: string; error: string } | { status: 'DEJA_FAIT'; jobId: string | null };

/**
 * Exécution idempotente d'un créneau planifié, tracée dans la file Job (CDC 14.1, D-254) : une ligne par
 * créneau (clé de déduplication), avec statut exact, résumé et erreur expurgée. Un créneau déjà traité
 * n'est jamais rejoué ; une exécution interrompue par un arrêt est marquée ABANDONNE puis reprise.
 */
@Injectable()
export class ScheduledRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async runOnce<T extends Prisma.InputJsonValue>(input: ScheduledRunInput, work: () => Promise<T>): Promise<ScheduledRunOutcome<T>> {
    const now = this.clock.now();
    const existing = await this.prisma.client.job.findFirst({ where: { dedupeKey: input.dedupeKey }, orderBy: { createdAt: 'desc' } });
    if (existing) {
      const interrupted = existing.status === 'EN_COURS' && existing.finishedAt === null && existing.lockedUntil !== null && existing.lockedUntil.getTime() <= now.getTime();
      if (!interrupted) return { status: 'DEJA_FAIT', jobId: existing.id };
      await this.prisma.client.job.updateMany({
        where: { id: existing.id, finishedAt: null },
        data: { status: 'ABANDONNE', finishedAt: now, lockedBy: null, lockedUntil: null, lastError: 'Exécution interrompue (arrêt du worker) : créneau repris.', updatedAt: now },
      });
    }
    let jobId: string;
    try {
      const job = await this.prisma.client.job.create({
        data: {
          organizationId: input.organizationId,
          type: input.type,
          payload: { dedupeKey: input.dedupeKey },
          dedupeKey: input.dedupeKey,
          status: 'EN_COURS',
          attempts: 1,
          maxAttempts: 1,
          runAt: now,
          lockedBy: input.holder,
          lockedUntil: new Date(now.getTime() + input.staleAfterMs),
          createdAt: now,
          updatedAt: now,
        },
      });
      jobId = job.id;
    } catch (error) {
      // Index unique partiel (clé active) : un autre worker exécute déjà ce créneau.
      if ((error as { code?: string }).code === 'P2002') return { status: 'DEJA_FAIT', jobId: null };
      throw error;
    }
    try {
      const result = await work();
      const finishedAt = this.clock.now();
      await this.prisma.client.job.update({ where: { id: jobId }, data: { status: 'TERMINE', progress: 100, result, lastError: null, finishedAt, lockedBy: null, lockedUntil: null, updatedAt: finishedAt } });
      return { status: 'TERMINE', jobId, result };
    } catch (error) {
      const message = describeErrorSafely(error);
      const finishedAt = this.clock.now();
      await this.prisma.client.job.update({ where: { id: jobId }, data: { status: 'ECHEC', lastError: message, finishedAt, lockedBy: null, lockedUntil: null, updatedAt: finishedAt } });
      return { status: 'ECHEC', jobId, error: message };
    }
  }
}
