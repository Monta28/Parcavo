import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

/** Point d'entrée du worker : contexte applicatif Nest sans serveur HTTP, arrêt propre sur SIGTERM. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(), { bufferLogs: false });
  app.enableShutdownHooks();
  Logger.log('Worker démarré', 'Worker');
}

bootstrap().catch((error: unknown) => {
  Logger.error(`Démarrage du worker impossible : ${error instanceof Error ? error.message : String(error)}`, 'Worker');
  process.exit(1);
});
