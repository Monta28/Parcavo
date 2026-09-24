import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenActionError } from '../../common/errors.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { SKIP_CSRF_KEY } from './auth.decorators.js';
import { CSRF_COOKIE, CSRF_HEADER, hashToken } from './session.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Protection des mutations (CDC 16.1) : contrôle d'origine (Origin/Referer contre APP_ORIGIN) puis
 * double soumission du jeton CSRF (cookie + en-tête) vérifié contre l'empreinte de la session.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    if (!MUTATING.has(req.method)) return true;

    this.assertOrigin(req);

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [context.getHandler(), context.getClass()]);
    if (skip || !req.context) return true;

    const header = req.header(CSRF_HEADER);
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const cookie: unknown = cookies?.[CSRF_COOKIE];
    if (!header || typeof cookie !== 'string' || header !== cookie) {
      throw new ForbiddenActionError('Jeton CSRF absent ou invalide.');
    }
    const session = await this.prisma.client.session.findUnique({ where: { id: req.context.sessionId }, select: { csrfTokenHash: true } });
    if (!session || session.csrfTokenHash !== hashToken(header)) {
      throw new ForbiddenActionError('Jeton CSRF absent ou invalide.');
    }
    return true;
  }

  private assertOrigin(req: Request): void {
    const origin = req.header('origin') ?? originOf(req.header('referer'));
    if (!origin) {
      // Requêtes sans Origin ni Referer (outils serveur, tests) : le jeton CSRF reste exigé.
      return;
    }
    if (origin !== this.env.appOrigin) {
      throw new ForbiddenActionError('Origine de la requête non autorisée.');
    }
  }
}

function originOf(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
