import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { Clock } from '../../common/clock.js';
import { WORKER_HEARTBEAT_STALE_MS, workerHeartbeatFreshness } from '../../domain/worker-heartbeat.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { Public } from '../auth/auth.decorators.js';
import { LivenessDto, ReadinessCheckDto, ReadinessReportDto, WorkerHealthDto } from './dto/health.dto.js';

/**
 * Délai maximal de chaque contrôle de santé : une base qui ne répond plus (réseau bloqué, serveur figé) rend
 * le composant indisponible (503) au lieu de suspendre la réponse, que la supervision doit recevoir à temps.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/** Résultat du contrôle, ou `onTimeout` s'il n'a pas abouti dans le délai (le contrôle ne lève jamais). */
async function withinDeadline<T>(check: Promise<T>, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), HEALTH_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const TIMEOUT_SUFFIX = `(plus de ${HEALTH_CHECK_TIMEOUT_MS / 1000} s)`;

/**
 * Santé (CDC 16.3, D-315) : /health/live = processus vivant ; /health/ready = service prêt (base et
 * stockage, 503 sinon ; battement du worker en information) ; /health/worker = battement du worker
 * récent (503 sinon). Les trois routes sont publiques pour la supervision extérieure au serveur et
 * n'exposent aucun secret (ni URL de base, ni chemin, ni hôte, ni version).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Processus vivant (sans dépendance).' })
  @ApiOkResponse({ type: LivenessDto })
  live(): LivenessDto {
    return { status: 'vivant' };
  }

  @Get('ready')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Service prêt : base et stockage (503 sinon) ; battement du worker en information.' })
  @ApiOkResponse({ type: ReadinessReportDto, description: 'Base et stockage accessibles (statut « pret »).' })
  @ApiServiceUnavailableResponse({ type: ReadinessReportDto, description: 'Base ou stockage inaccessible (statut « degrade »).' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReportDto> {
    const [database, storage, worker] = await Promise.all([this.database(), this.storage(), this.worker()]);
    const checks: Record<string, ReadinessCheckDto> = { database, storage, worker: { ok: worker.status === 'actif', detail: worker.detail } };
    const essential = database.ok && storage.ok;
    if (!essential) res.status(503);
    return { status: essential ? 'pret' : 'degrade', checks, checkedAt: this.clock.now().toISOString() };
  }

  @Get('worker')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Battement du worker : 200 si un battement date de deux minutes au plus, 503 sinon.' })
  @ApiOkResponse({ type: WorkerHealthDto, description: 'Worker actif.' })
  @ApiServiceUnavailableResponse({ type: WorkerHealthDto, description: 'Worker arrêté (aucun battement récent) ou battement illisible.' })
  async workerHealth(@Res({ passthrough: true }) res: Response): Promise<WorkerHealthDto> {
    const report = await this.worker();
    if (report.status !== 'actif') res.status(503);
    return report;
  }

  /** Base joignable et inscriptible (pas un serveur en lecture seule), dans le délai des contrôles. */
  private database(): Promise<ReadinessCheckDto> {
    return withinDeadline(this.databaseCheck(), { ok: false, detail: `base de données sans réponse ${TIMEOUT_SUFFIX}` });
  }

  private async databaseCheck(): Promise<ReadinessCheckDto> {
    try {
      const rows = await this.prisma.client.$queryRaw<Array<{ readOnly: boolean }>>`SELECT (pg_is_in_recovery() OR current_setting('transaction_read_only') = 'on') AS "readOnly"`;
      if (rows[0]?.readOnly) return { ok: false, detail: 'base de données en lecture seule' };
      return { ok: true, detail: 'connexion établie' };
    } catch {
      return { ok: false, detail: 'base de données injoignable' };
    }
  }

  /** Répertoire des pièces jointes présent, lisible et inscriptible par le processus, dans le délai des contrôles. */
  private storage(): Promise<ReadinessCheckDto> {
    return withinDeadline(this.storageCheck(), { ok: false, detail: `répertoire de stockage sans réponse ${TIMEOUT_SUFFIX}` });
  }

  private async storageCheck(): Promise<ReadinessCheckDto> {
    try {
      const info = await stat(this.env.storageDir);
      if (!info.isDirectory()) return { ok: false, detail: 'répertoire de stockage inaccessible' };
      await access(this.env.storageDir, constants.R_OK | constants.W_OK);
      return { ok: true, detail: 'répertoire accessible en lecture et en écriture' };
    } catch {
      return { ok: false, detail: 'répertoire de stockage inaccessible' };
    }
  }

  /** Dernier battement, tous processus worker confondus, évalué par la règle unique du domaine. */
  private async worker(): Promise<WorkerHealthDto> {
    const now = this.clock.now();
    const base = { staleAfterSeconds: WORKER_HEARTBEAT_STALE_MS / 1000, checkedAt: now.toISOString() };
    const unreadable = (detail: string): WorkerHealthDto => ({ ...base, status: 'inconnu', lastBeatAt: null, ageSeconds: null, detail });
    const TIMED_OUT = Symbol('délai dépassé');
    let lastBeatAt: Date | null;
    try {
      const beat = await withinDeadline<{ lastBeatAt: Date } | null | typeof TIMED_OUT>(this.prisma.client.workerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' }, select: { lastBeatAt: true } }), TIMED_OUT);
      if (beat === TIMED_OUT) return unreadable(`battement du worker illisible ${TIMEOUT_SUFFIX}`);
      lastBeatAt = beat?.lastBeatAt ?? null;
    } catch {
      return unreadable('battement du worker illisible');
    }
    const freshness = workerHeartbeatFreshness(lastBeatAt, now);
    const detail = !lastBeatAt
      ? 'aucun battement enregistré'
      : freshness.status === 'actif'
        ? `dernier battement ${lastBeatAt.toISOString()}`
        : `aucun battement depuis ${lastBeatAt.toISOString()} (plus de ${WORKER_HEARTBEAT_STALE_MS / 60_000} minutes)`;
    return { ...base, status: freshness.status, lastBeatAt: lastBeatAt?.toISOString() ?? null, ageSeconds: freshness.ageSeconds, detail };
  }
}
