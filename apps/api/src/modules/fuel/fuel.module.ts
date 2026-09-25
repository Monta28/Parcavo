import { Module } from '@nestjs/common';
import { DriverSubmissionModule } from '../assignments/driver-submission.module.js';
import { SuppliersModule } from '../suppliers/suppliers.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { FuelController } from './fuel.controller.js';
import { FuelService } from './fuel.service.js';

/** Pleins, soumissions conducteur, consommation et périodes d'achats incomplets (CDC 8.2, 8.3). */
@Module({
  imports: [VehiclesModule, SuppliersModule, DriverSubmissionModule],
  controllers: [FuelController],
  providers: [FuelService],
  exports: [FuelService],
})
export class FuelModule {}
