import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { FuelModule } from '../fuel/fuel.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { ReportExportJobHandler } from './export/report-export.job-handler.js';
import { ReportExportPolicy } from './export/report-export.policy.js';
import { ReportExportService } from './export/report-export.service.js';
import { DistanceCostReportService } from './providers/distance-cost-report.service.js';
import { DocumentsReportService } from './providers/documents-report.service.js';
import { ExpensesReportService } from './providers/expenses-report.service.js';
import { FuelReportService } from './providers/fuel-report.service.js';
import { IncidentsReportService } from './providers/incidents-report.service.js';
import { InventoryReportService } from './providers/inventory-report.service.js';
import { MaintenanceReportService } from './providers/maintenance-report.service.js';
import { ReadingsReportService } from './providers/readings-report.service.js';
import { UsageReportService } from './providers/usage-report.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Rapports V1 et exports (CDC 11.2, 11.3) ; le gestionnaire d'export différé est exporté pour le worker. */
@Module({
  imports: [JobsModule, DocumentsModule, MaintenanceModule, FuelModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportExportService,
    ReportExportJobHandler,
    ReportExportPolicy,
    InventoryReportService,
    UsageReportService,
    ReadingsReportService,
    MaintenanceReportService,
    DocumentsReportService,
    FuelReportService,
    ExpensesReportService,
    IncidentsReportService,
    DistanceCostReportService,
  ],
  exports: [ReportsService, ReportExportService, ReportExportJobHandler, ReportExportPolicy, JobsModule],
})
export class ReportsModule {}
