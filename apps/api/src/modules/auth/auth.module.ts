import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { SessionAuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ContextBuilderService } from './context-builder.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, ContextBuilderService, SessionAuthGuard, CsrfGuard],
  exports: [SessionService, ContextBuilderService, SessionAuthGuard, CsrfGuard],
})
export class AuthModule {}
