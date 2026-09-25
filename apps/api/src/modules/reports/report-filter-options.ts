import {
  ASSIGNMENT_STATUS_LABELS,
  DISTANCE_STATUS_LABELS,
  DOCUMENT_STATUS_LABELS,
  ENERGY_LABELS,
  EXPENSE_CATEGORY_LABELS,
  FRESHNESS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  PLAN_STATUS_LABELS,
  READING_SOURCE_LABELS,
  READING_STATUS_LABELS,
  USAGE_STATUS_LABELS,
  VEHICLE_LIFECYCLE_LABELS,
  VEHICLE_OPERATIONAL_STATUS_LABELS,
} from '@parc-auto/contracts';
import { EXPENSE_CATEGORIES } from '../../domain/expense-ledger.js';
import { FUEL_ENERGIES } from '../../domain/fuel-rules.js';
import { IMMOBILIZATION_STATUS_LABELS, OWNER_TYPE_LABELS } from './report-support.js';
import type { ReportFilterKey } from './report-types.js';

/**
 * Valeurs admises des filtres à choix fermé des rapports et leurs libellés : table unique servant à la
 * validation du DTO, au libellé des filtres appliqués (métadonnées, export) et au catalogue (GET /reports),
 * dont l'écran tire ses listes de choix. Carburants : ceux d'un plein (fuel-rules.ts) ; catégories de
 * dépense : celles du registre (expense-ledger.ts).
 */
export const REPORT_ENUM_FILTER_OPTIONS = {
  lifecycleStatus: VEHICLE_LIFECYCLE_LABELS,
  operationalStatus: VEHICLE_OPERATIONAL_STATUS_LABELS,
  distanceStatus: DISTANCE_STATUS_LABELS,
  source: READING_SOURCE_LABELS,
  freshness: FRESHNESS_LABELS,
  ownerType: OWNER_TYPE_LABELS,
  energy: Object.fromEntries(FUEL_ENERGIES.map((e) => [e, ENERGY_LABELS[e]])),
  category: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, EXPENSE_CATEGORY_LABELS[c]])),
  incidentType: INCIDENT_TYPE_LABELS,
  severity: INCIDENT_SEVERITY_LABELS,
} as const satisfies Partial<Record<ReportFilterKey, Readonly<Record<string, string>>>>;

export type ReportEnumFilterKey = keyof typeof REPORT_ENUM_FILTER_OPTIONS;

/** Filtres booléens (« true » seul restreint ; « false » équivaut à l'absence de filtre). */
export const REPORT_BOOLEAN_FILTER_LABELS: Readonly<Record<string, string>> = { true: 'Oui', false: 'Non' };

/** Valeurs admises d'un filtre à choix fermé (validation du DTO). */
export function enumFilterValues(key: ReportEnumFilterKey): string[] {
  return Object.keys(REPORT_ENUM_FILTER_OPTIONS[key]);
}

/**
 * Statuts filtrables de toutes les vues (validation du DTO) ; le service vérifie ensuite ceux de la vue
 * demandée (ReportViewDefinition.statuses).
 */
export const REPORT_STATUSES: readonly string[] = [
  ...new Set(
    [USAGE_STATUS_LABELS, ASSIGNMENT_STATUS_LABELS, READING_STATUS_LABELS, PLAN_STATUS_LABELS, DOCUMENT_STATUS_LABELS, INCIDENT_STATUS_LABELS, IMMOBILIZATION_STATUS_LABELS].flatMap((labels) => Object.keys(labels)),
  ),
];
