// Types des réponses de l'API incidents (apps/api/src/modules/incidents, IncidentViewDto) utilisés par le web.
import type { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';

export type IncidentType = keyof typeof INCIDENT_TYPE_LABELS;
export type IncidentSeverity = keyof typeof INCIDENT_SEVERITY_LABELS;
export type IncidentStatus = keyof typeof INCIDENT_STATUS_LABELS;

/** Visibilité d'un commentaire (D-216) : interne au personnel ou partagé avec le conducteur. */
export type CommentVisibility = 'INTERNE' | 'PARTAGE_CONDUCTEUR';

export const COMMENT_VISIBILITY_LABELS: Record<CommentVisibility, string> = {
  INTERNE: 'Interne (personnel)',
  PARTAGE_CONDUCTEUR: 'Partagé avec le conducteur',
};

/** Vue incident (GET /incidents, GET /incidents/:id et réponses des actions). */
export interface IncidentView {
  id: string;
  reference: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  driverId: string | null;
  driverName: string | null;
  usageId: string | null;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  occurredAt: string;
  locationLabel: string | null;
  siteId: string | null;
  /** Nom du site déclaré (fourni par l'API). */
  siteName: string | null;
  description: string;
  /** Responsable du suivi (null pour un conducteur). */
  followUpUserId: string | null;
  /** Nom du responsable du suivi (null pour un conducteur). */
  followUpUserName: string | null;
  /** Note de résolution : suivi interne, jamais renvoyée à un compte conducteur (D-216). */
  resolutionNote: string | null;
  resolvedAt: string | null;
  closureNote: string | null;
  closedAt: string | null;
  photoAttachmentIds: string[];
  /** Interventions ouvertes depuis l'incident (vide pour un conducteur). */
  interventionIds: string[];
  /** Cause d'immobilisation ouverte liée à l'incident. */
  openImmobilizationCauseId: string | null;
  /** Coût lié calculé par l'API ; null sans la permission costs.read. */
  linkedCost: string | null;
  /** Contravention : utilisation en cours à l'instant déclaré, à titre d'information seulement (D-217). */
  usageAtTimeId: string | null;
  /** Conducteur de cette utilisation, à titre d'information (aucune responsabilité déduite). */
  usageAtTimeDriverId: string | null;
  usageAtTimeDriverName: string | null;
  version: number;
}

/** Responsable de suivi possible (GET /incidents/follow-up-candidates?companyId=) : nom seulement. */
export interface FollowUpCandidate {
  id: string;
  name: string;
}

/** Réponse de POST /incidents/:id/immobilize : immobilisation créée ou complétée et incident à jour. */
export interface IncidentImmobilizeResult {
  immobilizationId: string;
  causeId: string;
  /** Vrai : nouvelle immobilisation ; faux : cause ajoutée à l'immobilisation active du véhicule. */
  created: boolean;
  /** Lieu saisi appliqué à l'immobilisation. */
  placeApplied: boolean;
  /** Fin prévue saisie appliquée à l'immobilisation. */
  expectedEndApplied: boolean;
  incident: IncidentView;
}

/** Commentaire chronologique (GET/POST /incidents/:id/comments), jamais modifié. */
export interface IncidentCommentView {
  id: string;
  body: string;
  visibility: CommentVisibility;
  authorName: string | null;
  createdAt: string;
}

/** Intervention ouverte depuis l'incident (POST /incidents/:id/intervention, GET /interventions/:id) : champs lus. */
export interface IncidentInterventionRef {
  id: string;
  reference: string;
  status: string;
  kind: string;
  supplierName: string | null;
}

/** Conducteur actif d'une société (GET /drivers/summaries?companyId=). */
export interface DriverSummary {
  id: string;
  companyId: string;
  code: string;
  firstName: string;
  lastName: string;
  status: string;
}
