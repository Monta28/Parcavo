import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { VehicleTransferController } from './vehicle-transfer.controller.js';
import { VehicleTransferService } from './vehicle-transfer.service.js';
import { VehiclesModule } from './vehicles.module.js';

/**
 * Transfert inter-sociétés (CDC 2.4) : module distinct de VehiclesModule, dont dépendent les modules
 * d'entretien et de documents qu'il utilise (pas de dépendance circulaire).
 */
@Module({ imports: [VehiclesModule, MaintenanceModule, DocumentsModule], controllers: [VehicleTransferController], providers: [VehicleTransferService], exports: [VehicleTransferService] })
export class VehicleTransferModule {}
