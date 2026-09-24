import { type DynamicModule, Module } from '@nestjs/common';
import { InfraModule, type AppEnv, type Clock } from '@parc-auto/api';
import { HeartbeatService } from './heartbeat.service.js';

/**
 * Module du worker : réutilise l'infrastructure de l'API (base, horloge, audit) sans exposer de
 * route HTTP. Les traitements planifiés s'ajoutent ici lot après lot.
 */
@Module({})
export class WorkerModule {
  static register(options: { env?: AppEnv; clock?: Clock } = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [InfraModule.forRoot(options.env, options.clock)],
      providers: [HeartbeatService],
      exports: [HeartbeatService],
    };
  }
}
