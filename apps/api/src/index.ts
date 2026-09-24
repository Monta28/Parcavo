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
