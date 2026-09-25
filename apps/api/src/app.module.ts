import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Clock } from './common/clock.js';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter.js';
import { RequestMemoInterceptor } from './common/request-memo.interceptor.js';
import { createValidationPipe } from './common/validation.js';
import { loadEnv, type AppEnv } from './infra/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AccessControlModule } from './modules/access-control/access-control.module.js';
import { SessionAuthGuard } from './modules/auth/auth.guard.js';
import { AssignmentsModule } from './modules/assignments/assignments.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CsrfGuard } from './modules/auth/csrf.guard.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { ExpensesModule } from './modules/expenses/expenses.module.js';
import { FuelModule } from './modules/fuel/fuel.module.js';
import { AlertsCoreModule } from './modules/alerts/alerts-core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ImmobilizationsModule } from './modules/immobilizations/immobilizations.module.js';
import { IncidentsModule } from './modules/incidents/incidents.module.js';
import { InterventionsModule } from './modules/interventions/interventions.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { OdometerModule } from './modules/odometer/odometer.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { UsagesModule } from './modules/usages/usages.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VehiclesModule } from './modules/vehicles/vehicles.module.js';
import { VehicleTransferModule } from './modules/vehicles/vehicle-transfer.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { AlertsModule } from './modules/alerts/alerts.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AuditModule } from './modules/audit/audit.module.js';

export interface AppModuleOptions {
  env?: AppEnv;
  clock?: Clock;
}

/** Modules métier chargés dans l'API. Chaque lot ajoute ses modules ici. */
export const FEATURE_MODULES = [HealthModule, SettingsModule, AlertsCoreModule, UsersModule, OrganizationsModule, AttachmentsModule, DriversModule, VehiclesModule, OdometerModule, UsagesModule, ReservationsModule, AssignmentsModule, MaintenanceModule, ImmobilizationsModule, SuppliersModule, InterventionsModule, DocumentsModule, IncidentsModule, ExpensesModule, FuelModule, ImportsModule, DashboardModule, AlertsModule, NotificationsModule, ReportsModule, VehicleTransferModule, AuditModule];

@Module({})
export class AppModule {
  static register(options: AppModuleOptions = {}): DynamicModule {
    const env = options.env ?? loadEnv();
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(env, options.clock),
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }], skipIf: () => !env.rateLimitEnabled }),
        AccessControlModule,
        AuthModule,
        ...FEATURE_MODULES,
      ],
      providers: [
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: SessionAuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        // Mémoire propre à chaque requête HTTP (paramètres, fuseau) : common/request-memo.ts.
        { provide: APP_INTERCEPTOR, useClass: RequestMemoInterceptor },
      ],
    };
  }
}
