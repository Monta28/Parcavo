/**
 * Affectation habituelle (responsable habituel, CDC 4.1 ; D-136) : période [début, fin[ avec fin null =
 * sans fin prévue. Seule définition côté backend de l'état d'une affectation à un instant donné, utilisée
 * par la vue d'affectation, la synthèse véhicule, la visibilité du conducteur, le remplacement explicite,
 * la sortie du parc et le véhicule de soumission du conducteur (D-268).
 */

export type AssignmentStatus = 'A_VENIR' | 'EN_COURS' | 'TERMINEE';

export interface AssignmentPeriod {
  startsAt: Date;
  endsAt: Date | null;
}

/** A_VENIR si le début est futur ; EN_COURS si début ≤ maintenant et (sans fin ou fin > maintenant) ; sinon TERMINEE. */
export function assignmentStatus(period: AssignmentPeriod, now: Date): AssignmentStatus {
  if (period.startsAt.getTime() > now.getTime()) return 'A_VENIR';
  if (period.endsAt === null || period.endsAt.getTime() > now.getTime()) return 'EN_COURS';
  return 'TERMINEE';
}

/** Vrai si l'affectation couvre l'instant présent (même règle que assignmentStatus). */
export function isAssignmentCurrent(period: AssignmentPeriod, now: Date): boolean {
  return assignmentStatus(period, now) === 'EN_COURS';
}

/** Une affectation peut encore être terminée (ou recevoir une fin) tant qu'elle n'est pas TERMINEE. */
export function canEndAssignment(period: AssignmentPeriod, now: Date): boolean {
  return assignmentStatus(period, now) !== 'TERMINEE';
}

/**
 * Traduction en filtre de base de données de « EN_COURS » : startsAt ≤ maintenant ET (endsAt null OU
 * endsAt > maintenant). Toute lecture en base des affectations en cours passe par cette clause.
 */
