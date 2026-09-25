// Types des réponses de l'API audit (apps/api/src/modules/audit/dto/audit.dto.ts et dto/timeline.dto.ts).
// Aucune règle ici : périmètre, expurgation, visibilité après transfert (D-275) et montants (D-266) sont
// appliqués par le serveur ; le web se contente d'afficher.

export type AuditActorType = 'UTILISATEUR' | 'SYSTEME';

/** Événement du journal (AuditEventViewDto, GET /audit) : valeurs avant/après déjà expurgées. */
export interface AuditEventView {
  id: string;
  /** Horodatage UTC. */
  createdAt: string;
  companyId: string | null;
  companyCode: string | null;
  actorType: AuditActorType;
  actorUserId: string | null;
  /** Nom de l'utilisateur, ou « Système ». */
  actorName: string;
  action: string;
  objectType: string;
  objectId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ipAddress: string | null;
}

/** GET /audit/actions. */
export interface AuditActionFacet {
  action: string;
  count: number;
}

/** GET /audit/object-types. */
export interface AuditObjectTypeFacet {
  objectType: string;
  count: number;
}

/** GET /audit/actors. */
export interface AuditActorFacet {
  actorType: AuditActorType;
  actorUserId: string | null;
  actorName: string;
  count: number;
}

/**
 * Libellés français des types d'objets audités (noms de modèles renvoyés tels quels par l'API). Un type
 * absent de cette table est affiché avec son code brut : aucune valeur n'est masquée ni inventée.
 */
export const AUDIT_OBJECT_TYPE_LABELS: Readonly<Record<string, string>> = {
  Alert: 'Alerte',
  Attachment: 'Pièce jointe',
  Company: 'Société',
  Department: 'Service',
  DocumentType: 'Type de document',
  DocumentVersion: 'Document',
  Driver: 'Conducteur',
  DriverPermit: 'Permis de conduire',
  Expense: 'Dépense',
  FuelEntry: 'Plein de carburant',
  FuelEvent: 'Événement carburant télématique',
  FuelPurchaseGap: 'Période d’achats incomplets',
  Immobilization: 'Immobilisation',
  ImportBatch: 'Lot d’import',
  Incident: 'Incident',
  Intervention: 'Intervention',
  Job: 'Traitement planifié',
  MaintenancePlanTemplate: 'Modèle de plan d’entretien',
  MaintenanceType: 'Opération d’entretien',
  NotificationPreference: 'Préférences de notification',
  OdometerReading: 'Relevé kilométrique',
  OdometerSegment: 'Segment de compteur',
  Organization: 'Organisation',
  Rapport: 'Rapport',
  Reservation: 'Réservation',
  Setting: 'Paramètre',
  Site: 'Site',
  Supplier: 'Fournisseur',
  TelemetryCredential: 'Secret télématique',
  TelemetryProvider: 'Fournisseur télématique',
  TelemetryUnit: 'Boîtier télématique',
  TelemetryVehicleMapping: 'Association télématique',
  User: 'Utilisateur',
  Vehicle: 'Véhicule',
  VehicleCategory: 'Catégorie de véhicule',
  VehicleCompanyHistory: 'Changement de société',
  VehicleLocationReport: 'Localisation déclarée',
  VehicleMaintenancePlan: 'Plan d’entretien',
  VehicleResponsibleAssignment: 'Affectation habituelle',
  VehicleUsage: 'Utilisation',
};

export function objectTypeLabel(objectType: string): string {
  return AUDIT_OBJECT_TYPE_LABELS[objectType] ?? objectType;
}

// ---------------------------------------------------------------------------
// Chronologie du dossier véhicule (GET /vehicles/:id/timeline)
// ---------------------------------------------------------------------------

export type TimelineCategory =
  | 'DOSSIER'
  | 'UTILISATIONS'
  | 'KILOMETRAGE'
  | 'ENTRETIEN'
  | 'DOCUMENTS'
  | 'INCIDENTS'
  | 'IMMOBILISATIONS'
  | 'RESERVATIONS'
  | 'AFFECTATIONS';

/** Mêmes libellés que TIMELINE_CATEGORY_LABELS de l'API (renvoyés aussi dans chaque événement). */
export const TIMELINE_CATEGORY_LABELS: Readonly<Record<TimelineCategory, string>> = {
  DOSSIER: 'Dossier et société',
  UTILISATIONS: 'Utilisations',
  KILOMETRAGE: 'Kilométrage',
  ENTRETIEN: 'Entretien',
  DOCUMENTS: 'Documents',
  INCIDENTS: 'Incidents',
  IMMOBILISATIONS: 'Immobilisations',
  RESERVATIONS: 'Réservations',
  AFFECTATIONS: 'Affectations habituelles',
};

export const TIMELINE_CATEGORIES = Object.keys(TIMELINE_CATEGORY_LABELS) as TimelineCategory[];

export type TimelineEventType =
  | 'VEHICULE_CREE'
  | 'SOCIETE_TRANSFERT'
  | 'AFFECTATION_DEBUT'
  | 'RESERVATION_CREEE'
  | 'COMPTEUR_INITIALISE'
  | 'COMPTEUR_REMPLACE'
  | 'RELEVE'
  | 'UTILISATION_REMISE'
  | 'UTILISATION_RETOUR'
  | 'INCIDENT_DECLARE'
  | 'IMMOBILISATION_DEBUT'
  | 'PLAN_CREE'
  | 'INTERVENTION_CREEE'
  | 'INTERVENTION_TERMINEE'
  | 'INTERVENTION_ROUVERTE'
  | 'INTERVENTION_ANNULEE'
  | 'PLAN_DESACTIVE'
  | 'DOCUMENT_ENREGISTRE'
  | 'DOCUMENT_RENOUVELE'
  | 'INCIDENT_RESOLU'
  | 'INCIDENT_CLOTURE'
  | 'IMMOBILISATION_FIN'
  | 'RESERVATION_ANNULEE'
  | 'RESERVATION_NON_HONOREE'
  | 'AFFECTATION_FIN';

/** Nature d'une valeur de détail : le serveur ne formate pas, le web affiche selon la nature. */
export type TimelineDetailKind = 'TEXTE' | 'KM' | 'MONTANT' | 'DATE' | 'DATE_HEURE';

export interface TimelineDetail {
  label: string;
  value: string;
  kind: TimelineDetailKind;
}

/** Événement de la chronologie (TimelineEventDto). */
export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  category: TimelineCategory;
  categoryLabel: string;
  /** Horodatage UTC. */
  occurredAt: string;
  title: string;
  companyId: string | null;
  companyCode: string | null;
  /** COMPLET : objet de vos sociétés ; TECHNIQUE : objet d'une autre société en vue technique (D-275). */
  access: 'COMPLET' | 'TECHNIQUE';
  actorName: string | null;
  objectType: string;
  objectId: string;
  /** Vrai si la fiche de l'objet source est consultable par le lecteur. */
  objectAccessible: boolean;
  details: TimelineDetail[];
}
