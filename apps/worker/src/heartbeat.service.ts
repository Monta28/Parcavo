import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { APP_ENV, Clock, PrismaService, type AppEnv } from '@parc-auto/api';

/** Période du battement : l'API considère le worker absent au-delà de 5 minutes (/health/ready). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Battement du worker (CDC 14.4, 16.3) : une ligne WorkerHeartbeat par processus, mise à jour
 * périodiquement ; l'API la lit pour son contrôle de disponibilité. Aucune donnée métier.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  readonly workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  private timer: NodeJS.Timeout | null = null;
  private startedAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      this.beat().catch((error: unknown) => this.logger.error(`Battement en échec : ${error instanceof Error ? error.message : String(error)}`));
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Enregistre un battement (création au premier appel). */
  async beat(): Promise<Date> {
    const now = this.clock.now();
    this.startedAt ??= now;
    await this.prisma.client.workerHeartbeat.upsert({
      where: { workerId: this.workerId },
      create: { workerId: this.workerId, hostname: hostname(), startedAt: this.startedAt, lastBeatAt: now, appVersion: this.env.appVersion },
      update: { lastBeatAt: now },
    });
    return now;
  }
}
