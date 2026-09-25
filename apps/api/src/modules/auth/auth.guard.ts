import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthenticatedError } from '../../common/errors.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { IS_PUBLIC_KEY, SIGNED_WEBHOOK_KEY } from './auth.decorators.js';
import { ContextBuilderService } from './context-builder.service.js';
import { SESSION_COOKIE } from './session.service.js';

/** Garde globale : toute route est authentifiée sauf @Public(). */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contextBuilder: ContextBuilderService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Webhook signé : aucun cookie de session n'est lu, la requête n'a jamais de contexte utilisateur.
    if (this.reflector.getAllAndOverride<boolean>(SIGNED_WEBHOOK_KEY, [context.getHandler(), context.getClass()])) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    const token = readSessionCookie(req);
    if (token) {
      const session = await this.contextBuilder.resolveSession(token, req.requestId, clientIp(req));
      if (session) {
        req.context = session.context;
        // Empreinte CSRF lue avec la session : CsrfGuard la compare sans relire la session.
        req.sessionCsrfTokenHash = session.csrfTokenHash;
      }
    }
    if (isPublic) return true;
    if (!req.context) throw new UnauthenticatedError();
    return true;
  }
}

export function readSessionCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const value: unknown = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
