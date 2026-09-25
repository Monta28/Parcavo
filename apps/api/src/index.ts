// Surface réutilisée par le worker (CDC 14.1 : le worker réutilise les modules NestJS de l'API).
export { AppModule, FEATURE_MODULES, type AppModuleOptions } from './app.module.js';
export { createApp } from './bootstrap.js';
export { Clock, FixedClock, SystemClock } from './common/clock.js';
export { APP_ENV, loadEnv, type AppEnv } from './infra/env.js';
export { InfraModule } from './infra/infra.module.js';
export { PrismaService } from './infra/prisma.service.js';
export { AuditService } from './infra/audit.service.js';
export { ObjectStorage } from './infra/storage.service.js';
export { AttachmentsService } from './modules/attachments/attachments.service.js';
export { SessionService } from './modules/auth/session.service.js';
export { AlertsCoreModule } from './modules/alerts/alerts-core.module.js';
export { AlertsService } from './modules/alerts/alerts.service.js';
export { NotificationsModule } from './modules/notifications/notifications.module.js';
export { NotificationsService, type DailyDigestResult, type DeliveryDecision } from './modules/notifications/notifications.service.js';
export { redactDeliveryError } from './domain/notification-rules.js';
export { JobsModule } from './modules/jobs/jobs.module.js';
export { JobsService, JobAbortedError, type JobHandler, type JobRunOutcome } from './modules/jobs/jobs.service.js';
export { ReportsModule } from './modules/reports/reports.module.js';
export { ReportExportJobHandler } from './modules/reports/export/report-export.job-handler.js';
export { REPORT_EXPORT_JOB } from './modules/reports/export/report-export.service.js';
export { ImportRetentionService, IMPORT_ABANDON_AFTER_DAYS, IMPORT_DATA_RETENTION_DAYS, type ImportRetentionResult } from './modules/imports/import-retention.service.js';
// Worker : traitements planifiés (rattrapage des alertes, outbox e-mail, récapitulatif, purge) et transfert.
export { AccessControlModule } from './modules/access-control/access-control.module.js';
export { AuthModule } from './modules/auth/auth.module.js';
export { IdempotencyService } from './common/idempotency.service.js';
export { describeErrorSafely } from './common/secret-redaction.js';
export { localDate } from './domain/civil-date.js';
export { WORKER_HEARTBEAT_STALE_MS, workerHeartbeatFreshness } from './domain/worker-heartbeat.js';
export { OUTBOX_DEFAULT_MAX_ATTEMPTS, OUTBOX_LOCK_MS, OUTBOX_RETRY_DELAYS_MINUTES, outboxFailureOutcome, outboxLockUntil, outboxRetryDelayMinutes, type OutboxFailureOutcome } from './domain/outbox-retry.js';
export { DAY_MS, MINUTE_MS, catchUpPeriodMs, scheduledRunKey, slotStart } from './domain/job-schedule.js';
export { SettingsService } from './modules/settings/settings.service.js';
export { MaintenancePlansService } from './modules/maintenance/maintenance-plans.service.js';
export { DocumentsService } from './modules/documents/documents.service.js';
export { OdometerFreshnessService } from './modules/odometer/odometer-freshness.service.js';
export { UsagesService } from './modules/usages/usages.service.js';
export { ReservationsService } from './modules/reservations/reservations.service.js';
export { ImmobilizationsService } from './modules/immobilizations/immobilizations.service.js';
export { IncidentsService } from './modules/incidents/incidents.service.js';
export { EMAIL_CHANNEL_NOT_CONFIGURED } from './modules/notifications/notifications.service.js';
// Télématique F11 (cœur du connecteur) : garde de démarrage (simulateur interdit en production), registre des
// adaptateurs (secrets déchiffrés le temps d'un appel), découverte des unités, alertes F11, journal masqué.
export { TelemetryModule } from './modules/telemetry/telemetry.module.js';
export { TelemetryAdapterRegistry, assertNoActiveSimulatorInProduction, resolveAdapterFactory, sanitizeProviderFailure, type AdapterProviderRow } from './modules/telemetry/telemetry-adapter.registry.js';
export { TelemetryUnitsService, closeOpenMappingsForVehicle, type DiscoveryProvider } from './modules/telemetry/telemetry-units.service.js';
export { TelemetryAlertsService, F11_ALERT_TYPES } from './modules/telemetry/telemetry-alerts.service.js';
export { TelemetryProvidersService, providerErrorMessage } from './modules/telemetry/telemetry-providers.service.js';
export { SIMULATOR_LABEL } from './modules/telemetry/telemetry-settings.js';
// Télématique F11 (synchronisation) : passage planifié runDue(now) — runs échus, reprises initiales, source muette —,
// purge des échantillons, politique de reprise et de coupe-circuit (D-296, D-297).
export { TelemetrySyncModule } from './modules/telemetry/sync/telemetry-sync.module.js';
export { TelemetrySyncService, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETENTION_DAYS, type RunDueOptions, type RunDueResult, type RunWebhooksResult, type SyncRunOutcome } from './modules/telemetry/sync/telemetry-sync.service.js';
export { webhookSignatureHeader } from './modules/telemetry/webhook/telemetry-webhook-signature.js';
export { TelemetryPurgeService, type TelemetryPurgeResult } from './modules/telemetry/sync/telemetry-purge.service.js';
export { TelemetrySilenceService, type SilenceSummary } from './modules/telemetry/sync/telemetry-silence.service.js';
export { DEFAULT_SYNC_POLICY, type Sleep, type SyncPolicy } from './modules/telemetry/sync/telemetry-resilience.js';
export { RedactingConsoleLogger } from './common/redacting-logger.js';
export { redactSensitiveText, sanitizeUrl, trackSensitiveValues } from './common/secret-redaction.js';
