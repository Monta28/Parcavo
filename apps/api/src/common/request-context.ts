import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MembershipRole, Permission } from '@parc-auto/db';
import type { Request } from 'express';

/**
 * Contexte d'autorisation calculé côté serveur pour chaque requête (CDC 2.3).
 * Les identifiants fournis par le navigateur ne font jamais autorité : le périmètre
 * (companyIds) vient exclusivement des habilitations enregistrées.
 */
export interface CompanyGrant {
  companyId: string;
  role: MembershipRole;
  permissions: ReadonlySet<Permission>;
}

export interface RequestContext {
  requestId: string;
  userId: string;
  organizationId: string;
  sessionId: string;
  email: string;
  displayName: string;
  /** Administrateur groupe : accès à toutes les sociétés de l'organisation. */
  isAdmin: boolean;
  /** Habilitations par société (hors administrateur). */
  grants: ReadonlyMap<string, CompanyGrant>;
  /** Identifiant du conducteur lié au compte, s'il existe. */
  driverId: string | null;
  /** Sociétés visibles en lecture (toutes pour l'administrateur, calculé au chargement). */
  visibleCompanyIds: readonly string[];
  /** Vrai si l'utilisateur n'a qu'un rôle CONDUCTEUR (périmètre restreint à ses utilisations). */
  isDriverOnly: boolean;
  ipAddress: string | null;
}

export interface RequestWithContext extends Request {
  context?: RequestContext;
  requestId: string;
}

export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<RequestWithContext>();
  if (!req.context) {
    throw new Error('RequestContext absent : la garde d’authentification doit précéder ce paramètre.');
  }
  return req.context;
});
