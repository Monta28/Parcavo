import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { ImmobilizationsModule } from '../immobilizations/immobilizations.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { SuppliersModule } from '../suppliers/suppliers.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { InterventionsController } from './interventions.controller.js';
import { InterventionsService } from './interventions.service.js';

@Module({
  imports: [VehiclesModule, SuppliersModule, MaintenanceModule, ImmobilizationsModule, AttachmentsModule],
  controllers: [InterventionsController],
  providers: [InterventionsService],
  exports: [InterventionsService],
})
export class InterventionsModule {}