export function currentAssignmentWhere(now: Date): { startsAt: { lte: Date }; OR: [{ endsAt: null }, { endsAt: { gt: Date } }] } {
  return { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
}

/** Traduction en filtre de base de données de « A_VENIR » : début strictement futur. */
export function upcomingAssignmentWhere(now: Date): { startsAt: { gt: Date } } {
  return { startsAt: { gt: now } };
}

export type ReplacementDecision =
  /** L'affectation en cours est clôturée au début de la nouvelle. */
  | { action: 'CLOTURER'; endsAt: Date }
  /** Rien à remplacer : pas d'affectation en cours, ou sa fin prévue précède le début de la nouvelle. */
  | { action: 'AUCUNE' }
  /** Le nouveau responsable doit prendre effet après le début de l'affectation en cours. */
  | { action: 'REFUS_DEBUT_ANTERIEUR' };

/**
 * Remplacement explicite du responsable EN_COURS (replaceCurrent) par une affectation débutant à
 * `newStartsAt`. L'affectation en cours n'est jamais prolongée : si sa fin prévue précède déjà le début
 * de la nouvelle, elle est laissée intacte.
 */
export function replacementDecision(current: AssignmentPeriod | null, newStartsAt: Date): ReplacementDecision {
  if (!current) return { action: 'AUCUNE' };
  if (newStartsAt.getTime() <= current.startsAt.getTime()) return { action: 'REFUS_DEBUT_ANTERIEUR' };
  if (current.endsAt !== null && current.endsAt.getTime() <= newStartsAt.getTime()) return { action: 'AUCUNE' };
  return { action: 'CLOTURER', endsAt: newStartsAt };
}

export type AssignmentField = 'driverId' | 'startsAt' | 'endsAt' | 'notes';

/**
 * Champs modifiables d'une affectation (CDC 15.2 « modifier », 4.1) : une affectation à venir est entièrement
 * modifiable ; une affectation EN_COURS ne change ni de responsable ni de début (l'historique de conduite
 * habituelle est conservé : un autre responsable passe par un remplacement explicite), seules sa fin prévue
 * et ses notes changent ; une affectation terminée n'est plus modifiable.
 */
export function editableAssignmentFields(period: AssignmentPeriod, now: Date): AssignmentField[] {
  const status = assignmentStatus(period, now);
  if (status === 'A_VENIR') return ['driverId', 'startsAt', 'endsAt', 'notes'];
  if (status === 'EN_COURS') return ['endsAt', 'notes'];
  return [];
}

/**
 * Nouvelle fin prévue fixée par une modification : absente (sans fin) ou strictement future. Terminer une
 * affectation maintenant ou à une date passée reste l'action « terminer », avec son motif de fin.
 */
export function isAcceptableUpdatedEnd(endsAt: Date | null, now: Date): boolean {
  return endsAt === null || endsAt.getTime() > now.getTime();
}

/** Cycles de vie qui interdisent toute nouvelle affectation habituelle (véhicule sorti du parc). */
export function vehicleAcceptsAssignment(lifecycleStatus: string): boolean {
  return lifecycleStatus !== 'CEDE' && lifecycleStatus !== 'ARCHIVE';
}

// ---------------------------------------------------------------------------
// Véhicule sur lequel un conducteur peut soumettre (D-116, D-268)
// ---------------------------------------------------------------------------

export type SubmissionBasis = 'UTILISATION_EN_COURS' | 'RESPONSABLE_HABITUEL';

export interface SubmissionTarget {
  vehicleId: string;
  companyId: string;
  basis: SubmissionBasis;
  /** Utilisation EN_COURS (base UTILISATION_EN_COURS), sinon null. */
  usageId: string | null;
  /** Affectation habituelle en cours (base RESPONSABLE_HABITUEL), sinon null. */
  assignmentId: string | null;
}

export interface SubmissionTargetInput {
  driver: { status: string; companyId: string };
  /** Utilisation EN_COURS du conducteur (au plus une, CDC 4.3), avec l'état courant de son véhicule. */
  openUsage: { id: string; vehicleId: string; companyId: string } | null;
  /** Affectations habituelles du conducteur candidates, avec l'état courant de leur véhicule. */
  assignments: ReadonlyArray<AssignmentPeriod & { id: string; vehicleId: string; companyId: string; vehicle: { companyId: string; lifecycleStatus: string } }>;
  /** Paramètre drivers.allowHabitualVehicleSubmissions (niveau groupe). */
  allowHabitualVehicleSubmissions: boolean;
  now: Date;
}

/**
 * Véhicules sur lesquels le conducteur peut soumettre maintenant (relevé, incident, ticket carburant) :
 * le véhicule de son utilisation EN_COURS ; sinon, si le paramètre l'autorise, chaque véhicule dont il est
 * responsable habituel EN_COURS, encore dans le parc et dans sa société courante (2.4). Un conducteur
 * inactif ne soumet rien. Les délais de soumission après restitution restent propres à chaque module.
 */
export function submissionTargets(input: SubmissionTargetInput): SubmissionTarget[] {
  if (input.driver.status !== 'ACTIF') return [];
  if (input.openUsage) return [{ vehicleId: input.openUsage.vehicleId, companyId: input.openUsage.companyId, basis: 'UTILISATION_EN_COURS', usageId: input.openUsage.id, assignmentId: null }];
  if (!input.allowHabitualVehicleSubmissions) return [];
  return input.assignments
    .filter((a) => isAssignmentCurrent(a, input.now) && vehicleAcceptsAssignment(a.vehicle.lifecycleStatus) && a.vehicle.companyId === a.companyId && a.companyId === input.driver.companyId)
    .map((a) => ({ vehicleId: a.vehicleId, companyId: a.companyId, basis: 'RESPONSABLE_HABITUEL' as const, usageId: null, assignmentId: a.id }));
}
