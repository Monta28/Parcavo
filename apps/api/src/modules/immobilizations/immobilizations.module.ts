import { Module } from '@nestjs/common';
import { SuppliersModule } from '../suppliers/suppliers.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { ImmobilizationsController } from './immobilizations.controller.js';
import { ImmobilizationsService } from './immobilizations.service.js';

@Module({ imports: [VehiclesModule, SuppliersModule], controllers: [ImmobilizationsController], providers: [ImmobilizationsService], exports: [ImmobilizationsService] })
export class ImmobilizationsModule {}
