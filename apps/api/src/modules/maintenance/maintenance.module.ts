import { Module } from '@nestjs/common';
import { OdometerModule } from '../odometer/odometer.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { MaintenanceCalendarService } from './maintenance-calendar.service.js';
import { MaintenanceCatalogService } from './maintenance-catalog.service.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenancePlansService } from './maintenance-plans.service.js';

@Module({ imports: [VehiclesModule, OdometerModule], controllers: [MaintenanceController], providers: [MaintenancePlansService, MaintenanceCatalogService, MaintenanceCalendarService], exports: [MaintenancePlansService] })
export class MaintenanceModule {}
