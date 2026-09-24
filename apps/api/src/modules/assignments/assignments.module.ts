import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { AssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { DriverSubmissionModule } from './driver-submission.module.js';

@Module({ imports: [VehiclesModule, DriversModule, DriverSubmissionModule], controllers: [AssignmentsController], providers: [AssignmentsService], exports: [AssignmentsService, DriverSubmissionModule] })
export class AssignmentsModule {}
