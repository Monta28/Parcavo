import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describeErrorSafely } from '@parc-auto/api';
import { WorkerScheduler } from './scheduler/worker-scheduler.service.js';
import { WorkerModule } from './worker.module.js';

/**
 * Point d'entrée du worker : contexte applicatif Nest sans serveur HTTP. À SIGTERM/SIGINT : arrêt des
 * déclenchements, attente des traitements en cours, libération des baux, puis fermeture propre.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(), { bufferLogs: false });
  const scheduler = app.get(WorkerScheduler);
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    Logger.log(`Arrêt demandé (${signal}) : fin des traitements en cours.`, 'Worker');
    scheduler
      .stop()
      .catch((error: unknown) => Logger.error(`Arrêt du planificateur incomplet : ${describeErrorSafely(error)}`, 'Worker'))
      .then(() => app.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          Logger.error(`Fermeture du worker incomplète : ${describeErrorSafely(error)}`, 'Worker');
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  Logger.log('Worker démarré', 'Worker');
}

bootstrap().catch((error: unknown) => {
  Logger.error(`Démarrage du worker impossible : ${describeErrorSafely(error)}`, 'Worker');
  process.exit(1);
});
