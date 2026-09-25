// Types de l'assistant de transfert (apps/api/src/modules/vehicles/dto/transfer-vehicle.dto.ts :
// TransferPreviewDto, TransferResultDto) et lecture des refus de l'API.
import { FUEL_ENTRY_STATUS_LABELS, INCIDENT_STATUS_LABELS, INTERVENTION_STATUS_LABELS, READING_STATUS_LABELS, RESERVATION_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { isApiError } from './api-error';
import { IMMOBILIZATION_STATUS_LABELS } from './immobilizations-types';
import type { VehicleView } from './vehicles-types';

export type TransferBlockerType = 'UTILISATION_EN_COURS' | 'IMMOBILISATION_ACTIVE' | 'INTERVENTION_OUVERTE' | 'RESERVATION_A_TRAITER';
export type TransferWarningType = 'RELEVE_EN_ATTENTE' | 'PLEIN_SOUMIS' | 'INCIDENT_OUVERT';
export type TransferPlanDecision = 'KEEP' | 'DEACTIVATE';

/** Objet bloquant ou avertissement : libellé et action attendue rédigés par l'API, lien vers l'écran de traitement. */
export interface TransferIssue {
  type: string;
  id: string;
  label: string;
  action: string;
  status: string;
  link: string;
}

/** GET /vehicles/:id/transfer-responsibles (TransferResponsiblesDto) : responsables de plan éligibles dans la société cible. */
export interface TransferResponsible {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Rôles qui rendent le compte éligible : ADMIN (administrateur groupe), CHEF_PARC ou OPERATEUR de la société cible. */
  roles: string[];
}

export interface TransferResponsibles {
  companyId: string;
  items: TransferResponsible[];
}

export interface TransferAssignmentPreview {
  id: string;
  driverId: string;
  driverName: string;
  startsAt: string;
  endsAt: string | null;
  /** Vrai : en cours (clôturée au transfert) ; faux : prévue (retirée). */
  isCurrent: boolean;
}

export interface TransferPlanPreview {
  id: string;
  maintenanceTypeLabel: string;
  status: string;
  baseKm: string | null;
  baseDate: string | null;
  nextDueKm: string | null;
  nextDueDate: string | null;
  responsibleUserId: string | null;
  version: number;
}

export interface TransferDocumentPreview {
  id: string;
  documentTypeLabel: string;
  number: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Présélection proposée par l'API (version valable ou future au jour du transfert). */
  suggested: boolean;
  sharedWithCompanyIds: string[];
}

export interface TransferMappingPreview {
  id: string;
  providerId: string;
  providerName: string;
  unitLabel: string;
  status: string;
  /** Effet du transfert sur ce mapping, rédigé par l'API. */
  outcome: string;
}

export interface TransferCompanyOption {
  id: string;
  code: string;
  legalName: string;
}

export interface TransferPreview {
  vehicleId: string;
  vehicleCode: string;
  registration: string;
  companyId: string;
  companyCode: string;
  /** Version à renvoyer dans expectedVersion. */
  version: number;
  evaluatedAt: string;
  canTransfer: boolean;
  blockers: TransferIssue[];
  warnings: TransferIssue[];
  assignments: TransferAssignmentPreview[];
  plans: TransferPlanPreview[];
  documents: TransferDocumentPreview[];
  telemetryMappings: TransferMappingPreview[];
  targetCompanies: TransferCompanyOption[];
  lastReading: { readingId: string; physicalKm: string | null; cumulativeKm: string | null; observedAt: string } | null;
}

export interface TransferResult {
  vehicle: VehicleView;
  historyId: string;
  fromCompanyId: string;
  toCompanyId: string;
  effectiveAt: string;
  transferReadingId: string | null;
  closedAssignmentIds: string[];
  withdrawnAssignmentIds: string[];
  newAssignmentId: string | null;
  keptPlanIds: string[];
  deactivatedPlanIds: string[];
  sharedDocumentVersionIds: string[];
  closedTelemetryMappingIds: string[];
  proposedTelemetryMappingIds: string[];
  clearedContractSupplierId: string | null;
  resolvedAlerts: number;
}

/** Libellés des statuts de l'objet concerné, selon le type d'objet bloquant ou d'avertissement. */
const ISSUE_STATUS_LABELS: Record<TransferBlockerType | TransferWarningType, Readonly<Record<string, string>>> = {
  UTILISATION_EN_COURS: USAGE_STATUS_LABELS,
  IMMOBILISATION_ACTIVE: IMMOBILIZATION_STATUS_LABELS,
  INTERVENTION_OUVERTE: INTERVENTION_STATUS_LABELS,
  RESERVATION_A_TRAITER: RESERVATION_STATUS_LABELS,
  RELEVE_EN_ATTENTE: READING_STATUS_LABELS,
  PLEIN_SOUMIS: FUEL_ENTRY_STATUS_LABELS,
  INCIDENT_OUVERT: INCIDENT_STATUS_LABELS,
};

/** Statut de l'objet en français (« Confirmée », « En cours »…) ; un statut inconnu reste affiché tel que l'API le renvoie. */
export function transferIssueStatusLabel(issue: Pick<TransferIssue, 'type' | 'status'>): string {
  const labels = (ISSUE_STATUS_LABELS as Record<string, Readonly<Record<string, string>> | undefined>)[issue.type];
  return labels?.[issue.status] ?? issue.status;
}

function isIssue(value: unknown): value is TransferIssue {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['type', 'id', 'label', 'action', 'status', 'link'].every((k) => typeof v[k] === 'string');
}

/**
 * Objets bloquants d'un refus 409 TRANSFERT_BLOQUE (details.blockers) : liste typée renvoyée par l'API,
 * affichée telle quelle. Toute autre erreur (ou un détail mal formé) donne une liste vide.
 */
export function transferBlockersOf(error: unknown): TransferIssue[] {
  if (!isApiError(error) || error.status !== 409 || error.code !== 'TRANSFERT_BLOQUE') return [];
  const blockers = error.details?.['blockers'];
  return Array.isArray(blockers) ? blockers.filter(isIssue) : [];
}

/**
 * Erreurs par champ d'un refus de l'API, avec leur chemin complet (« plans.0.responsibleUserId »,
 * « transferReading.physicalKm ») : chaque décision de l'assistant affiche son propre message.
 */
export function transferFieldErrors(error: unknown): Record<string, string[]> {
  return isApiError(error) ? error.fieldErrors : {};
}
