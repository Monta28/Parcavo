import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PASSWORD_RESET_LINK_TTL_MINUTES } from '@parc-auto/contracts';
import type { Response } from 'express';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ForbiddenActionError, NotFoundOrOutOfScopeError, RateLimitedError, UnauthenticatedError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PasswordService } from '../../infra/password.service.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { ENUM_TO_PERMISSION, effectivePermissions } from '../access-control/permissions.js';
import type { LoginDto, SessionInfoDto } from './dto/auth.dto.js';
import { SessionService } from './session.service.js';

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;
/** Validité du lien « Mot de passe oublié » : constante partagée avec l'écran de demande (packages/contracts). */
const RESET_TOKEN_TTL_MS = PASSWORD_RESET_LINK_TTL_MINUTES * 60 * 1000;
const GENERIC_LOGIN_MESSAGE = 'Adresse e-mail ou mot de passe incorrect.';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** Connexion : messages non énumérants, limitation persistante des tentatives (CDC 16.1). */
  async login(dto: LoginDto, res: Response, meta: { ipAddress: string | null; userAgent: string | null; requestId: string }): Promise<SessionInfoDto> {
    const email = normalizeEmail(dto.email);
    const now = this.clock.now();
    const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
    const [failuresForEmail, failuresForIp] = await Promise.all([
      this.prisma.client.loginAttempt.count({ where: { emailNormalized: email, success: false, createdAt: { gte: since } } }),
      meta.ipAddress
        ? this.prisma.client.loginAttempt.count({ where: { ipAddress: meta.ipAddress, success: false, createdAt: { gte: since } } })
        : Promise.resolve(0),
    ]);
    if (failuresForEmail >= MAX_FAILURES_PER_EMAIL || failuresForIp >= MAX_FAILURES_PER_IP) {
      throw new RateLimitedError('Trop de tentatives de connexion. Réessayez dans quelques minutes.');
    }

    const user = await this.prisma.client.user.findFirst({ where: { email }, include: { organization: true } });
    const valid = await this.passwords.verify(user?.passwordHash ?? null, dto.password);
    const success = Boolean(user) && valid && user?.status === 'ACTIF';

    await this.prisma.client.loginAttempt.create({
      data: { emailNormalized: email, ipAddress: meta.ipAddress ?? 'inconnue', success, createdAt: now },
    });

    if (!success || !user) {
      if (user) {
        await this.audit.recordSystem(user.organizationId, {
          action: 'auth.login.echec',
          objectType: 'User',
          objectId: user.id,
          reason: user.status !== 'ACTIF' ? 'compte désactivé' : 'mot de passe invalide',
        });
      }
      throw new UnauthenticatedError(GENERIC_LOGIN_MESSAGE);
    }

    const issued = await this.sessions.issue(user, { ipAddress: meta.ipAddress, userAgent: meta.userAgent });
    await this.prisma.client.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    this.sessions.setCookies(res, issued);
    await this.audit.recordSystem(user.organizationId, {
      action: 'auth.login',
      objectType: 'User',
      objectId: user.id,
      after: { sessionId: issued.sessionId, ipAddress: meta.ipAddress },
    });
    return this.sessionInfo({ userId: user.id, organizationId: user.organizationId, sessionId: issued.sessionId });
  }

  async logout(ctx: RequestContext, res: Response): Promise<void> {
    await this.sessions.revoke(ctx.sessionId, 'déconnexion');
    this.sessions.clearCookies(res);
    await this.audit.record(ctx, { action: 'auth.logout', objectType: 'User', objectId: ctx.userId });
  }

  async sessionInfo(ctx: { userId: string; organizationId: string; sessionId: string }): Promise<SessionInfoDto> {
    const [user, session, companies] = await Promise.all([
      this.prisma.client.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        include: { organization: true, memberships: { include: { company: { select: { id: true, code: true, legalName: true, status: true } } } }, driver: { select: { id: true } } },
      }),
      this.prisma.client.session.findUniqueOrThrow({ where: { id: ctx.sessionId }, select: { expiresAt: true } }),
      this.prisma.client.company.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, code: true, legalName: true, status: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    const isAdmin = user.memberships.some((m) => m.companyId === null && m.role === 'ADMIN');
    const grants = user.memberships
      .filter((m) => m.companyId !== null && m.company && m.company.status === 'ACTIF')
      .map((m) => {
        const perms = effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions);
        return {
          companyId: m.companyId as string,
          companyCode: m.company?.code ?? '',
          companyName: m.company?.legalName ?? '',
          role: m.role,
          permissions: [...perms].map((p) => ENUM_TO_PERMISSION[p]),
        };
      });
    const visible = isAdmin ? companies : companies.filter((c) => grants.some((g) => g.companyId === c.id));
    return {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      timezone: user.organization.timezone,
      currency: user.organization.currency,
      currencyDecimals: user.organization.currencyDecimals,
      isAdmin,
      isDriverOnly: !isAdmin && grants.length > 0 && grants.every((g) => g.role === 'CONDUCTEUR'),
      driverId: user.driver?.id ?? null,
      grants,
      companies: visible.map((c) => ({ id: c.id, code: c.code, name: c.legalName, status: c.status })),
      sessionExpiresAt: session.expiresAt.toISOString(),
      emailChannelConfigured: this.env.smtp !== null,
    };
  }

  /** Demande de réinitialisation : toujours 200, jeton court à usage unique stocké en empreinte. */
  async forgotPassword(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.client.user.findFirst({ where: { email: normalized, status: 'ACTIF' } });
    if (!user) return;
    if (!this.env.smtp) {
      // Sans canal e-mail : aucun jeton ni message en file ; la page indique de s'adresser à
      // l'administrateur, qui génère un lien d'accès (D-263). La réponse reste identique.
      await this.audit.recordSystem(user.organizationId, { action: 'auth.mot_de_passe.demande_sans_email', objectType: 'User', objectId: user.id });
      return;
    }
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.passwordResetToken.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        },
      });
      const link = `${this.env.appOrigin}/reinitialisation?token=${token}`;
      await tx.notificationOutbox.create({
        data: {
          organizationId: user.organizationId,
          kind: 'REINITIALISATION_MOT_DE_PASSE',
          recipientUserId: user.id,
          recipientEmail: user.email,
          subject: 'Parc Auto — réinitialisation de votre mot de passe',
          bodyText: `Bonjour ${user.firstName},\n\nPour définir un nouveau mot de passe, ouvrez ce lien dans les trente minutes :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
          dedupeKey: `reset:${user.id}:${now.getTime()}`,
        },
      });
    });
    await this.audit.recordSystem(user.organizationId, { action: 'auth.mot_de_passe.demande_reinitialisation', objectType: 'User', objectId: user.id });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const weakness = this.passwords.validateStrength(newPassword);
    if (weakness) throw new BusinessRuleError('MOT_DE_PASSE_FAIBLE', weakness, { fieldErrors: { newPassword: [weakness] } });
    const now = this.clock.now();
    const record = await this.prisma.client.passwordResetToken.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt <= now || record.user.status !== 'ACTIF') {
      throw new BusinessRuleError('JETON_INVALIDE', 'Ce lien de réinitialisation est invalide ou expiré.');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: now, version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'réinitialisation du mot de passe' } });
    });
    await this.audit.recordSystem(record.organizationId, { action: 'auth.mot_de_passe.reinitialise', objectType: 'User', objectId: record.userId });
  }

  async changePassword(ctx: RequestContext, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new BusinessRuleError('MOT_DE_PASSE_ACTUEL_INVALIDE', 'Le mot de passe actuel est incorrect.', { fieldErrors: { currentPassword: ['Mot de passe incorrect.'] } });
    }
    const weakness = this.passwords.validateStrength(newPassword);
    if (weakness) throw new BusinessRuleError('MOT_DE_PASSE_FAIBLE', weakness, { fieldErrors: { newPassword: [weakness] } });
    const now = this.clock.now();
    await this.prisma.client.user.update({
      where: { id: ctx.userId },
      data: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: now, version: { increment: 1 } },
    });
    await this.sessions.revokeAllForUser(ctx.userId, 'changement de mot de passe', ctx.sessionId);
    await this.audit.record(ctx, { action: 'auth.mot_de_passe.modifie', objectType: 'User', objectId: ctx.userId });
  }

  /** Révocation des sessions : soi-même, ou un autre utilisateur de l'organisation pour l'administrateur. */
  async revokeSessions(ctx: RequestContext, targetUserId: string | undefined, keepCurrent: boolean | undefined): Promise<number> {
    const userId = targetUserId ?? ctx.userId;
    if (userId !== ctx.userId) {
      if (!ctx.isAdmin) throw new ForbiddenActionError('Seul l’administrateur peut révoquer les sessions d’un autre utilisateur.');
      const target = await this.prisma.client.user.findFirst({ where: { id: userId, organizationId: ctx.organizationId }, select: { id: true } });
      if (!target) throw new NotFoundOrOutOfScopeError('Utilisateur');
    }
    const keep = keepCurrent ?? userId === ctx.userId;
    const count = await this.sessions.revokeAllForUser(userId, 'révocation manuelle', keep ? ctx.sessionId : undefined);
    await this.audit.record(ctx, { action: 'auth.sessions.revoquees', objectType: 'User', objectId: userId, after: { count } });
    return count;
  }
}
