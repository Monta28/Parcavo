import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';

/** Cœur des alertes, disponible pour tous les modules (le centre d'alertes complet est livré au lot D). */
@Global()
@Module({ providers: [AlertsService], exports: [AlertsService] })
export class AlertsCoreModule {}
