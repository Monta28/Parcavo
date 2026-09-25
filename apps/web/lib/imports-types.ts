// Types des réponses de l'API imports (apps/api/src/modules/imports/dto/imports.dto.ts). Aucune règle
// ici : association proposée, contrôle ligne par ligne, décomptes et statuts sont fournis par l'API.

export type ImportKind = 'VEHICULES' | 'CONDUCTEURS' | 'RELEVES' | 'BASES_ENTRETIEN';
export type ImportBatchStatus = 'TELEVERSE' | 'CONTROLE' | 'CONFIRME' | 'ABANDONNE';
export type ImportRowStatus = 'VALIDE' | 'ERREUR' | 'IMPORTEE' | 'IGNOREE';

/** Libellés absents de @parc-auto/contracts (toujours affichés en texte, CDC 10.1). */
export const IMPORT_BATCH_STATUS_LABELS: Record<ImportBatchStatus, string> = {
  TELEVERSE: 'Téléversé',
  CONTROLE: 'Contrôlé',
  CONFIRME: 'Confirmé',
  ABANDONNE: 'Abandonné',
};

export const IMPORT_ROW_STATUS_LABELS: Record<ImportRowStatus, string> = {
  VALIDE: 'Valide',
  ERREUR: 'En erreur',
  IMPORTEE: 'Importée',
  IGNOREE: 'Ignorée (déjà présente)',
};

export const IMPORT_BATCH_STATUSES = Object.keys(IMPORT_BATCH_STATUS_LABELS) as ImportBatchStatus[];
export const IMPORT_ROW_STATUSES = Object.keys(IMPORT_ROW_STATUS_LABELS) as ImportRowStatus[];

/** Colonne d'un modèle (ImportColumnDto). */
export interface ImportColumn {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

/** Modèle d'import (ImportModelDto, GET /imports/models). */
export interface ImportModel {
  kind: ImportKind;
  label: string;
  columns: ImportColumn[];
}

/** Décomptes du contrôle ou de la confirmation (ImportCountsDto). */
export interface ImportCounts {
  total: number;
  /** Lignes valides (contrôle) ou importées (après confirmation). */
  valid: number;
  errors: number;
  ignored: number;
  withNotes: number;
}

/** Lot d'import (ImportBatchViewDto). */
export interface ImportBatchView {
  id: string;
  kind: ImportKind;
  status: ImportBatchStatus;
  fileName: string;
  rowCount: number;
  errorCount: number;
  headers: string[];
  /** Association retenue au contrôle, ou proposée au téléversement. */
  columnMapping: Record<string, string> | null;
  warnings: string[];
  counts: ImportCounts | null;
  createdByName: string | null;
  createdAt: string;
  validatedAt: string | null;
  committedAt: string | null;
  version: number;
}

/** Ligne du fichier et son résultat (ImportRowViewDto). */
export interface ImportRowView {
  /** Numéro de ligne dans le fichier (en-tête = 1). */
  rowNumber: number;
  status: ImportRowStatus;
  values: Record<string, string>;
  errors: Array<{ column: string | null; message: string }>;
  notes: string[];
  createdObjectId: string | null;
}

/**
 * Type de l'objet créé par une ligne importée, pour ouvrir sa page via lib/object-links (objectHref).
 * Les relevés n'ont pas de page propre (l'identifiant créé est un relevé ou un compteur) : pas de lien.
 */
export const IMPORT_CREATED_OBJECT_TYPES: Partial<Record<ImportKind, string>> = {
  VEHICULES: 'Vehicle',
  CONDUCTEURS: 'Driver',
  BASES_ENTRETIEN: 'VehicleMaintenancePlan',
};
