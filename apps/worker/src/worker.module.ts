import { type DynamicModule, Module } from '@nestjs/common';
import { AccessControlModule, AuthModule, FEATURE_MODULES, InfraModule, type AppEnv, type Clock } from '@parc-auto/api';
import { HeartbeatService } from './heartbeat.service.js';
import { AlertCatchUpJob } from './jobs/alert-catch-up.job.js';
import { DailyDigestJob } from './jobs/daily-digest.job.js';
import { DailyPurgeJob } from './jobs/daily-purge.job.js';
import { DailyRetentionJob } from './jobs/daily-retention.job.js';
import { JobQueueJob } from './jobs/job-queue.job.js';
import { OutboxDispatcherJob } from './jobs/outbox-dispatcher.job.js';
import { TelemetrySyncJob } from './jobs/telemetry-sync.job.js';
import { TelemetryWebhookJob } from './jobs/telemetry-webhook.job.js';
import { JobLeaseService } from './scheduler/job-lease.service.js';
import { ScheduledRunsService } from './scheduler/scheduled-runs.service.js';
import { WorkerScheduler } from './scheduler/worker-scheduler.service.js';
import { WORKER_OPTIONS, type WorkerOptions } from './worker-options.js';

export interface WorkerModuleOptions {
  env?: AppEnv;
  clock?: Clock;
  /** Armement des minuteurs au démarrage (défaut : vrai). */
  schedule?: boolean;
}

/**
 * Module du worker : réutilise les modules NestJS de l'API (infrastructure, contrôle d'accès et modules
 * métier de FEATURE_MODULES) sans serveur HTTP ni garde de requête (CDC 14.1), et y ajoute le battement,
 * l'élection par bail et les traitements planifiés (rattrapage des alertes, outbox e-mail,
 * récapitulatif quotidien, purge, file de jobs d'export, synchronisation télématique, lots webhook, rétention).
 */
@Module({})
export class WorkerModule {
  static register(options: WorkerModuleOptions = {}): DynamicModule {
    const workerOptions: WorkerOptions = { schedule: options.schedule ?? true };
    return {
      module: WorkerModule,
      imports: [InfraModule.forRoot(options.env, options.clock), AccessControlModule, AuthModule, ...FEATURE_MODULES],
      providers: [{ provide: WORKER_OPTIONS, useValue: workerOptions }, HeartbeatService, JobLeaseService, ScheduledRunsService, AlertCatchUpJob, OutboxDispatcherJob, DailyDigestJob, DailyPurgeJob, JobQueueJob, TelemetrySyncJob, TelemetryWebhookJob, DailyRetentionJob, WorkerScheduler],
      exports: [HeartbeatService, JobLeaseService, WorkerScheduler, AlertCatchUpJob, OutboxDispatcherJob, DailyDigestJob, DailyPurgeJob, JobQueueJob, TelemetrySyncJob, TelemetryWebhookJob, DailyRetentionJob],
    };
  }
}
