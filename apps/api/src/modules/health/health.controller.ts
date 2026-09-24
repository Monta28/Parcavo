import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { stat } from 'node:fs/promises';
import { Clock } from '../../common/clock.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { Public } from '../auth/auth.decorators.js';

interface ReadinessReport {
  status: 'pret' | 'degrade';
  checks: Record<string, { ok: boolean; detail: string }>;
  checkedAt: string;
}

const WORKER_STALE_MS = 5 * 60 * 1000;

/**
 * Santé (CDC 16.3) : /health/live = processus vivant ; /health/ready = base joignable, stockage
 * accessible, battement du worker récent. Aucun secret exposé.
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
  @ApiOperation({ summary: 'Processus vivant.' })
  live(): { status: 'vivant' } {
    return { status: 'vivant' };
  }

  @Get('ready')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Service prêt : base, stockage et worker.' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const checks: ReadinessReport['checks'] = {};
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      checks['database'] = { ok: true, detail: 'connexion établie' };
    } catch {
      checks['database'] = { ok: false, detail: 'base de données injoignable' };
    }
    try {
      await stat(this.env.storageDir);
      checks['storage'] = { ok: true, detail: 'répertoire accessible' };
    } catch {
      checks['storage'] = { ok: false, detail: 'répertoire de stockage inaccessible' };
    }
    try {
      const beat = await this.prisma.client.workerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' } });
      const fresh = beat !== null && this.clock.now().getTime() - beat.lastBeatAt.getTime() < WORKER_STALE_MS;
      checks['worker'] = {
        ok: fresh,
        detail: beat ? `dernier battement ${beat.lastBeatAt.toISOString()}` : 'aucun battement enregistré',
      };
    } catch {
      checks['worker'] = { ok: false, detail: 'battement du worker illisible' };
    }
    const essential = checks['database']?.ok === true && checks['storage']?.ok === true;
    const status: ReadinessReport['status'] = essential ? 'pret' : 'degrade';
    if (!essential) res.status(503);
    return { status, checks, checkedAt: this.clock.now().toISOString() };
  }
}
