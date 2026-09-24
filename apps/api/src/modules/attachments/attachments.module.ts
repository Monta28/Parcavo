import { Global, Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { OwnerAuthorizationService } from './owner-authorization.service.js';

@Global()
@Module({ controllers: [AttachmentsController], providers: [AttachmentsService, OwnerAuthorizationService], exports: [AttachmentsService, OwnerAuthorizationService] })
export class AttachmentsModule {}
