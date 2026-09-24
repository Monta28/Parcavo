import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { UsagesModule } from '../usages/usages.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({ imports: [VehiclesModule, DriversModule, UsagesModule], controllers: [ReservationsController], providers: [ReservationsService], exports: [ReservationsService] })
export class ReservationsModule {}
