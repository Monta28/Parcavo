import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { OdometerModule } from '../odometer/odometer.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { ImportAppliersService } from './import-appliers.service.js';
import { ImportRetentionService } from './import-retention.service.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [VehiclesModule, DriversModule, OdometerModule, MaintenanceModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportAppliersService, ImportRetentionService],
  exports: [ImportRetentionService],
})
export class ImportsModule {}
