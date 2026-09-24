// Types des réponses de l'API interventions (apps/api/src/modules/interventions/dto/interventions.dto.ts)
// et des référentiels lus par les écrans d'intervention. Aucune règle de calcul ici : statuts, totaux,
// montants de lignes, état du coût et échéances sont toujours fournis par l'API.

import type { ReadingSource, ReadingStatus, ReadingView } from './odometer-types';

export type InterventionKind = 'PREVENTIF' | 'CORRECTIF';
export type InterventionStatus = 'BROUILLON' | 'PLANIFIEE' | 'EN_COURS' | 'TERMINEE' | 'ANNULEE';
export type InterventionCostStatus = 'A_SAISIR' | 'SAISI' | 'SANS_COUT';
export type CostLineKind = 'PIECE' | 'MAIN_OEUVRE' | 'AUTRE';

/** Libellés absents de @parc-auto/contracts (toujours affichés en texte, CDC 10.1). */
export const INTERVENTION_KIND_LABELS: Record<InterventionKind, string> = {
  PREVENTIF: 'Préventif',
  CORRECTIF: 'Correctif',
};

export const INTERVENTION_COST_STATUS_LABELS: Record<InterventionCostStatus, string> = {
  A_SAISIR: 'Coût à saisir',
  SAISI: 'Coût saisi',
  SANS_COUT: 'Sans coût',
};

export const COST_LINE_KIND_LABELS: Record<CostLineKind, string> = {
  PIECE: 'Pièce',
  MAIN_OEUVRE: 'Main-d’œuvre',
  AUTRE: 'Autre',
};

/** Ligne de travail (TaskViewDto). */
export interface InterventionTaskView {
  id: string;
  label: string;
  planId: string | null;
  maintenanceTypeId: string | null;
  maintenanceTypeLabel: string | null;
  completed: boolean;
  notes: string | null;
}

/** Ligne de coût (LineViewDto) : visible uniquement avec costs.read. */
export interface InterventionLineView {
  id: string;
  taskId: string | null;
  kind: CostLineKind;
  label: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

/** Relevé d'exécution (ExecutionReadingViewDto) : kilomètres déjà tronqués au km entier par l'API (13.1). */
export interface ExecutionReadingView {
  id: string;
  physicalKm: string | null;
  cumulativeKm: string | null;
  observedAt: string;
  source: ReadingSource;
  measurementKind: ReadingView['measurementKind'];
  context: string;
  /** Statut courant du relevé (REMPLACE s'il a été corrigé depuis la clôture). */
  status: ReadingStatus;
  isEstimate: boolean;
}

/** INTERVENTION : fichier de clôture ; FACTURE : facture de la dépense liée ; RELEVE : photo du relevé d'exécution. */
export type InterventionAttachmentKind = 'INTERVENTION' | 'FACTURE' | 'RELEVE';

export const INTERVENTION_ATTACHMENT_KIND_LABELS: Record<InterventionAttachmentKind, string> = {
  INTERVENTION: 'Document de l’intervention',
  FACTURE: 'Facture de la dépense liée',
  RELEVE: 'Photo du relevé d’exécution',
};

/** Pièce jointe de la fiche (InterventionAttachmentViewDto), métadonnées fournies par l'API. */
export interface InterventionAttachmentView {
  id: string;
  kind: InterventionAttachmentKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  downloadPath: string;
}

/** Tris acceptés par GET /interventions (INTERVENTION_SORTS côté API). */
export type InterventionSort = 'reference' | 'vehicleCode' | 'status' | 'plannedStartAt' | 'startedAt' | 'performedOn' | 'completedAt' | 'createdAt';

/** Intervention (InterventionViewDto) : GET /interventions, GET /interventions/:id et réponses des actions. */
export interface InterventionView {
  id: string;
  reference: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  kind: InterventionKind;
  status: InterventionStatus;
  supplierId: string | null;
  supplierName: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  performedOn: string | null;
  performedReadingId: string | null;
  /** Kilométrage cumulé retenu à la clôture, tronqué au km entier par l'API. */
  performedKm: string | null;
  executionReading: ExecutionReadingView | null;
  diagnosis: string | null;
  workDescription: string | null;
  /** null sans la permission costs.read. */
  totalAmount: string | null;
  costStatus: InterventionCostStatus;
  expenseId: string | null;
  incidentId: string | null;
  isHistorical: boolean;
  cancelReason: string | null;
  reopenReason: string | null;
  tasks: InterventionTaskView[];
  /** [] sans la permission costs.read. */
  lines: InterventionLineView[];
  attachments: InterventionAttachmentView[];
  openImmobilizationCauseId: string | null;
  version: number;
}

/** Ligne de travail envoyée à l'API (TaskInputDto) : plan du véhicule, opération du catalogue ou libellé libre. */
export interface TaskInput {
  planId?: string;
  maintenanceTypeId?: string;
  label?: string;
  notes?: string;
}

/** Ligne de coût envoyée à l'API (CostLineDto) : le montant et le total sont calculés par le serveur. */
export interface CostLineInput {
  taskId?: string;
  kind: CostLineKind;
  label: string;
  quantity: string;
  unitPrice: string;
}

/** Fournisseur proposé comme garage (SupplierViewDto, sous-ensemble lu) : GET /suppliers. */
export interface GarageOption {
  id: string;
  companyId: string;
  name: string;
  category: string;
  phone: string | null;
  status: string;
}

/** Plan véhicule/opération (PlanViewDto, sous-ensemble lu) : GET /maintenance-plans?vehicleId=. */
export interface VehiclePlanOption {
  id: string;
  vehicleId: string;
  maintenanceTypeId: string;
  maintenanceTypeLabel: string;
  intervalKm: string | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  nextDueKm: string | null;
  nextDueDate: string | null;
  status: string;
  active: boolean;
}

/** Opération du catalogue (MaintenanceTypeViewDto) : GET /maintenance-types. */
export interface MaintenanceTypeOption {
  id: string;
  code: string;
  label: string;
  description: string | null;
  status: string;
}

/** Incident (IncidentViewDto, sous-ensemble lu) : GET /incidents et GET /incidents/:id. */
export interface IncidentSummary {
  id: string;
  reference: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  type: string;
  severity: string;
  status: string;
  occurredAt: string;
  description: string;
}

/** Cause d'immobilisation (ImmobilizationCauseViewDto). */
export interface ImmobilizationCauseSummary {
  id: string;
  kind: string;
  reason: string;
  incidentId: string | null;
  incidentReference: string | null;
  interventionId: string | null;
  interventionReference: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

/** Immobilisation (ImmobilizationViewDto, sous-ensemble lu) : GET /immobilizations?vehicleId=. */
export interface ImmobilizationSummary {
  id: string;
  vehicleId: string;
  status: 'ACTIVE' | 'TERMINEE';
  startedAt: string;
  expectedEndAt: string | null;
  endedAt: string | null;
  garageName: string | null;
  siteName: string | null;
  locationLabel: string | null;
  durationHours: number;
  causes: ImmobilizationCauseSummary[];
  version: number;
}

export const IMMOBILIZATION_STATUS_LABELS: Record<ImmobilizationSummary['status'], string> = {
  ACTIVE: 'Active',
  TERMINEE: 'Terminée',
};
