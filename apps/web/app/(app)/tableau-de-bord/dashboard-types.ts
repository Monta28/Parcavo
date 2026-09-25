// Types des réponses consommées par le tableau de bord. Source de vérité : DTO de l'API
// (apps/api/src/modules/dashboard/dto/dashboard.dto.ts pour GET /dashboard,
// apps/api/src/modules/alerts/dto/alerts.dto.ts pour GET /alerts,
// apps/api/src/modules/expenses/dto/expense-view.dto.ts pour GET /expenses/summary).

export type IndicatorKind = 'ETAT' | 'FLUX';
export type IndicatorGroup = 'parc' | 'entretiens' | 'documents' | 'kilometrage' | 'utilisations' | 'interventions' | 'couts' | 'alertes';

/** Période civile incluse (AAAA-MM-JJ), dans le fuseau de l'organisation. */
export interface IndicatorPeriod {
  from: string;
  to: string;
}

/** Chemin et paramètres d'une liste (route de l'API ou écran web). */
export interface IndicatorLink {
  path: string;
  query: Record<string, string>;
}

/**
 * Liste justificative : route de l'API interrogée avec les mêmes filtres que le calcul, champ de sa
 * réponse égal à la valeur, et écran web équivalent (null si l'écran ne propose pas ce filtre).
 */
export interface IndicatorJustification extends IndicatorLink {
  field: string;
  screen: IndicatorLink | null;
}

export interface IndicatorDenominator {
  key: string;
  label: string;
  value: number;
}

export interface DashboardIndicator {
  key: string;
  label: string;
  definition: string;
  group: IndicatorGroup;
  kind: IndicatorKind;
  /** Nombre entier, ou montant exact en chaîne décimale lorsque l'unité est une devise. */
  value: number | string;
  unit: string;
  denominator: IndicatorDenominator | null;
  /** Indicateur dont celui-ci est un sous-ensemble (« dont … »). */
  parentKey: string | null;
  /** Instant de l'état (UTC) pour un indicateur ETAT. */
  asOf: string | null;
  /** Période pour un indicateur FLUX. */
  period: IndicatorPeriod | null;
  justification: IndicatorJustification;
}

/** Indicateur non fourni (ex. coûts sans costs.read) : absent, jamais remplacé par 0. */
export interface OmittedIndicator {
  key: string;
  label: string;
  reason: string;
}

/** GET /dashboard (CDC 11.1, D-269). */
export interface DashboardView {
  asOf: string;
  timezone: string;
  today: string;
  period: IndicatorPeriod;
  periodIsDefault: boolean;
  companyId: string | null;
  /** Véhicule filtré (11.1), ou null pour tous les véhicules du périmètre. */
  vehicleId: string | null;
  indicators: DashboardIndicator[];
  omitted: OmittedIndicator[];
}

export type AlertSeverity = 'INFO' | 'ATTENTION' | 'URGENT' | 'CRITIQUE';

/** Élément de GET /alerts (AlertViewDto) : champs affichés par le tableau de bord. */
export interface AlertSummaryView {
  id: string;
  type: string;
  typeLabel: string;
  severity: AlertSeverity;
  severityLabel: string;
  status: string;
  companyId: string;
  companyName: string;
  vehicleId: string | null;
  vehicleCode: string | null;
  vehicleRegistration: string | null;
  title: string;
  message: string;
  /** Chemin de l'application vers l'action utile. */
  actionPath: string;
  responsibleName: string;
  triggeredAt: string;
  snoozedUntil: string | null;
}

/** Totaux d'un regroupement du registre des dépenses (montants exacts en chaînes décimales). */
export interface ExpenseBucketView {
  expenses: string;
  credits: string;
  net: string;
  count: number;
}

/** GET /expenses/summary (ExpenseSummaryDto) : liste justificative des coûts d'exploitation. */
export interface ExpenseSummaryView {
  currency: string;
  companyId: string | null;
  from: string | null;
  to: string | null;
  byCategory: Array<ExpenseBucketView & { category: string; label: string }>;
  operating: ExpenseBucketView & { label: string };
  unallocated: ExpenseBucketView & { label: string };
  excludedFromOperatingCost: ExpenseBucketView & { label: string };
}
