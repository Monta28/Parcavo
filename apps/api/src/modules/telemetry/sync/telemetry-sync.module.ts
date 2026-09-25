import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry.module.js';
import { TelemetryCalibrationService } from './telemetry-calibration.service.js';
import { TelemetryFuelService } from './telemetry-fuel.service.js';
import { TelemetryLeaseService } from './telemetry-lease.service.js';
import { TelemetryOdometerSyncService } from './telemetry-odometer-sync.service.js';
import { TelemetryPurgeService } from './telemetry-purge.service.js';
import { TelemetrySilenceService } from './telemetry-silence.service.js';
import { TelemetrySyncController } from './telemetry-sync.controller.js';
import { TelemetrySyncService } from './telemetry-sync.service.js';

/**
 * Module F11 — moteur de synchronisation et d'ingestion (CDC 5.6, 8.5, 14.3, 14.4) : runs planifiés
 * (worker) et manuels, ingestion unique des relevés TELEMATICS, calibrage GPS, carburant, source muette,
 * purges. Sans société activée, aucun appel externe n'est fait et l'application fonctionne sans lui.
 */
@Module({
  imports: [TelemetryModule],
  controllers: [TelemetrySyncController],
  providers: [TelemetryLeaseService, TelemetryCalibrationService, TelemetryOdometerSyncService, TelemetryFuelService, TelemetrySilenceService, TelemetryPurgeService, TelemetrySyncService],
  exports: [TelemetrySyncService, TelemetryCalibrationService, TelemetryFuelService, TelemetrySilenceService, TelemetryPurgeService],
})
export class TelemetrySyncModule {}
