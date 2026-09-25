import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { AuditController } from './audit.controller.js';
import { AuditJournalService } from './audit.service.js';
import { VehicleTimelineController } from './vehicle-timeline.controller.js';
import { VehicleTimelineService } from './vehicle-timeline.service.js';

/** Consultation de l'audit (/audit) et chronologie métier du véhicule (/vehicles/:id/timeline). */
@Module({
  imports: [VehiclesModule],
  controllers: [AuditController, VehicleTimelineController],
  providers: [AuditJournalService, VehicleTimelineService],
})
export class AuditModule {}
