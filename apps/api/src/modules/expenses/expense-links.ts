import type { Prisma } from '@parc-auto/db';
import type { RequestContext } from '../../common/request-context.js';
import type { AccessControlService } from '../access-control/access-control.service.js';

/**
 * Dépenses liées à un incident (D-217) : rattachées explicitement (relatedIncidentId) ou dépenses de
 * synthèse des interventions issues de l'incident. Définition unique, partagée par le registre
 * (filtre « incident lié ») et par le coût lié affiché sur l'incident.
 */
export function incidentExpensesWhere(incidentId: string, interventionIds: readonly string[]): Prisma.ExpenseWhereInput {
  return {
    OR: [{ relatedIncidentId: incidentId }, ...(interventionIds.length > 0 ? [{ sourceType: 'INTERVENTION' as const, sourceId: { in: [...interventionIds] } }] : [])],
  };
}

/**
 * Périmètre de lecture des coûts (CDC 2.3, 2.4, 8.4) : dépenses des seules sociétés où l'utilisateur
 * détient costs.read (toute l'organisation pour l'administrateur). Appliqué à chaque liste et à chaque
 * agrégat : une dépense d'une autre société rattachée au même incident ou au même véhicule (après un
 * transfert) n'est jamais additionnée ni montrée.
 */
export function costsReadableWhere(ctx: RequestContext, access: AccessControlService): Prisma.ExpenseWhereInput {
  if (ctx.isAdmin) return { organizationId: ctx.organizationId };
  return { organizationId: ctx.organizationId, companyId: { in: [...access.companiesWithPermission(ctx, 'costs.read')] } };
}
