import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

/** File de jobs PostgreSQL (exports volumineux, recalculs) partagée par l'API et le worker. */
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
