import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Membership, MembershipRole, Permission, Prisma, User } from '@parc-auto/db';
import { PASSWORD_RESET_LINK_TTL_MINUTES, ROLES } from '@parc-auto/contracts';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PasswordService } from '../../infra/password.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { ENUM_TO_PERMISSION, PERMISSION_TO_ENUM, effectivePermissions } from '../access-control/permissions.js';
import { SessionService } from '../auth/session.service.js';
import { normalizeEmail } from '../auth/auth.service.js';
import type { CreateUserDto, MembershipInputDto, UpdateUserDto, UserViewDto, UsersQueryDto } from './dto/users.dto.js';

type UserWithMemberships = User & { memberships: Array<Membership & { company: { code: string; legalName: string } | null }>; driver: { id: string } | null };

const SORTS = ['lastName', 'email', 'createdAt', 'lastLoginAt'] as const;

/**
 * Gestion des utilisateurs (CDC 2.2) : réservée à l'administrateur en V1. Le chef ne peut pas
 * accorder des droits supérieurs aux siens (règle appliquée par la restriction administrateur).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async list(ctx: RequestContext, query: UsersQueryDto): Promise<Page<UserViewDto>> {
    this.access.requireAdmin(ctx);
    const where: Prisma.UserWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.companyId ? { memberships: { some: { companyId: query.companyId } } } : {}),
      ...(query.q
        ? { OR: [{ email: { contains: query.q, mode: 'insensitive' } }, { lastName: { contains: query.q, mode: 'insensitive' } }, { firstName: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    };
    const sort = resolveSort(query.sort, SORTS, 'lastName');
    const [items, total] = await Promise.all([
      this.prisma.client.user.findMany({ where, ...skipTake(query), orderBy: [{ [sort]: query.order }, { id: 'asc' }], include: this.include() }),
      this.prisma.client.user.count({ where }),
    ]);
    return pageOf(items.map((u) => this.view(u)), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<UserViewDto> {
    this.access.requireAdmin(ctx);
    return this.view(await this.load(ctx, id));
  }

  async create(ctx: RequestContext, dto: CreateUserDto): Promise<UserViewDto> {
    this.access.requireAdmin(ctx);
    const email = normalizeEmail(dto.email);
    const memberships = await this.validateMemberships(ctx, dto.memberships);
    if (dto.driverId) await this.assertDriverLinkable(ctx, dto.driverId, null);
    let passwordHash: string | null = null;
    if (dto.password) {
      const weakness = this.passwords.validateStrength(dto.password);
      if (weakness) throw new BusinessRuleError('MOT_DE_PASSE_FAIBLE', weakness, { fieldErrors: { password: [weakness] } });
      passwordHash = await this.passwords.hash(dto.password);
    }
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            organizationId: ctx.organizationId,
            email,
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            passwordHash,
            createdById: ctx.userId,
            memberships: { create: memberships.map((m) => ({ ...m, createdById: ctx.userId })) },
          },
          include: this.include(),
        });
        if (dto.driverId) {
          await tx.driver.update({ where: { id: dto.driverId }, data: { userId: user.id, version: { increment: 1 } } });
        }
        // Sans SMTP, rien n'est mis en file : l'administrateur génère un lien d'accès (D-263).
        if (!passwordHash && this.env.smtp) {
          await this.enqueueInvitation(tx, user, ctx);
        }
        await this.audit.record(ctx, { action: 'users.creation', objectType: 'User', objectId: user.id, after: { email, memberships } }, tx);
        return user;
      });
      return this.view(await this.load(ctx, created.id));
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw new ConflictError('EMAIL_DEJA_UTILISE', 'Cette adresse e-mail est déjà utilisée dans l’organisation.');
      }
      throw error;
    }
  }

  async update(ctx: RequestContext, id: string, dto: UpdateUserDto): Promise<UserViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.load(ctx, id);
    assertExpectedVersion(current, dto.expectedVersion, 'utilisateur');
    const memberships = dto.memberships ? await this.validateMemberships(ctx, dto.memberships) : null;
    if (dto.driverId) await this.assertDriverLinkable(ctx, dto.driverId, id);
    if (memberships && id === ctx.userId && !memberships.some((m) => m.companyId === null && m.role === 'ADMIN')) {
      throw new BusinessRuleError('AUTO_RETRAIT_ADMIN', 'Vous ne pouvez pas retirer votre propre rôle d’administrateur.');
    }
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.user.update({
          where: { id, version: dto.expectedVersion },
          data: {
            ...(dto.firstName !== undefined ? { firstName: dto.firstName.trim() } : {}),
            ...(dto.lastName !== undefined ? { lastName: dto.lastName.trim() } : {}),
            ...(dto.email !== undefined ? { email: normalizeEmail(dto.email) } : {}),
            version: { increment: 1 },
          },
        });
        if (memberships) {
          await tx.membership.deleteMany({ where: { userId: id } });
          await tx.membership.createMany({ data: memberships.map((m) => ({ ...m, userId: id, organizationId: ctx.organizationId, createdById: ctx.userId })) });
        }
        if (dto.driverId !== undefined) {
          if (current.driver && current.driver.id !== dto.driverId) {
            await tx.driver.update({ where: { id: current.driver.id }, data: { userId: null, version: { increment: 1 } } });
          }
          if (dto.driverId) {
            await tx.driver.update({ where: { id: dto.driverId }, data: { userId: id, version: { increment: 1 } } });
          }
        }
        await this.audit.record(ctx, {
          action: 'users.modification',
          objectType: 'User',
          objectId: id,
          before: { email: current.email, memberships: current.memberships.map(membershipSummary) },
          after: { email: dto.email ?? current.email, memberships: memberships ?? current.memberships.map(membershipSummary) },
        }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw new ConflictError('EMAIL_DEJA_UTILISE', 'Cette adresse e-mail est déjà utilisée dans l’organisation.');
      throw error;
    }
    return this.view(await this.load(ctx, id));
  }

  /** Désactivation : les sessions sont révoquées immédiatement (T32). */
  async disable(ctx: RequestContext, id: string, reason: string): Promise<UserViewDto> {
    this.access.requireAdmin(ctx);
    if (id === ctx.userId) throw new BusinessRuleError('AUTO_DESACTIVATION', 'Vous ne pouvez pas désactiver votre propre compte.');
    const current = await this.load(ctx, id);
    const now = this.clock.now();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'DESACTIVE', disabledAt: now, version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'compte désactivé' } });
      await this.audit.record(ctx, { action: 'users.desactivation', objectType: 'User', objectId: id, reason, before: { status: current.status }, after: { status: 'DESACTIVE' } }, tx);
    });
    return this.view(await this.load(ctx, id));
  }

  async enable(ctx: RequestContext, id: string): Promise<UserViewDto> {
    this.access.requireAdmin(ctx);
    await this.load(ctx, id);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'ACTIF', disabledAt: null, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'users.reactivation', objectType: 'User', objectId: id }, tx);
    });
    return this.view(await this.load(ctx, id));
  }

  /** Définition d'un mot de passe par l'administrateur (remise à zéro assistée). */
  async setPassword(ctx: RequestContext, id: string, password: string): Promise<void> {
    this.access.requireAdmin(ctx);
    await this.load(ctx, id);
    const weakness = this.passwords.validateStrength(password);
    if (weakness) throw new BusinessRuleError('MOT_DE_PASSE_FAIBLE', weakness, { fieldErrors: { password: [weakness] } });
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.client.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: this.clock.now(), version: { increment: 1 } } });
    await this.sessions.revokeAllForUser(id, 'mot de passe défini par l’administrateur');
    await this.audit.record(ctx, { action: 'users.mot_de_passe_defini', objectType: 'User', objectId: id });
  }

  async resendInvitation(ctx: RequestContext, id: string): Promise<void> {
    this.access.requireAdmin(ctx);
    const user = await this.load(ctx, id);
    if (!this.env.smtp) {
      throw new BusinessRuleError('CANAL_EMAIL_NON_CONFIGURE', 'Canal e-mail non configuré : générez un lien d’accès à usage unique et transmettez-le à l’utilisateur.');
    }
    if (user.status !== 'ACTIF') throw new BusinessRuleError('COMPTE_INACTIF', 'Le compte est désactivé.');
    await this.prisma.client.$transaction(async (tx) => {
      await this.enqueueInvitation(tx, user, ctx);
      await this.audit.record(ctx, { action: 'users.invitation', objectType: 'User', objectId: id }, tx);
    });
  }

  /**
   * Lien d'accès à usage unique remis par l'administrateur, indépendant de l'e-mail (16.1, D-263) :
   * invitation valable 72 h, réinitialisation 30 min. Le jeton n'est renvoyé qu'une fois ; seule son
   * empreinte SHA-256 est conservée ; les liens encore valides du compte sont invalidés.
   */
  async createAccessLink(ctx: RequestContext, id: string, purpose: 'INVITATION' | 'REINITIALISATION'): Promise<{ link: string; expiresAt: string }> {
    this.access.requireAdmin(ctx);
    const user = await this.load(ctx, id);
    if (user.status !== 'ACTIF') throw new BusinessRuleError('COMPTE_INACTIF', 'Le compte est désactivé : réactivez-le avant de générer un lien.');
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + (purpose === 'INVITATION' ? 72 * 3600 * 1000 : PASSWORD_RESET_LINK_TTL_MINUTES * 60 * 1000));
    await this.prisma.client.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      await tx.passwordResetToken.create({ data: { organizationId: ctx.organizationId, userId: id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt } });
      await this.audit.record(ctx, { action: 'users.lien_acces', objectType: 'User', objectId: id, after: { purpose, expiresAt: expiresAt.toISOString() } }, tx);
    });
    return { link: `${this.env.appOrigin}/reinitialisation?token=${token}`, expiresAt: expiresAt.toISOString() };
  }

  private async enqueueInvitation(tx: Prisma.TransactionClient, user: User, ctx: RequestContext): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    await tx.passwordResetToken.create({
      data: { organizationId: ctx.organizationId, userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(now.getTime() + 72 * 3600 * 1000) },
    });
    await tx.notificationOutbox.create({
      data: {
        organizationId: ctx.organizationId,
        kind: 'INVITATION',
        recipientUserId: user.id,
        recipientEmail: user.email,
        subject: 'Parc Auto — votre accès',
        bodyText: `Bonjour ${user.firstName},\n\nUn accès à Parc Auto a été créé pour vous. Définissez votre mot de passe sous 72 heures via ce lien :\n${this.env.appOrigin}/reinitialisation?token=${token}\n`,
        dedupeKey: `invitation:${user.id}:${now.getTime()}`,
      },
    });
  }

  private async validateMemberships(ctx: RequestContext, inputs: MembershipInputDto[]): Promise<Array<{ companyId: string | null; role: MembershipRole; grantedPermissions: Permission[]; revokedPermissions: Permission[] }>> {
    if (inputs.length === 0) throw new BusinessRuleError('HABILITATION_REQUISE', 'Au moins une habilitation est requise.', { fieldErrors: { memberships: ['Au moins une habilitation est requise.'] } });
    const out: Array<{ companyId: string | null; role: MembershipRole; grantedPermissions: Permission[]; revokedPermissions: Permission[] }> = [];
    const seen = new Set<string>();
    for (const m of inputs) {
      if (!ROLES.includes(m.role)) throw new BusinessRuleError('ROLE_INVALIDE', 'Rôle inconnu.');
      const companyId = m.companyId ?? null;
      if (m.role === 'ADMIN' && companyId !== null) throw new BusinessRuleError('ADMIN_NIVEAU_GROUPE', 'Le rôle administrateur s’applique au groupe entier (sans société).', { fieldErrors: { memberships: ['Le rôle ADMIN ne prend pas de société.'] } });
      if (m.role !== 'ADMIN' && companyId === null) throw new BusinessRuleError('SOCIETE_REQUISE', 'Une société est requise pour ce rôle.', { fieldErrors: { memberships: ['Société requise.'] } });
      if (companyId) {
        const company = await this.prisma.client.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId }, select: { id: true } });
        if (!company) throw new NotFoundOrOutOfScopeError('Société');
      }
      const key = companyId ?? 'groupe';
      if (seen.has(key)) throw new BusinessRuleError('HABILITATION_DOUBLON', 'Une seule habilitation par société.');
      seen.add(key);
      out.push({
        companyId,
        role: m.role,
        grantedPermissions: (m.grantedPermissions ?? []).map((p) => PERMISSION_TO_ENUM[p]),
        revokedPermissions: (m.revokedPermissions ?? []).map((p) => PERMISSION_TO_ENUM[p]),
      });
    }
    return out;
  }

  private async assertDriverLinkable(ctx: RequestContext, driverId: string, userId: string | null): Promise<void> {
    const driver = await this.prisma.client.driver.findFirst({ where: { id: driverId, organizationId: ctx.organizationId }, select: { userId: true } });
    if (!driver) throw new NotFoundOrOutOfScopeError('Conducteur');
    if (driver.userId && driver.userId !== userId) throw new ConflictError('CONDUCTEUR_DEJA_LIE', 'Ce conducteur est déjà lié à un autre compte.');
  }

  private include() {
    return { memberships: { include: { company: { select: { code: true, legalName: true } } } }, driver: { select: { id: true } } } as const;
  }

  private async load(ctx: RequestContext, id: string): Promise<UserWithMemberships> {
    const user = await this.prisma.client.user.findFirst({ where: { id, organizationId: ctx.organizationId }, include: this.include() });
    if (!user) throw new NotFoundOrOutOfScopeError('Utilisateur');
    return user;
  }

  private view(u: UserWithMemberships): UserViewDto {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      status: u.status,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      driverId: u.driver?.id ?? null,
      hasPassword: u.passwordHash !== null,
      memberships: u.memberships.map((m) => ({
        id: m.id,
        companyId: m.companyId,
        companyCode: m.company?.code ?? null,
        companyName: m.company?.legalName ?? null,
        role: m.role,
        grantedPermissions: m.grantedPermissions.map((p) => ENUM_TO_PERMISSION[p]),
        revokedPermissions: m.revokedPermissions.map((p) => ENUM_TO_PERMISSION[p]),
        effectivePermissions: [...effectivePermissions(m.role, m.grantedPermissions, m.revokedPermissions)].map((p) => ENUM_TO_PERMISSION[p]),
      })),
      createdAt: u.createdAt.toISOString(),
      version: u.version,
    };
  }
}

function membershipSummary(m: Membership): { companyId: string | null; role: MembershipRole } {
  return { companyId: m.companyId, role: m.role };
}
