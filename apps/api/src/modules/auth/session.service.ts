import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { Clock } from '../../common/clock.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export const SESSION_COOKIE = 'pa_session';
export const CSRF_COOKIE = 'pa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface IssuedSession {
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Sessions serveur révocables (CDC 16.1) : le navigateur ne reçoit qu'un jeton opaque en cookie
 * HttpOnly ; seule son empreinte est stockée. Le jeton CSRF est lié à la session. Durée : paramètre
 * `session.ttlHours` de l'organisation (12 h par défaut, modifiable par l'administrateur, audité),
 * lu à chaque connexion ; une session déjà ouverte garde l'échéance fixée à sa création.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly settings: SettingsService,
  ) {}

  async issue(user: { id: string; organizationId: string }, meta: { ipAddress: string | null; userAgent: string | null }): Promise<IssuedSession> {
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const ttlHours = await this.settings.get(user.organizationId, 'session.ttlHours');
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);
    const session = await this.prisma.client.session.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        tokenHash: hashToken(sessionToken),
        csrfTokenHash: hashToken(csrfToken),
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { sessionId: session.id, sessionToken, csrfToken, expiresAt };
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  setCookies(res: Response, issued: IssuedSession): void {
    const maxAge = issued.expiresAt.getTime() - this.clock.now().getTime();
    res.cookie(SESSION_COOKIE, issued.sessionToken, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
    // Jeton CSRF lisible par le script de la page (double soumission), lié à la session côté serveur.
    res.cookie(CSRF_COOKIE, issued.csrfToken, {
      httpOnly: false,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
  }

  clearCookies(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  /** Nettoyage des sessions expirées ou révoquées depuis plus de 30 jours (job worker). */
  async purge(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 30 * 24 * 3600 * 1000);
    const result = await this.prisma.client.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }
}
