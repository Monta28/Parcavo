import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from '../common/clock.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { AuditService } from './audit.service.js';
import { APP_ENV, loadEnv, type AppEnv } from './env.js';
import { PasswordService } from './password.service.js';
import { PrismaService } from './prisma.service.js';
import { ReferenceService } from './reference.service.js';
import { SecretsCryptoService } from './secrets-crypto.service.js';
import { FileSystemStorage, ObjectStorage } from './storage.service.js';

/**
 * Module d'infrastructure global. Les tests fournissent un AppEnv et un Clock de substitution
 * via `InfraModule.forTest(...)` ou `overrideProvider`.
 */
@Global()
@Module({})
export class InfraModule {
  static forRoot(env?: AppEnv, clock?: Clock) {
    const resolvedEnv = env ?? loadEnv();
    return {
      module: InfraModule,
      providers: [
        { provide: APP_ENV, useValue: resolvedEnv },
        { provide: Clock, useValue: clock ?? new SystemClock() },
        PrismaService,
        PasswordService,
        SecretsCryptoService,
        AuditService,
        IdempotencyService,
        ReferenceService,
        { provide: ObjectStorage, useClass: FileSystemStorage },
      ],
      exports: [APP_ENV, Clock, PrismaService, PasswordService, SecretsCryptoService, AuditService, IdempotencyService, ReferenceService, ObjectStorage],
    };
  }
}
