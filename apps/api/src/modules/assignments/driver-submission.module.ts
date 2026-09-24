import { Module } from '@nestjs/common';
import { DriverSubmissionController } from './driver-submission.controller.js';
import { DriverSubmissionService } from './driver-submission.service.js';

/**
 * Véhicule de soumission du conducteur (D-116, D-268). Module sans dépendance métier (Prisma, paramètres
 * et horloge sont globaux) : importable par les modules relevés, incidents et carburant sans cycle.
 */
@Module({ controllers: [DriverSubmissionController], providers: [DriverSubmissionService], exports: [DriverSubmissionService] })
export class DriverSubmissionModule {}
