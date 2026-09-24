// Types des réponses de l'API réservations et planning (apps/api/src/modules/reservations :
// ReservationViewDto, PlanningResponseDto) et du résumé conducteur (GET /drivers/summaries) utilisés par le web.
import type { RESERVATION_STATUS_LABELS } from '@parc-auto/contracts';

export type ReservationStatus = keyof typeof RESERVATION_STATUS_LABELS;

export const RESERVATION_STATUSES: ReservationStatus[] = ['CONFIRMEE', 'CONVERTIE', 'ANNULEE', 'NON_HONOREE'];

/** Vue réservation (GET /reservations, GET /reservations/:id, POST, PATCH, cancel, no-show). */
export interface ReservationView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  driverId: string;
  driverName: string;
  /** Début prévu (inclus). */
  startAt: string;
  /** Fin prévue (exclue) : [début, fin[. */
  endAt: string;
  purpose: string;
  destination: string | null;
  siteId: string | null;
  comment: string | null;
  status: ReservationStatus;
  convertedUsageId: string | null;
  cancelledAt: string | null;
  /** Motif d'annulation ou de non-présentation. */
  cancelReason: string | null;
  /** Date du passage en NON_HONOREE (constat manuel ou rattrapage automatique). */
  noShowAt: string | null;
  /** Auteur de l'annulation ou du constat manuel de non-présentation (null pour le rattrapage automatique). */
  closedByName: string | null;
  /** Réservation CONFIRMEE : tout est modifiable avant le début prévu, seulement la fin ensuite (calculé par l'API) ; null sinon. */
  editScope: 'COMPLETE' | 'FIN_SEULEMENT' | null;
  /** Réservation CONFIRMEE : premier instant du constat de non-présentation (calculé par l'API) ; null sinon. */
  noShowAllowedFrom: string | null;
  createdByName: string | null;
  createdAt: string;
  version: number;
}

export type PlanningItemKind = 'RESERVATION' | 'UTILISATION' | 'IMMOBILISATION' | 'INTERVENTION';

/** Élément du planning (GET /planning) : réservations, utilisations, immobilisations et interventions qui chevauchent la fenêtre. */
export interface PlanningItem {
  kind: PlanningItemKind;
  id: string;
  /** Société de l'élément : les actions proposées en dépendent (l'API reste juge). */
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  driverName: string | null;
  startAt: string;
  /** Fin prévue ou réelle ; null si ouverte sans fin connue. */
  endAt: string | null;
  /** Statut propre au type : réservation, utilisation, immobilisation ou intervention. */
  status: string;
  label: string;
  /** Retour dépassé (utilisation) ou fin prévue dépassée (intervention), calculé par l'API. */
  isLate: boolean;
}

/** Avertissement sans blocage (GET /planning) : intervention planifiée ou en cours qui chevauche une réservation confirmée. */
export interface PlanningWarning {
  code: 'INTERVENTION_CHEVAUCHE_RESERVATION';
  message: string;
  vehicleId: string;
  vehicleCode: string;
  /** Société de la réservation concernée. */
  companyId: string;
  interventionId: string;
  interventionReference: string;
  reservationId: string;
  driverName: string;
}

/** Réponse de GET /planning. */
export interface PlanningResponse {
  items: PlanningItem[];
  warnings: PlanningWarning[];
}

export const PLANNING_KIND_LABELS: Record<PlanningItemKind, string> = {
  RESERVATION: 'Réservation',
  UTILISATION: 'Utilisation',
  IMMOBILISATION: 'Immobilisation',
  INTERVENTION: 'Intervention',
};

/** Conducteur actif d'une société (GET /drivers/summaries?companyId=). */
export interface DriverSummary {
  id: string;
  companyId: string;
  code: string;
  firstName: string;
  lastName: string;
  status: string;
}
