// Types des réponses de l'API rapports (apps/api/src/modules/reports/dto/reports.dto.ts) utilisés par le web.
// Aucune règle de calcul ici : lignes, totaux, périodes par défaut et visibilité des coûts viennent de l'API.

/** Filtres acceptés par GET /reports/:code et /reports/:code/export (REPORT_FILTER_KEYS de l'API). */
export const REPORT_FILTER_KEYS = [
  'companyId',
  'siteId',
  'vehicleId',
  'driverId',
  'categoryId',
  'supplierId',
  'maintenanceTypeId',
  'documentTypeId',
  'from',
  'to',
  'q',
  'vue',
  'status',
  'lifecycleStatus',
  'operationalStatus',
  'distanceStatus',
  'lateOnly',
  'source',
  'freshness',
  'ownerType',
  'blocking',
  'energy',
  'category',
  'incidentType',
  'severity',
] as const;
export type ReportFilterKey = (typeof REPORT_FILTER_KEYS)[number];

export type ReportColumnKind = 'text' | 'enum' | 'integer' | 'decimal' | 'money' | 'date' | 'datetime' | 'boolean';

/** Colonne décrite par meta.columns : l'écran l'affiche telle quelle (libellé, unité, décimales, libellé N/D). */
export interface ReportColumn {
  key: string;
  label: string;
  unit: string | null;
  kind: ReportColumnKind;
  /** Colonne de coût : absente des lignes d'une société sans costs.read (D-266). */
  cost: boolean;
  decimals: number | null;
  /** Libellé d'une valeur absente (« N/D », « Inconnu »…) : jamais 0. */
  missing: string | null;
  labels: Record<string, string> | null;
  /** Valeurs d'énumération que l'API désigne comme des estimations (GPS, D-276) : signalées comme telles. */
  estimates: string[] | null;
}

export interface ReportFilterApplied {
  key: string;
  label: string;
  value: string;
  display: string;
}

export interface ReportCompany {
  id: string;
  code: string;
  legalName: string;
}

export interface ReportSummaryItem {
  label: string;
  value: string | null;
  unit: string | null;
  cost: boolean;
}

/** Visibilité des colonnes de coût calculée par l'API (D-266). */
export type CostColumnsVisibility = 'toutes' | 'partielles' | 'aucune' | 'sans_objet';

export interface ReportMeta {
  code: string;
  label: string;
  view: { code: string; label: string };
  /** Horodatage de génération (UTC). */
  generatedAt: string;
  timezone: string;
  currency: string;
  author: string;
  /** Sociétés couvertes, calculées côté serveur. */
  scope: ReportCompany[];
  filters: ReportFilterApplied[];
  /** Période résolue par l'API (dates civiles incluses) ; null pour une vue sans période. */
  period: { from: string; to: string } | null;
  columns: ReportColumn[];
  costColumns: CostColumnsVisibility;
  units: string[];
  notes: string[];
  summary: ReportSummaryItem[];
}

/** Ligne : une propriété par colonne (décimaux en chaînes déjà arrondies), plus id et companyId. */
export type ReportItem = Record<string, unknown> & { id: string; companyId: string | null };

/** GET /reports/:code. */
export interface ReportPage {
  items: ReportItem[];
  total: number;
  page: number;
  pageSize: number;
  meta: ReportMeta;
}

export interface ReportViewDefinition {
  code: string;
  label: string;
  /** Vue filtrée par période (du, au). */
  period: boolean;
  filters: ReportFilterKey[];
  /** Statuts filtrables et libellés. */
  statuses: Record<string, string>;
}

export interface ReportCatalogueItem {
  code: string;
  label: string;
  description: string;
  costsRequired: boolean;
  /** Consultable par l'utilisateur (costs.read détenu si requis). */
  available: boolean;
  views: ReportViewDefinition[];
}

/** GET /reports. */
export interface ReportCatalogue {
  reports: ReportCatalogueItem[];
  /** Valeurs admises et libellés des filtres à choix fermé, fournis par l'API (mêmes listes que sa validation). */
  filterOptions: Partial<Record<ReportFilterKey, Record<string, string>>>;
  /** reports.export détenu sur au moins une société. */
  canExport: boolean;
  canReadCosts: boolean;
  /** Au-delà, l'export est différé (202). */
  syncMaxRows: number;
  maxRows: number;
}

export type ExportFormat = 'csv' | 'xlsx';

/** Réponse 202 de GET /reports/:code/export. */
export interface ExportAccepted {
  jobId: string;
  rowCount: number;
  statusPath: string;
}

export type ExportJobStatus = 'EN_ATTENTE' | 'EN_COURS' | 'TERMINE' | 'ECHEC' | 'ABANDONNE';

/** GET /reports/exports/:jobId (demandeur uniquement). */
export interface ExportJobView {
  id: string;
  status: ExportJobStatus;
  progress: number;
  reportCode: string;
  format: string;
  rowCount: number | null;
  fileName: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  downloadPath: string | null;
}

export const EXPORT_JOB_STATUS_LABELS: Record<ExportJobStatus, string> = {
  EN_ATTENTE: 'En attente',
  EN_COURS: 'En cours de génération',
  TERMINE: 'Prêt',
  ECHEC: 'Échec',
  ABANDONNE: 'Abandonné',
};

/** Statuts terminaux : le suivi s'arrête. */
export const EXPORT_JOB_FINAL_STATUSES: readonly ExportJobStatus[] = ['TERMINE', 'ECHEC', 'ABANDONNE'];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { csv: 'CSV', xlsx: 'XLSX' };
