// Types des réponses de l'API documents (apps/api/src/modules/documents/dto/documents.dto.ts).
import type { DocumentStatus } from '@parc-auto/contracts';

export type DocumentOwnerType = 'VEHICULE' | 'CONDUCTEUR';
export type DocumentTypeStatus = 'ACTIF' | 'ARCHIVE';

/** Type de document paramétrable (GET /document-types). */
export interface DocumentTypeView {
  id: string;
  code: string;
  label: string;
  ownerType: DocumentOwnerType;
  hasExpiry: boolean;
  required: boolean;
  blocksCheckout: boolean;
  noticeDays: number[];
  visibleToDriver: boolean;
  vehicleCategoryIds: string[];
  companyIds: string[];
  status: DocumentTypeStatus;
  version: number;
}

/** Version d'un document (GET /documents, GET /documents/:id). */
export interface DocumentView {
  id: string;
  companyId: string;
  documentTypeId: string;
  documentTypeLabel: string;
  ownerType: DocumentOwnerType;
  vehicleId: string | null;
  driverId: string | null;
  ownerLabel: string;
  number: string | null;
  issuer: string | null;
  issuedOn: string | null;
  validFrom: string | null;
  validTo: string | null;
  attachmentId: string | null;
  /** Justificatif absent (version enregistrée sans fichier). */
  missingFile: boolean;
  notes: string | null;
  previousVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  version: number;
}

/** Ligne du tableau de conformité (GET /documents/compliance) : un objet × un type applicable. */
export interface ComplianceRow {
  ownerType: DocumentOwnerType;
  objectId: string;
  objectLabel: string;
  companyId: string;
  documentTypeId: string;
  documentTypeLabel: string;
  status: DocumentStatus;
  /** Détail rédigé par l'API, dates déjà au format JJ/MM/AAAA (ex. « Expiré depuis le 20/09/2026. ») : affiché tel quel. */
  detail: string;
  /** Début de validité de la version retenue (AAAA-MM-JJ). */
  validFrom: string | null;
  /** Fin de validité de la version retenue (AAAA-MM-JJ), valable jusqu'à la fin de ce jour. */
  validTo: string | null;
  /** Jours restants avant la fin de validité (négatif une fois la date dépassée), calculés par l'API. */
  daysRemaining: number | null;
  currentVersionId: string | null;
  upcomingVersionId: string | null;
  /** Début et fin de validité de la version future, pas encore en vigueur (AAAA-MM-JJ). */
  nextValidFrom: string | null;
  nextValidTo: string | null;
  renewed: boolean;
  /** Le document bloque un nouveau départ en l'état. */
  blocksCheckout: boolean;
}

export const DOCUMENT_OWNER_TYPE_LABELS: Record<DocumentOwnerType, string> = {
  VEHICULE: 'Véhicule',
  CONDUCTEUR: 'Conducteur',
};

export const DOCUMENT_TYPE_STATUS_LABELS: Record<DocumentTypeStatus, string> = {
  ACTIF: 'Actif',
  ARCHIVE: 'Archivé',
};
