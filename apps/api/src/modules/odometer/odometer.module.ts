import { Global, Module } from '@nestjs/common';
import { DriverSubmissionModule } from '../assignments/driver-submission.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { OdometerController } from './odometer.controller.js';
import { OdometerEventsService } from './odometer-events.service.js';
import { OdometerFreshnessService } from './odometer-freshness.service.js';
import { OdometerIngestionService } from './odometer-ingestion.service.js';
import { OdometerService } from './odometer.service.js';

@Global()
@Module({
  imports: [VehiclesModule, DriverSubmissionModule],
  controllers: [OdometerController],
  providers: [OdometerService, OdometerIngestionService, OdometerEventsService, OdometerFreshnessService],
  exports: [OdometerService, OdometerIngestionService, OdometerEventsService, OdometerFreshnessService],
})
export class OdometerModule {}
