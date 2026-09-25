import { Decimal } from 'decimal.js';
import type { Prisma } from '@parc-auto/db';
import { toDbDate } from '../../domain/civil-date.js';
import { kmValue } from '../../domain/km-display.js';
import type { ReportColumn, ReportFilters, ReportPeriod } from './report-types.js';

/** Libellés propres aux rapports (énumérations sans libellé partagé dans les contrats). */
export const OWNER_TYPE_LABELS = { VEHICULE: 'Véhicule', CONDUCTEUR: 'Conducteur' } as const;
export const INTERVENTION_KIND_LABELS = { PREVENTIF: 'Préventif', CORRECTIF: 'Correctif' } as const;
export const COST_STATUS_LABELS = { A_SAISIR: 'Coût à saisir', SAISI: 'Coût saisi', SANS_COUT: 'Sans coût' } as const;
export const EXPENSE_KIND_LABELS = { DEPENSE: 'Dépense', AVOIR: 'Avoir' } as const;
export const EXPENSE_SOURCE_LABELS = { PLEIN: 'Plein', INTERVENTION: 'Intervention' } as const;
export const CAUSE_KIND_LABELS = { INCIDENT: 'Incident', INTERVENTION: 'Intervention', AUTRE: 'Autre' } as const;
export const IMMOBILIZATION_STATUS_LABELS = { ACTIVE: 'En cours', TERMINEE: 'Terminée' } as const;
export const MEASURE_NATURE_LABELS = { MESURE: 'Relevé compteur', ESTIMATION: 'Estimation GPS' } as const;
export const DISTANCE_NATURE_LABELS = { MESUREE: 'Mesurée', ESTIMEE: 'Estimée (borne GPS)' } as const;
export const COST_PER_KM_NATURE_LABELS = { CALCULE: 'Calculé', ESTIME: 'Estimé (distance GPS)' } as const;
export const CORRECTION_LABELS = { CORRIGE: 'Corrigé (remplacé)', CORRECTION: 'Correction d’un relevé' } as const;
export const KM_SOURCE_LABELS = { ESTIME_GPS: 'Estimation GPS', COMPTEUR_CAN: 'Compteur CAN', COMPTEUR_AFFICHE: 'Compteur affiché' } as const;
export const PLAN_WARNING_LABELS: Record<string, string> = {
  KILOMETRAGE_INCONNU: 'Kilométrage inconnu',
  KILOMETRAGE_ANCIEN: 'Kilométrage ancien',
  CUMUL_INCOMPLET: 'Cumul incomplet',
  BASE_KM_MANQUANTE: 'Base kilométrique manquante',
  BASE_DATE_MANQUANTE: 'Base de date manquante',
  AUCUNE_BASE: 'Aucune base',
};

/** Relevé estimé : distance GPS calibrée (odomètre virtuel, 5.6), jamais un relevé compteur (D-276). */
export function isEstimateReading(r: { isEstimate: boolean; measurementKind: string }): boolean {
  return r.isEstimate || r.measurementKind === 'DISTANCE_GPS';
}

/** Valeur N/D : une donnée absente n'est jamais présentée comme 0 (11.3). */
export const NOT_AVAILABLE = 'N/D';

export function dec(value: Prisma.Decimal | Decimal | string | number): Decimal {
  return new Decimal(value.toString());
}

/**
 * Texte décimal d'une cellule à `decimals` décimales (écran et export). Un kilométrage affiché au km entier
 * est TRONQUÉ, jamais arrondi (règle unique km-display.ts, D-201, D-202) ; les autres valeurs sont arrondies.
 */
export function columnDecimalText(col: Pick<ReportColumn, 'unit'>, value: Decimal, decimals: number): string {
  if (col.unit === 'km' && decimals === 0) return kmValue(value) as string;
  return value.toFixed(decimals);
}

export function decOrNull(value: Prisma.Decimal | Decimal | string | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value.toString());
}

export function personName(p: { firstName: string; lastName: string } | null | undefined): string | null {
  return p ? `${p.firstName} ${p.lastName}`.trim() : null;
}

/** Filtre de période sur un horodatage (bornes incluses). */
export function instantRange(period: ReportPeriod | null): { gte: Date; lte: Date } | undefined {
  return period ? { gte: period.start, lte: period.end } : undefined;
}

/** Filtre de période sur une date civile (colonne DATE, bornes incluses). */
export function civilRange(period: ReportPeriod | null): { gte: Date; lte: Date } | undefined {
  return period ? { gte: toDbDate(period.from) as Date, lte: toDbDate(period.to) as Date } : undefined;
}

/** Filtres portant sur le véhicule courant d'un objet (site, catégorie). */
export function vehicleRelation(filters: ReportFilters): { vehicle?: { siteId?: string; categoryId?: string } } {
  const vehicle: { siteId?: string; categoryId?: string } = {};
  if (filters.siteId) vehicle.siteId = filters.siteId;
  if (filters.categoryId) vehicle.categoryId = filters.categoryId;
  return Object.keys(vehicle).length > 0 ? { vehicle } : {};
}

export const vehicleSummarySelect = { code: true, registration: true } as const;
