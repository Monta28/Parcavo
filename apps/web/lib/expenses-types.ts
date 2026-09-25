// Types des réponses de l'API dépenses (apps/api/src/modules/expenses, ExpenseViewDto, ExpenseSummaryDto).
// Les montants sont des chaînes décimales exactes calculées par l'API : le web les affiche sans les recalculer.
import type { EXPENSE_CATEGORY_LABELS } from '@parc-auto/contracts';

export type ExpenseCategory = keyof typeof EXPENSE_CATEGORY_LABELS;
export type ExpenseKind = 'DEPENSE' | 'AVOIR';
export type ExpenseStatus = 'VALIDEE' | 'ANNULEE' | 'REMPLACEE';
/** Filtre d'état de la liste (GET /expenses?status=) : TOUS inclut annulées et remplacées. */
export type ExpenseStatusFilter = ExpenseStatus | 'TOUS';
/** Filtre de source (GET /expenses?sourceType=) : MANUELLE = saisie directe dans le registre. */
export type ExpenseSourceFilter = 'PLEIN' | 'INTERVENTION' | 'MANUELLE';

export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  DEPENSE: 'Dépense',
  AVOIR: 'Avoir',
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  VALIDEE: 'Validée',
  ANNULEE: 'Annulée',
  REMPLACEE: 'Remplacée (corrigée)',
};

export const EXPENSE_STATUS_FILTER_LABELS: Record<ExpenseStatusFilter, string> = {
  VALIDEE: 'Validées (en vigueur)',
  ANNULEE: 'Annulées',
  REMPLACEE: 'Remplacées par une correction',
  TOUS: 'Tous les états',
};

export const EXPENSE_SOURCE_LABELS: Record<ExpenseSourceFilter, string> = {
  PLEIN: 'Plein de carburant',
  INTERVENTION: 'Intervention',
  MANUELLE: 'Saisie manuelle',
};

export interface ExpenseView {
  id: string;
  /** Société au fait générateur (jamais réimputée après un transfert). */
  companyId: string;
  vehicleId: string | null;
  vehicleCode: string | null;
  vehicleRegistration: string | null;
  /** Véhicule, ou « Dépense société non affectée ». */
  allocationLabel: string;
  unallocated: boolean;
  occurredOn: string;
  category: ExpenseCategory;
  categoryLabel: string;
  kind: ExpenseKind;
  supplierId: string | null;
  supplierName: string | null;
  reference: string | null;
  /** Montant TTC saisi (positif). */
  amount: string;
  /** Montant signé : négatif pour un avoir. */
  signedAmount: string;
  currency: string;
  attachmentId: string | null;
  relatedIncidentId: string | null;
  relatedIncidentReference: string | null;
  relatedExpenseId: string | null;
  sourceType: 'PLEIN' | 'INTERVENTION' | null;
  sourceId: string | null;
  status: ExpenseStatus;
  replacesExpenseId: string | null;
  replacedByExpenseId: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  excludedFromOperatingCost: boolean;
  notes: string | null;
  createdAt: string;
  createdById: string | null;
  version: number;
}

export interface ExpenseBucket {
  expenses: string;
  credits: string;
  net: string;
  count: number;
}

export interface ExpenseCategoryTotal extends ExpenseBucket {
  category: ExpenseCategory;
  label: string;
}

export interface ExpenseLabelledBucket extends ExpenseBucket {
  label: string;
}

export interface ExpenseSummary {
  currency: string;
  companyId: string | null;
  vehicleId: string | null;
  from: string | null;
  to: string | null;
  /** Coût d'exploitation par catégorie (dépenses validées uniquement). */
  byCategory: ExpenseCategoryTotal[];
  operating: ExpenseLabelledBucket;
  /** Ligne « Non ventilé » : dépenses sans véhicule, jamais réparties. */
  unallocated: ExpenseLabelledBucket;
  excludedFromOperatingCost: ExpenseLabelledBucket & { byCategory: ExpenseCategoryTotal[] };
}

/** Fournisseur proposé à la saisie (GET /suppliers?companyId=&status=ACTIF). */
export interface ExpenseSupplierOption {
  id: string;
  companyId: string;
  name: string;
  category: string;
}

/** Incident proposé au rattachement (GET /incidents?vehicleId=). */
export interface ExpenseIncidentOption {
  id: string;
  reference: string;
  status: string;
  occurredAt: string;
}
