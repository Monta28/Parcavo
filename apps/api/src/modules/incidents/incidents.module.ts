import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { ImmobilizationsModule } from '../immobilizations/immobilizations.module.js';
import { InterventionsModule } from '../interventions/interventions.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

@Module({ imports: [VehiclesModule, AttachmentsModule, ImmobilizationsModule, InterventionsModule], controllers: [IncidentsController], providers: [IncidentsService], exports: [IncidentsService] })
export class IncidentsModule {}
