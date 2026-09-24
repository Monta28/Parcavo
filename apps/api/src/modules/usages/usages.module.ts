import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { DepartureChecksService } from './departure-checks.service.js';
import { UsagesController } from './usages.controller.js';
import { UsagesService } from './usages.service.js';

@Module({
  imports: [VehiclesModule, DriversModule, IncidentsModule],
  controllers: [UsagesController],
  providers: [UsagesService, DepartureChecksService],
  exports: [UsagesService, DepartureChecksService],
})
export class UsagesModule {}
