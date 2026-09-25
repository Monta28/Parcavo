import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { InterventionsModule } from '../interventions/interventions.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { UsagesModule } from '../usages/usages.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/** Tableau de bord (CDC 11.1, 10.2 ; D-269) : indicateurs calculés en direct, listes justificatives. */
@Module({
  imports: [DocumentsModule, MaintenanceModule, UsagesModule, InterventionsModule, ExpensesModule, AlertsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
