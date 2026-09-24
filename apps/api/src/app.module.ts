import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Clock } from './common/clock.js';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter.js';
import { createValidationPipe } from './common/validation.js';
import { loadEnv, type AppEnv } from './infra/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AccessControlModule } from './modules/access-control/access-control.module.js';
import { SessionAuthGuard } from './modules/auth/auth.guard.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CsrfGuard } from './modules/auth/csrf.guard.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { AlertsCoreModule } from './modules/alerts/alerts-core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VehiclesModule } from './modules/vehicles/vehicles.module.js';

export interface AppModuleOptions {
  env?: AppEnv;
  clock?: Clock;
}

/** Modules métier chargés dans l'API. Chaque lot ajoute ses modules ici. */
export const FEATURE_MODULES = [HealthModule, SettingsModule, AlertsCoreModule, UsersModule, OrganizationsModule, AttachmentsModule, DriversModule, VehiclesModule];

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
      ],
    };
  }
}
