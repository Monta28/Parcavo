import type { Decimal } from 'decimal.js';
import type { RequestContext } from '../../common/request-context.js';
import type { CivilDate } from '../../domain/civil-date.js';

/** Rapports V1 (CDC 11.2). */
export const REPORT_CODES = ['inventaire', 'utilisations', 'releves', 'entretiens', 'documents', 'carburant', 'depenses', 'incidents-immobilisations', 'couts-distances'] as const;
export type ReportCode = (typeof REPORT_CODES)[number];

/** Nature d'une colonne : pilote la sérialisation (JSON, CSV, XLSX). */
export type ColumnKind = 'text' | 'enum' | 'integer' | 'decimal' | 'money' | 'date' | 'datetime' | 'boolean';

export interface ReportColumn {
  key: string;
  label: string;
  /** Unité affichée dans l'en-tête (km, L, L/100 km, jours, minutes…) ; pour un montant, voir perUnit. */
  unit: string | null;
  /** Montant rapporté à une unité (« km » → devise/km, « L » → devise/L). */
  perUnit?: string;
  kind: ColumnKind;
  /** Colonne de coût : présente seulement avec costs.read sur la société de la ligne (D-266). */
  cost?: boolean;
  /** Décimales à l'écran (défaut 3 ; montants : décimales de la devise du groupe). */
  decimals?: number;
  /** Décimales à l'export (défaut : celles de l'écran). */
  exportDecimals?: number;
  /** Libellés des valeurs d'une énumération (exports). */
  labels?: Readonly<Record<string, string>>;
  /** Libellé d'une valeur absente à l'export (« N/D ») : une donnée manquante n'est jamais 0. */
  missing?: string;
  /** Valeurs d'énumération qui désignent une estimation (borne GPS, distance ou coût/km estimés — D-276). */
  estimates?: readonly string[];
}

/** Valeur brute d'une cellule : Date = horodatage UTC ; CivilDate (chaîne AAAA-MM-JJ) pour une date civile. */
export type RawValue = string | number | boolean | Date | Decimal | null;

export interface ReportRow {
  /** Identifiant stable de la ligne (objet source ou clé de regroupement). */
  id: string;
  /** Société de la ligne (portée des colonnes de coût) ; null pour une ligne de synthèse multi-sociétés. */
  companyId: string | null;
  values: Record<string, RawValue>;
}

export interface ReportWindow {
  skip: number;
  take: number;
}

export interface ReportSummaryItem {
  label: string;
  value: RawValue;
  kind: 'money' | 'decimal' | 'integer';
  unit: string | null;
  /** Valeur de coût : présente seulement avec costs.read sur tout le périmètre. */
  cost: boolean;
}

export interface ReportResult {
  rows: ReportRow[];
  total: number;
  /** Totaux de la sélection entière (indépendants de la pagination). */
  summary?: ReportSummaryItem[];
}

export interface ReportViewOption {
  code: string;
  label: string;
}

/** Filtres acceptés par les rapports (le DTO en porte le détail et la validation). */
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
export type ReportFilters = Partial<Record<ReportFilterKey, string>>;

/** Périmètre effectif d'une exécution, calculé côté serveur à partir des habilitations (2.3). */
export interface ReportScope {
  organizationId: string;
  /** Sociétés couvertes (filtre explicite recoupé, permission d'export le cas échéant). */
  companyIds: string[];
  /** Sociétés du périmètre sur lesquelles le demandeur détient costs.read. */
  costCompanyIds: ReadonlySet<string>;
  /** Sociétés lisibles par le demandeur (au-delà du périmètre d'export), pour les recoupements. */
  visibleCompanyIds: readonly string[];
}

export interface ReportPeriod {
  from: CivilDate;
  to: CivilDate;
  /** Début du premier jour local (instant). */
  start: Date;
  /** Fin du dernier jour local (instant). */
  end: Date;
}

/** Exécution d'un rapport : demandeur, périmètre, filtres normalisés et repères temporels. */
export interface ReportRun {
  ctx: RequestContext;
  scope: ReportScope;
  filters: ReportFilters;
  view: string;
  period: ReportPeriod | null;
  now: Date;
  timezone: string;
  currency: string;
  /** Écran ou export : seules les décimales d'affichage diffèrent. */
  purpose: 'ecran' | 'export';
}

/** Vue d'un rapport : filtres pris en charge, période, statuts filtrables. */
export interface ReportViewDefinition extends ReportViewOption {
  /** Filtres pris en charge (hors pagination, vue et format). */
  filters: readonly ReportFilterKey[];
  /** Vue filtrée par période (du, au en dates civiles incluses). */
  period: boolean;
  /** Valeurs admises pour le filtre « status » et leurs libellés. */
  statuses?: Readonly<Record<string, string>>;
}

/** Rapport V1 : définition (vues, filtres, colonnes) et lecture paginée sur le périmètre fourni. */
export interface ReportProvider {
  readonly code: ReportCode;
  readonly label: string;
  readonly description: string;
  /** Vues proposées ; la première est la vue par défaut. */
  readonly views: readonly ReportViewDefinition[];
  /** Rapport entièrement réservé à costs.read (403 sinon). */
  readonly costsRequired: boolean;
  columns(view: string): ReportColumn[];
  notes(view: string): string[];
  /**
   * Lignes de la fenêtre et total de la sélection : filtres, regroupements, tri et fenêtre sont calculés par
   * la base (CDC 17.2) ; seule la page est matérialisée (jamais l'historique complet puis un découpage).
   */
  fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult>;
}

/** Filtre Prisma de périmètre sur la société de l'objet (historique pour les événements, 13.1). */
export function scopeWhere(scope: ReportScope): { organizationId: string; companyId: { in: string[] } } {
  return { organizationId: scope.organizationId, companyId: { in: scope.companyIds } };
}
