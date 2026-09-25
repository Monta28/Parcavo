import { Module } from '@nestjs/common';
import { TelemetryAdapterRegistry } from './telemetry-adapter.registry.js';
import { TelemetryAlertsService } from './telemetry-alerts.service.js';
import { TelemetryController } from './telemetry.controller.js';
import { TelemetryCredentialsService } from './telemetry-credentials.service.js';
import { TelemetryFuelThresholdsService } from './telemetry-fuel-thresholds.service.js';
import { TelemetryProvidersService } from './telemetry-providers.service.js';
import { TelemetryUnitsService } from './telemetry-units.service.js';
import { TelemetryVehicleController } from './telemetry-vehicle.controller.js';
import { TelemetryVehicleService } from './telemetry-vehicle.service.js';
import { TelemetryWebhookController } from './webhook/telemetry-webhook.controller.js';
import { TelemetryWebhookService } from './webhook/telemetry-webhook.service.js';

/**
 * Module F11 — cœur du connecteur télématique (CDC 14.3 à 14.6) : registre des adaptateurs, configuration
 * des fournisseurs et secrets, activation par société, unités et associations, réception des lots webhook
 * signés (dépôt en file uniquement, D-298). L'application fonctionne
 * entièrement sans lui : aucun appel externe tant qu'aucune société n'active le module (17.1).
 */
@Module({
  controllers: [TelemetryController, TelemetryVehicleController, TelemetryWebhookController],
  providers: [TelemetryCredentialsService, TelemetryAdapterRegistry, TelemetryAlertsService, TelemetryProvidersService, TelemetryUnitsService, TelemetryVehicleService, TelemetryFuelThresholdsService, TelemetryWebhookService],
  exports: [TelemetryCredentialsService, TelemetryAdapterRegistry, TelemetryAlertsService, TelemetryProvidersService, TelemetryUnitsService],
})
export class TelemetryModule {}
