import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_ENV, Clock, PrismaService, assertNoActiveSimulatorInProduction, describeErrorSafely, type AppEnv } from '@parc-auto/api';
import { AlertCatchUpJob } from '../jobs/alert-catch-up.job.js';
import { DailyDigestJob } from '../jobs/daily-digest.job.js';
import { DailyPurgeJob } from '../jobs/daily-purge.job.js';
import { DailyRetentionJob } from '../jobs/daily-retention.job.js';
import { JobQueueJob } from '../jobs/job-queue.job.js';
import { OutboxDispatcherJob } from '../jobs/outbox-dispatcher.job.js';
import type { ScheduledTask, TaskSummary } from '../jobs/scheduled-task.js';
import { TelemetrySyncJob } from '../jobs/telemetry-sync.job.js';
import { TelemetryWebhookJob } from '../jobs/telemetry-webhook.job.js';
import { WORKER_OPTIONS, type WorkerOptions } from '../worker-options.js';
import { JobLeaseService } from './job-lease.service.js';

export type TaskRunResult =
  | { task: string; status: 'EXECUTE'; summary: TaskSummary }
  | { task: string; status: 'ECHEC'; error: string }
  | { task: string; status: 'BAIL_DETENU_AILLEURS' }
  | { task: string; status: 'DEJA_EN_COURS' }
  | { task: string; status: 'ARRETE' };

/** Décalage entre les premiers déclenchements au démarrage (évite qu'ils partent tous à la même seconde). */
const STARTUP_STAGGER_MS = 1_000;

/**
 * Planificateur du worker (CDC 9.3, 9.4, 14.4) : chaque tâche est réveillée périodiquement et ne
 * s'exécute que si ce processus détient son bail JobLease (un seul worker actif par tâche, reprise par un
 * autre après expiration). Le bail est renouvelé pendant l'exécution. Chaque exécution journalise un
 * résumé chiffré, sans donnée personnelle ni secret. L'horloge est injectée.
 */
@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Planificateur');
  private readonly tasks: ReadonlyMap<string, ScheduledTask>;
  private readonly running = new Map<string, Promise<TaskRunResult>>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly leases: JobLeaseService,
    catchUp: AlertCatchUpJob,
    outbox: OutboxDispatcherJob,
    digest: DailyDigestJob,
    purge: DailyPurgeJob,
    jobQueue: JobQueueJob,
    telemetry: TelemetrySyncJob,
    retention: DailyRetentionJob,
    webhooks: TelemetryWebhookJob,
  ) {
    this.tasks = new Map<string, ScheduledTask>([catchUp, outbox, digest, purge, jobQueue, telemetry, webhooks, retention].map((t) => [t.name, t]));
  }

  taskNames(): string[] {
    return [...this.tasks.keys()];
  }

  /** Exécute la tâche si ce worker obtient son bail ; une seule exécution simultanée par tâche et par processus. */
  runTask(name: string): Promise<TaskRunResult> {
    const task = this.tasks.get(name);
    if (!task) return Promise.reject(new Error(`Tâche planifiée inconnue : ${name}`));
    if (this.stopped) return Promise.resolve({ task: name, status: 'ARRETE' });
    const current = this.running.get(name);
    if (current) return Promise.resolve({ task: name, status: 'DEJA_EN_COURS' });
    const execution = this.execute(task).finally(() => this.running.delete(name));
    this.running.set(name, execution);
    return execution;
  }

  /**
   * Démarrage : refus si un fournisseur SIMULATEUR est actif en production (D-303) — l'erreur interrompt la
   * création du contexte et le processus s'arrête —, puis armement des minuteurs.
   */
  async onApplicationBootstrap(): Promise<void> {
    await assertNoActiveSimulatorInProduction(this.prisma, this.env);
    if (!this.options.schedule) return;
    let offset = 0;
    for (const task of this.tasks.values()) {
      offset += STARTUP_STAGGER_MS;
      const first = setTimeout(() => void this.runTask(task.name), offset);
      const every = setInterval(() => void this.runTask(task.name), task.periodMs);
      // Le battement maintient le processus actif ; ces minuteurs ne le retiennent pas à l'arrêt.
      first.unref();
      every.unref();
      this.timers.push(first, every);
    }
    this.logger.log(`Planificateur armé (worker ${this.leases.holderId}) : ${this.taskNames().join(', ')}.`);
  }

  /** Arrêt propre : plus de déclenchement, attente des exécutions en cours, libération des baux. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    await Promise.allSettled([...this.running.values()]);
    const released = await this.leases.releaseAll();
    this.logger.log(`Planificateur arrêté : ${released} bail(aux) libéré(s).`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.clearTimers();
  }

  private async execute(task: ScheduledTask): Promise<TaskRunResult> {
    let acquired: boolean;
    try {
      acquired = await this.leases.acquire(task.name, task.leaseMs);
    } catch (error) {
      const message = describeErrorSafely(error);
      this.logger.error(`Tâche « ${task.name} » : bail indisponible (${message}).`);
      return { task: task.name, status: 'ECHEC', error: message };
    }
    if (!acquired) return { task: task.name, status: 'BAIL_DETENU_AILLEURS' };
    const renewal = setInterval(() => {
      this.leases.acquire(task.name, task.leaseMs).then(
        (kept) => {
          if (!kept) this.logger.warn(`Tâche « ${task.name} » : bail repris par un autre worker pendant l’exécution.`);
        },
        (error: unknown) => this.logger.error(`Tâche « ${task.name} » : renouvellement du bail en échec (${describeErrorSafely(error)}).`),
      );
    }, Math.max(1_000, Math.floor(task.leaseMs / 3)));
    renewal.unref();
    const started = performance.now();
    try {
      const summary = await task.run(this.clock.now());
      this.logger.log(`Tâche « ${task.name} » exécutée en ${Math.round(performance.now() - started)} ms : ${JSON.stringify(summary)}`);
      return { task: task.name, status: 'EXECUTE', summary };
    } catch (error) {
      const message = describeErrorSafely(error);
      this.logger.error(`Tâche « ${task.name} » en échec : ${message}`);
      return { task: task.name, status: 'ECHEC', error: message };
    } finally {
      clearInterval(renewal);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
