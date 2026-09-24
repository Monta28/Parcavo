import type { IncidentStatus } from '@parc-auto/db';
import { ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { incidentAcceptsIntervention } from '../../domain/intervention-rules.js';
import type { Tx } from '../../infra/prisma.service.js';

/**
 * Contrôle d'état unique de l'incident source d'une intervention (6.3, D-215), partagé par
 * POST /incidents/:id/intervention et POST /interventions avec incidentId : un incident clôturé
 * n'accepte plus aucune intervention (409 ETAT_INVALIDE).
 */
export function assertIncidentAcceptsIntervention(incident: { status: IncidentStatus; reference: string }): void {
  if (!incidentAcceptsIntervention(incident.status)) {
    throw new ConflictError('ETAT_INVALIDE', `L’incident ${incident.reference} est clôturé : aucune intervention ne peut plus y être rattachée.`, { incidentStatus: incident.status });
  }
}

/**
 * Même contrôle, relu sous verrou (SELECT … FOR SHARE) dans la transaction qui crée l'intervention :
 * une clôture validée après le contrôle initial est vue ici, et une clôture concurrente attend la fin
 * de cette transaction avant de modifier l'incident.
 */
export async function assertIncidentAcceptsInterventionLocked(tx: Tx, incidentId: string): Promise<void> {
  const [incident] = await tx.$queryRaw<Array<{ status: IncidentStatus; reference: string }>>`SELECT status, reference FROM "Incident" WHERE id = ${incidentId}::uuid FOR SHARE`;
  if (!incident) throw new NotFoundOrOutOfScopeError('Incident');
  assertIncidentAcceptsIntervention(incident);
}
