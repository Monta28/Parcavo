import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';

const DAY_MS = 86_400_000;

export interface TelemetryPurgeResult {
  /** Échantillons carburant supprimés (au-delà de telemetry.fuelSampleRetentionDays). */
  fuelSamples: number;
  /** Échantillons d'odomètre supprimés (au-delà de telemetry.odometerSampleRetentionDays). */
  odometerSamples: number;
  /** Partitions mensuelles entièrement expirées supprimées (toutes organisations). */
  droppedPartitions: number;
}

/**
 * Purge des échantillons télématiques (CDC 8.5, 17.1, 17.2 ; D-174, D-239, D-319) pour le worker :
 * échantillons carburant au-delà de telemetry.fuelSampleRetentionDays (90 j) et échantillons bruts
 * d'odomètre au-delà de telemetry.odometerSampleRetentionDays (90 j), par organisation ; puis
 * suppression des partitions mensuelles entièrement antérieures à la rétention la plus longue.
 * Les relevés (OdometerReading) et les événements carburant (FuelEvent) ne sont jamais purgés.
 * Idempotente : un second passage ne supprime plus rien.
 */
@Injectable()
export class TelemetryPurgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async purgeSamples(now: Date = this.clock.now()): Promise<TelemetryPurgeResult> {
    const organizations = await this.prisma.client.organization.findMany({ select: { id: true } });
    let fuelSamples = 0;
    let odometerSamples = 0;
    let longestFuel = 0;
    let longestOdometer = 0;
    for (const org of organizations) {
      const [fuelDays, odometerDays] = await Promise.all([this.settings.get(org.id, 'telemetry.fuelSampleRetentionDays'), this.settings.get(org.id, 'telemetry.odometerSampleRetentionDays')]);
      longestFuel = Math.max(longestFuel, fuelDays);
      longestOdometer = Math.max(longestOdometer, odometerDays);
      fuelSamples += (await this.prisma.client.fuelLevelSample.deleteMany({ where: { organizationId: org.id, observedAt: { lt: new Date(now.getTime() - fuelDays * DAY_MS) } } })).count;
      odometerSamples += (await this.prisma.client.telemetryOdometerSample.deleteMany({ where: { organizationId: org.id, observedAt: { lt: new Date(now.getTime() - odometerDays * DAY_MS) } } })).count;
    }
    let droppedPartitions = 0;
    if (organizations.length > 0) {
      droppedPartitions += await this.dropPartitionsBefore('FuelLevelSample', new Date(now.getTime() - longestFuel * DAY_MS));
      droppedPartitions += await this.dropPartitionsBefore('TelemetryOdometerSample', new Date(now.getTime() - longestOdometer * DAY_MS));
    }
    return { fuelSamples, odometerSamples, droppedPartitions };
  }

  /** Partitions mensuelles entièrement antérieures à la date (fonction SQL drop_month_partitions_before). */
  private async dropPartitionsBefore(table: 'FuelLevelSample' | 'TelemetryOdometerSample', before: Date): Promise<number> {
    const day = before.toISOString().slice(0, 10);
    const rows = await this.prisma.client.$queryRaw<Array<{ dropped: number }>>`SELECT drop_month_partitions_before(${table}, ${day}::date) AS dropped`;
    return Number(rows[0]?.dropped ?? 0);
  }
}
