import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';

/** Cœur des alertes, disponible pour tous les modules ; le centre d'alertes (routes /alerts) est AlertsModule. */
@Global()
@Module({ providers: [AlertsService], exports: [AlertsService] })
export class AlertsCoreModule {}
