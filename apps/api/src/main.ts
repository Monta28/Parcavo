import { Logger } from '@nestjs/common';
import { createApp, mountOpenApi } from './bootstrap.js';
import { APP_ENV, type AppEnv } from './infra/env.js';

const app = await createApp();
const env = app.get<AppEnv>(APP_ENV);
mountOpenApi(app);
await app.listen(env.port);
new Logger('Bootstrap').log(`API Parc Auto démarrée sur le port ${env.port} (${env.nodeEnv}).`);
