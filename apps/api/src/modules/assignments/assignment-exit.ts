import type { VehicleResponsibleAssignment } from '@parc-auto/db';
import { assignmentStatus, currentAssignmentWhere, upcomingAssignmentWhere } from '../../domain/responsible-assignment.js';
import type { Tx } from '../../infra/prisma.service.js';

/**
 * Sortie du parc (CEDE ou ARCHIVE ; CDC 3.2, D-129) : l'affectation habituelle EN_COURS, sans
 * fin ou avec une fin future, est clôturée à `at` (version incrémentée) ; une affectation à venir, jamais
 * entrée en vigueur, est retirée (même traitement qu'au transfert, D-120). À appeler dans la transaction
 * qui a verrouillé le véhicule ; l'appelant journalise chaque objet renvoyé.
 */
export async function closeAssignmentsOnVehicleExit(tx: Tx, vehicleId: string, at: Date, endReason: string, endedById: string): Promise<{ closed: VehicleResponsibleAssignment[]; withdrawn: VehicleResponsibleAssignment[] }> {
  return closeOpenAssignments(tx, { vehicleId }, at, endReason, endedById);
}

/**
 * Désactivation d'un conducteur (CDC 3.3, D-131) : même traitement, sur ses affectations (en cours
 * clôturée à `at`, à venir retirée). À appeler dans la transaction qui a verrouillé le conducteur.
 */
export async function closeAssignmentsOnDriverDeactivation(tx: Tx, driverId: string, at: Date, endReason: string, endedById: string): Promise<{ closed: VehicleResponsibleAssignment[]; withdrawn: VehicleResponsibleAssignment[] }> {
  return closeOpenAssignments(tx, { driverId }, at, endReason, endedById);
}

async function closeOpenAssignments(tx: Tx, owner: { vehicleId: string } | { driverId: string }, at: Date, endReason: string, endedById: string): Promise<{ closed: VehicleResponsibleAssignment[]; withdrawn: VehicleResponsibleAssignment[] }> {
  const open = await tx.vehicleResponsibleAssignment.findMany({ where: { ...owner, OR: [currentAssignmentWhere(at), upcomingAssignmentWhere(at)] }, orderBy: { startsAt: 'asc' } });
  const closed: VehicleResponsibleAssignment[] = [];
  const withdrawn: VehicleResponsibleAssignment[] = [];
  for (const a of open) {
    const status = assignmentStatus(a, at);
    if (status === 'EN_COURS') {
      await tx.vehicleResponsibleAssignment.update({ where: { id: a.id, version: a.version }, data: { endsAt: at, endReason, endedById, version: { increment: 1 } } });
      closed.push(a);
    } else if (status === 'A_VENIR') {
      await tx.vehicleResponsibleAssignment.delete({ where: { id: a.id, version: a.version } });
      withdrawn.push(a);
    }
  }
  return { closed, withdrawn };
}
