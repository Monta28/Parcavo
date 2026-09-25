import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module.js';
import { AlertsCoreModule } from '../alerts/alerts-core.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Notifications e-mail (CDC 9.4) : mise en file des alertes critiques et du récapitulatif quotidien,
 * état du canal et de l'outbox, préférences. Autonome (dépendances importées explicitement) pour être
 * réutilisé par le worker, qui planifie le récapitulatif et envoie l'outbox.
 */
@Module({
  imports: [AccessControlModule, AlertsCoreModule, SettingsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
