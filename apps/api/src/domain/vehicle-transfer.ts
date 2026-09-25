import { compareCivil, type CivilDate } from './civil-date.js';

/**
 * Règles du transfert d'un véhicule entre sociétés (CDC 2.4, 11.3 ; D-119 à D-125) — implémentation
 * unique, sans accès aux données.
 *  - Bloquent le transfert : utilisation EN_COURS, immobilisation ACTIVE, intervention BROUILLON,
 *    PLANIFIEE ou EN_COURS, réservation CONFIRMEE dont la fin est postérieure à l'instant du transfert.
 *  - Avertissements à acquitter, sans blocage : relevés EN_ATTENTE, pleins SOUMIS, incidents ouverts.
 *  - « Réexamen explicite » : une décision par objet (affectation active, chaque plan actif, site,
 *    service, versions de documents partagées, relevé de transfert ou motif de son absence).
 */

export const TRANSFER_BLOCKER_TYPES = ['UTILISATION_EN_COURS', 'IMMOBILISATION_ACTIVE', 'INTERVENTION_OUVERTE', 'RESERVATION_A_TRAITER'] as const;
export type TransferBlockerType = (typeof TRANSFER_BLOCKER_TYPES)[number];

export const TRANSFER_WARNING_TYPES = ['RELEVE_EN_ATTENTE', 'PLEIN_SOUMIS', 'INCIDENT_OUVERT'] as const;
export type TransferWarningType = (typeof TRANSFER_WARNING_TYPES)[number];

export const TRANSFER_BLOCKER_LABELS: Readonly<Record<TransferBlockerType, string>> = {
  UTILISATION_EN_COURS: 'Utilisation en cours : enregistrez la restitution.',
  IMMOBILISATION_ACTIVE: 'Immobilisation active : clôturez-la.',
  INTERVENTION_OUVERTE: 'Intervention ouverte : terminez-la ou annulez-la avec un motif.',
  RESERVATION_A_TRAITER: 'Réservation future non traitée : annulez-la avec un motif ou attendez sa fin.',
};

export const TRANSFER_WARNING_LABELS: Readonly<Record<TransferWarningType, string>> = {
  RELEVE_EN_ATTENTE: 'Relevé kilométrique en attente de validation : il restera rattaché à la société d’origine.',
  PLEIN_SOUMIS: 'Plein soumis non validé : il restera rattaché à la société d’origine.',
  INCIDENT_OUVERT: 'Incident ouvert : il reste suivi par la société d’origine (non bloquant).',
};

/** Statuts d'intervention « ouverte » qui bloquent le transfert (D-119). */
export const TRANSFER_BLOCKING_INTERVENTION_STATUSES = ['BROUILLON', 'PLANIFIEE', 'EN_COURS'] as const;

/** Statuts d'incident signalés comme ouverts au transfert (non bloquants, D-119). */
export const TRANSFER_OPEN_INCIDENT_STATUSES = ['OUVERT', 'EN_TRAITEMENT'] as const;

/**
 * Types d'objets dont les alertes actives restent à la société d'origine après le transfert : événements
 * datés qu'elle conserve (société historique, 2.4) et encore ouverts — incident, relevé ou plein en
 * attente, anomalie carburant télématique à qualifier (FuelEvent) ; la condition ne cesse pas (9.2).
 */
export const ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN: readonly string[] = ['Incident', 'OdometerReading', 'FuelEntry', 'FuelEvent'];

/** Réservation à traiter avant le transfert : CONFIRMEE et fin postérieure à l'instant du transfert (D-119, D-125). */
export function isReservationBlocking(reservation: { status: string; endAt: Date }, transferAt: Date): boolean {
  return reservation.status === 'CONFIRMEE' && reservation.endAt.getTime() > transferAt.getTime();
}

/**
 * Présélection d'une version de document véhicule pour le partage (D-123, D-125) : version valable ou
 * future au jour local du transfert (sans date de fin, ou fin au plus tôt ce jour-là).
 */
export function isDocumentShareSuggested(version: { validTo: CivilDate | null }, today: CivilDate): boolean {
  return version.validTo === null || compareCivil(version.validTo, today) >= 0;
}

export type PlanDecision = 'KEEP' | 'DEACTIVATE';

export interface TransferExpectations {
  /** Affectation habituelle en cours ou future (conducteur de la société d'origine). */
  hasOpenAssignment: boolean;
  /** Plans d'entretien actifs du véhicule, chacun exigeant une décision. */
  activePlanIds: readonly string[];
  /** Versions de documents véhicule partageables. */
  documentVersionIds: readonly string[];
  /** Au moins un avertissement (relevé, plein en attente, incident ouvert). */
  hasWarnings: boolean;
}

export interface TransferDecisions {
  closeAssignment: boolean | undefined;
  plans: ReadonlyArray<{ planId: string; decision: PlanDecision; responsibleUserId?: string | null }>;
  sharedDocumentVersionIds: readonly string[];
  hasTransferReading: boolean;
  noReadingReason: string | null | undefined;
  acknowledgeWarnings: boolean | undefined;
}

export type TransferDecisionErrors = Record<string, string[]>;

/**
 * Contrôle des décisions du formulaire de transfert contre les objets à réexaminer (D-120, D-121,
 * D-124, D-125). Renvoie les erreurs par champ ; un objet vide signifie que les décisions sont complètes.
 */
export function checkTransferDecisions(expected: TransferExpectations, decisions: TransferDecisions): TransferDecisionErrors {
  const errors: TransferDecisionErrors = {};
  const add = (field: string, message: string) => {
    (errors[field] ??= []).push(message);
  };

  if (expected.hasOpenAssignment && decisions.closeAssignment !== true) {
    add('assignment.closeCurrent', 'L’affectation habituelle en cours doit être clôturée : son conducteur relève de la société d’origine.');
  }

  const active = new Set(expected.activePlanIds);
  const seen = new Set<string>();
  decisions.plans.forEach((p, index) => {
    if (!active.has(p.planId)) add(`plans.${index}.planId`, 'Plan inconnu ou inactif pour ce véhicule.');
    if (seen.has(p.planId)) add(`plans.${index}.planId`, 'Une seule décision par plan.');
    seen.add(p.planId);
    if (p.decision === 'DEACTIVATE' && p.responsibleUserId) add(`plans.${index}.responsibleUserId`, 'Un plan désactivé ne reçoit pas de responsable.');
  });
  const missing = expected.activePlanIds.filter((id) => !seen.has(id));
  if (missing.length > 0) add('plans', `Décision manquante (KEEP ou DEACTIVATE) pour ${missing.length} plan(s) actif(s).`);

  const shareable = new Set(expected.documentVersionIds);
  if (decisions.sharedDocumentVersionIds.some((id) => !shareable.has(id))) {
    add('sharedDocumentVersionIds', 'Seules les versions de documents de ce véhicule peuvent être partagées.');
  }

  const reason = decisions.noReadingReason?.trim() ?? '';
  if (decisions.hasTransferReading && reason.length > 0) {
    add('noReadingReason', 'Un relevé de transfert est fourni : le motif d’absence de relevé ne s’applique pas.');
  }
  if (!decisions.hasTransferReading && reason.length < 3) {
    add('noReadingReason', 'Sans relevé de transfert, indiquez le motif (les distances de la période seront non ventilables).');
  }

  if (expected.hasWarnings && decisions.acknowledgeWarnings !== true) {
    add('acknowledgeWarnings', 'Acquittez les avertissements (relevés ou pleins en attente, incidents ouverts) avant de transférer.');
  }
  return errors;
}
