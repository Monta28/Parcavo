import type { Prisma } from '@parc-auto/db';
import type { RequestContext } from '../../common/request-context.js';

/**
 * Pleins visibles d'un compte conducteur (CDC 2.3, D-226) : ses propres soumissions uniquement, soumises
 * par son compte et à son nom. Un plein saisi par le personnel, même au nom du conducteur, n'en fait pas
 * partie (pas de facture ni de montant d'achat du personnel), et une correction qui change de conducteur
 * n'est plus la sienne. Règle unique, partagée par la liste, le détail et l'accès aux tickets
 * (OwnerAuthorizationService).
 */
export function driverOwnWhere(ctx: Pick<RequestContext, 'organizationId' | 'userId' | 'driverId'>): Prisma.FuelEntryWhereInput {
  if (!ctx.driverId) return { id: { in: [] } };
  return { organizationId: ctx.organizationId, submittedById: ctx.userId, driverId: ctx.driverId };
}
