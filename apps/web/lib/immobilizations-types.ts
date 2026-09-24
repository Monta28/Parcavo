// Types des réponses de l'API immobilisations (apps/api/src/modules/immobilizations, ImmobilizationViewDto).

export type ImmobilizationStatus = 'ACTIVE' | 'TERMINEE';
export type ImmobilizationCauseKind = 'INCIDENT' | 'INTERVENTION' | 'AUTRE';

export const IMMOBILIZATION_STATUS_LABELS: Record<ImmobilizationStatus, string> = {
  ACTIVE: 'Active',
  TERMINEE: 'Terminée',
};

export const IMMOBILIZATION_CAUSE_KIND_LABELS: Record<ImmobilizationCauseKind, string> = {
  INCIDENT: 'Incident',
  INTERVENTION: 'Intervention',
  AUTRE: 'Autre motif',
};

export interface ImmobilizationCauseView {
  id: string;
  kind: ImmobilizationCauseKind;
  reason: string;
  incidentId: string | null;
  incidentReference: string | null;
  interventionId: string | null;
  interventionReference: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** Durée propre de la cause, calculée par l'API (heures, une décimale ; jusqu'à maintenant si ouverte). */
  durationHours: number;
  /** Durée propre de la cause en jours (une décimale). */
  durationDays: number;
}

/** Vue immobilisation (GET /immobilizations, GET /immobilizations/:id et réponses des actions). */
export interface ImmobilizationView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  status: ImmobilizationStatus;
  startedAt: string;
  expectedEndAt: string | null;
  endedAt: string | null;
  siteId: string | null;
  siteName: string | null;
  garageSupplierId: string | null;
  garageName: string | null;
  locationLabel: string | null;
  /** Durée totale calculée par l'API (union des causes, jusqu'à maintenant si en cours), en heures, une décimale. */
  durationHours: number;
  /** Même durée totale en jours, une décimale. */
  durationDays: number;
  /** Vrai si la somme des durées des causes dépasse le total (causes superposées). */
  causesOverlap: boolean;
  /** Mention fournie par l'API : « la somme des causes peut dépasser le total ». */
  causeDurationsNote: string;
  /** Utilisation en cours pendant l'immobilisation (conservée, restitution possible). */
  openUsageId: string | null;
  causes: ImmobilizationCauseView[];
  version: number;
}
