import { BusinessRuleError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../infra/prisma.service.js';
import type { AccessControlService } from '../access-control/access-control.service.js';
import { companyAt } from '../odometer/odometer-ingestion.service.js';

/**
 * Société propriétaire d'un événement daté (relevé, plein, dépense, incident, localisation ; D-121) : la
 * société qui gérait le véhicule à la date de l'événement, d'après l'historique des transferts. Un membre
 * du personnel ne peut enregistrer l'événement que s'il est habilité sur cette société (l'administrateur
 * l'est partout) ; sinon 422 PERIODE_HORS_PERIMETRE. Un conducteur est contrôlé par ses propres règles
 * (son utilisation), qui fixent déjà la période admise.
 */
export async function eventCompany(
  tx: Tx,
  access: AccessControlService,
  ctx: RequestContext,
  vehicle: { id: string; companyId: string },
  at: Date,
  what: string,
): Promise<string> {
  const companyId = await companyAt(tx, vehicle.id, at, vehicle.companyId);
  if (!ctx.isDriverOnly && !access.canReadCompany(ctx, companyId)) {
    throw new BusinessRuleError('PERIODE_HORS_PERIMETRE', `À cette date, le véhicule relevait d’une autre société : seul un utilisateur habilité sur cette société peut y enregistrer ${what}.`);
  }
  return companyId;
}
