import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

@Module({ controllers: [DriversController], providers: [DriversService], exports: [DriversService] })
export class DriversModule {}
