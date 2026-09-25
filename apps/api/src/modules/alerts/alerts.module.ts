import { Module } from '@nestjs/common';
import { AlertCenterService } from './alert-center.service.js';
import { AlertsCoreModule } from './alerts-core.module.js';
import { AlertsController } from './alerts.controller.js';

/** Centre d'alertes (CDC 9.1, 9.2, 15.2) : routes /alerts au-dessus du cœur des alertes. */
@Module({ imports: [AlertsCoreModule], controllers: [AlertsController], providers: [AlertCenterService], exports: [AlertCenterService] })
export class AlertsModule {}
