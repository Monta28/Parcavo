import { Injectable, Logger } from '@nestjs/common';
import type { Job, Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { AppError } from '../../common/errors.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';

/**
 * Traitement différé d'un type de job. `progress` enregistre l'avancement (0 à 100) tant que le job est
 * verrouillé par ce worker ; la valeur renvoyée devient `Job.result`.
 */
export interface JobHandler {
  readonly type: string;
  handle(job: Job, progress: (percent: number) => Promise<void>): Promise<Prisma.InputJsonValue>;
}

/** Échec définitif, sans nouvelle tentative (droits retirés, demandeur désactivé…) : job ABANDONNE. */
export class JobAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobAbortedError';
  }
}

export interface EnqueueJobInput {
  organizationId: string | null;
  type: string;
  payload: Prisma.InputJsonValue;
  requestedById?: string | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
  runAt?: Date;
}

export interface JobRunOutcome {
  jobId: string;
  type: string;
  status: 'TERMINE' | 'EN_ATTENTE' | 'ECHEC' | 'ABANDONNE';
  error: string | null;
}

/** Durée du verrou d'un job en cours : au-delà, un autre worker peut le reprendre. */
export const DEFAULT_JOB_LEASE_MS = 10 * 60 * 1000;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * File de jobs en PostgreSQL, sans Redis (CDC 14.1, 17.2) : mise en file, réservation concurrente sûre
 * (SELECT … FOR UPDATE SKIP LOCKED + verrou temporel lockedUntil), exécution par type, progression,
 * tentatives bornées avec délai croissant. Un job dont le verrou a expiré (worker arrêté) est repris.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async enqueue(input: EnqueueJobInput, tx?: Tx): Promise<Job> {
    const client = tx ?? this.prisma.client;
    const now = this.clock.now();
    return client.job.create({
      data: {
        organizationId: input.organizationId,
        type: input.type,
        payload: input.payload,
        requestedById: input.requestedById ?? null,
        dedupeKey: input.dedupeKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        runAt: input.runAt ?? now,
        createdAt: now,
      },
    });
  }

  async get(jobId: string): Promise<Job | null> {
    return this.prisma.client.job.findUnique({ where: { id: jobId } });
  }

  /**
   * Réserve le prochain job exécutable d'un des types donnés : EN_ATTENTE échu, ou EN_COURS dont le verrou a
   * expiré. Instruction unique (UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)) : deux workers ne
   * réservent jamais le même job.
   */
  async claimNext(workerId: string, types: readonly string[], leaseMs = DEFAULT_JOB_LEASE_MS): Promise<Job | null> {
    if (types.length === 0) return null;
    const now = this.clock.now();
    const lockedUntil = new Date(now.getTime() + leaseMs);
    const claimed = await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job"
      SET "status" = 'EN_COURS', "lockedBy" = ${workerId}, "lockedUntil" = ${lockedUntil}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "Job"
        WHERE "type" = ANY(${[...types]}::text[])
          AND "finishedAt" IS NULL
          AND (("status" = 'EN_ATTENTE' AND "runAt" <= ${now}) OR ("status" = 'EN_COURS' AND "lockedUntil" < ${now}))
        ORDER BY "runAt" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    const id = claimed[0]?.id;
    return id ? this.prisma.client.job.findUnique({ where: { id } }) : null;
  }

  /** Avancement (0 à 100), enregistré seulement si le job est toujours verrouillé par ce worker. */
  async reportProgress(jobId: string, workerId: string, percent: number): Promise<void> {
    const progress = Math.max(0, Math.min(99, Math.round(percent)));
    const now = this.clock.now();
    await this.prisma.client.job.updateMany({ where: { id: jobId, lockedBy: workerId, status: 'EN_COURS' }, data: { progress, updatedAt: now } });
  }

  /**
   * Réserve et exécute un job parmi les types pris en charge. Renvoie null si aucun job n'est exécutable.
   * Succès : TERMINE (résultat, progression 100). Échec : nouvel essai différé tant que maxAttempts n'est pas
   * atteint, sinon ECHEC ; un JobAbortedError termine immédiatement le job (ABANDONNE).
   */
  async runOne(handlers: readonly JobHandler[], workerId = `worker-${process.pid}`): Promise<JobRunOutcome | null> {
    const byType = new Map(handlers.map((h) => [h.type, h] as const));
    const job = await this.claimNext(workerId, [...byType.keys()]);
    if (!job) return null;
    const handler = byType.get(job.type);
    if (!handler) return this.finishFailure(job, workerId, new JobAbortedError(`Aucun gestionnaire pour le type « ${job.type} ».`));
    if (job.attempts > job.maxAttempts) return this.finishFailure(job, workerId, new JobAbortedError('Nombre maximal de tentatives atteint.'));
    try {
      const result = await handler.handle(job, (percent) => this.reportProgress(job.id, workerId, percent));
      const now = this.clock.now();
      await this.prisma.client.job.updateMany({
        where: { id: job.id, lockedBy: workerId },
        data: { status: 'TERMINE', progress: 100, result, lastError: null, finishedAt: now, lockedBy: null, lockedUntil: null, updatedAt: now },
      });
      return { jobId: job.id, type: job.type, status: 'TERMINE', error: null };
    } catch (error) {
      return this.finishFailure(job, workerId, error);
    }
  }

  private async finishFailure(job: Job, workerId: string, error: unknown): Promise<JobRunOutcome> {
    const now = this.clock.now();
    const message = safeErrorMessage(error);
    const aborted = error instanceof JobAbortedError;
    if (!aborted && !(error instanceof AppError)) this.logger.error(`Job ${job.id} (${job.type}) en échec : ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    const final = aborted || job.attempts >= job.maxAttempts;
    const status = aborted ? 'ABANDONNE' : final ? 'ECHEC' : 'EN_ATTENTE';
    const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, job.attempts - 1));
    await this.prisma.client.job.updateMany({
      where: { id: job.id, lockedBy: workerId },
      data: {
        status,
        lastError: message,
        lockedBy: null,
        lockedUntil: null,
        updatedAt: now,
        ...(final ? { finishedAt: now } : { runAt: new Date(now.getTime() + delay) }),
      },
    });
    return { jobId: job.id, type: job.type, status, error: message };
  }
}

/** Message d'erreur conservé sur le job : message métier français ou libellé générique (jamais de secret). */
function safeErrorMessage(error: unknown): string {
  if (error instanceof JobAbortedError || error instanceof AppError) return error.message.slice(0, 500);
  return 'Erreur technique pendant le traitement ; une nouvelle tentative sera effectuée si possible.';
}
