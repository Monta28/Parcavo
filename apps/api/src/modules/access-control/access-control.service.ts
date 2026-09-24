import { Injectable } from '@nestjs/common';
import type { MembershipRole, Permission } from '@parc-auto/db';
import type { PermissionKey } from '@parc-auto/contracts';
import { ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { MANAGER_ROLES, OPERATIONAL_ROLES, PERMISSION_TO_ENUM, READ_ROLES } from './permissions.js';

/**
 * Décisions d'autorisation (CDC 2.2, 2.3). Toutes les vérifications ont lieu côté serveur, au point
 * d'accès aux données : un objet hors périmètre est traité comme inexistant (404).
 */
@Injectable()
export class AccessControlService {
  /** Sociétés lisibles par l'utilisateur (toutes pour l'administrateur). */
  visibleCompanyIds(ctx: RequestContext): readonly string[] {
    return ctx.visibleCompanyIds;
  }

  /** Filtre Prisma de périmètre : organisation + sociétés visibles (ou filtre explicite recoupé). */
  companyWhere(ctx: RequestContext, requestedCompanyId?: string | null): { organizationId: string; companyId?: string | { in: string[] } } {
    if (requestedCompanyId) {
      this.assertCompanyReadable(ctx, requestedCompanyId);
      return { organizationId: ctx.organizationId, companyId: requestedCompanyId };
    }
    if (ctx.isAdmin) return { organizationId: ctx.organizationId };
    return { organizationId: ctx.organizationId, companyId: { in: [...ctx.visibleCompanyIds] } };
  }

  canReadCompany(ctx: RequestContext, companyId: string): boolean {
    return ctx.isAdmin || ctx.grants.has(companyId);
  }

  /** Lève 404 si la société n'est pas dans le périmètre (ne révèle pas son existence). */
  assertCompanyReadable(ctx: RequestContext, companyId: string | null | undefined): void {
    if (!companyId || !this.canReadCompany(ctx, companyId)) {
      throw new NotFoundOrOutOfScopeError();
    }
  }

  roleIn(ctx: RequestContext, companyId: string): MembershipRole | null {
    if (ctx.isAdmin) return 'ADMIN';
    return ctx.grants.get(companyId)?.role ?? null;
  }

  hasRole(ctx: RequestContext, companyId: string, roles: readonly MembershipRole[]): boolean {
    const role = this.roleIn(ctx, companyId);
    return role !== null && roles.includes(role);
  }

  hasPermission(ctx: RequestContext, companyId: string, permission: PermissionKey): boolean {
    if (ctx.isAdmin) return true;
    const grant = ctx.grants.get(companyId);
    return grant !== undefined && grant.permissions.has(PERMISSION_TO_ENUM[permission]);
  }

  /** Vrai si la permission est détenue sur au moins une société visible. */
  hasPermissionAnywhere(ctx: RequestContext, permission: PermissionKey): boolean {
    if (ctx.isAdmin) return true;
    const p: Permission = PERMISSION_TO_ENUM[permission];
    for (const grant of ctx.grants.values()) if (grant.permissions.has(p)) return true;
    return false;
  }

  requireAdmin(ctx: RequestContext): void {
    if (!ctx.isAdmin) throw new ForbiddenActionError('Réservé à l’administrateur groupe.');
  }

  /** Accès aux données de gestion : refusé aux comptes uniquement conducteurs. */
  requireStaff(ctx: RequestContext): void {
    if (ctx.isDriverOnly) throw new ForbiddenActionError('Accès réservé au personnel de gestion du parc.');
  }

  requireRole(ctx: RequestContext, companyId: string, roles: readonly MembershipRole[], message?: string): void {
    this.assertCompanyReadable(ctx, companyId);
    if (!this.hasRole(ctx, companyId, roles)) {
      throw new ForbiddenActionError(message ?? 'Votre rôle ne permet pas cette action sur cette société.');
    }
  }

  requireOperational(ctx: RequestContext, companyId: string): void {
    this.requireRole(ctx, companyId, OPERATIONAL_ROLES, 'Action réservée aux opérateurs, chefs de parc et administrateurs.');
  }

  requireManager(ctx: RequestContext, companyId: string): void {
    this.requireRole(ctx, companyId, MANAGER_ROLES, 'Action réservée au chef de parc ou à l’administrateur.');
  }

  requireReader(ctx: RequestContext, companyId: string): void {
    this.requireRole(ctx, companyId, READ_ROLES, 'Accès en lecture non autorisé.');
  }

  requirePermission(ctx: RequestContext, companyId: string, permission: PermissionKey, message?: string): void {
    this.assertCompanyReadable(ctx, companyId);
    if (!this.hasPermission(ctx, companyId, permission)) {
      throw new ForbiddenActionError(message ?? `Permission « ${permission} » requise.`, { permission });
    }
  }

  /** Sociétés sur lesquelles l'utilisateur détient une permission donnée. */
  companiesWithPermission(ctx: RequestContext, permission: PermissionKey): readonly string[] {
    if (ctx.isAdmin) return ctx.visibleCompanyIds;
    const p = PERMISSION_TO_ENUM[permission];
    return [...ctx.grants.values()].filter((g) => g.permissions.has(p)).map((g) => g.companyId);
  }

  /** Sociétés sur lesquelles l'utilisateur détient l'un des rôles donnés. */
  companiesWithRole(ctx: RequestContext, roles: readonly MembershipRole[]): readonly string[] {
    if (ctx.isAdmin) return ctx.visibleCompanyIds;
    return [...ctx.grants.values()].filter((g) => roles.includes(g.role)).map((g) => g.companyId);
  }
}
