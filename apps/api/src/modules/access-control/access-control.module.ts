import { Global, Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service.js';

@Global()
@Module({ providers: [AccessControlService], exports: [AccessControlService] })
export class AccessControlModule {}
