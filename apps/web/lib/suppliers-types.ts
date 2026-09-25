// Types des réponses de l'API fournisseurs (apps/api/src/modules/suppliers, SupplierViewDto).
import type { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';

export type SupplierCategory = keyof typeof SUPPLIER_CATEGORY_LABELS;
export type SupplierStatus = 'ACTIF' | 'ARCHIVE';

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  ACTIF: 'Actif',
  ARCHIVE: 'Archivé',
};

export interface SupplierView {
  id: string;
  companyId: string;
  name: string;
  category: SupplierCategory;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: SupplierStatus;
  archivedAt: string | null;
  version: number;
}

/**
 * Dépense validée du registre rattachée au fournisseur (GET /expenses?companyId=&supplierId=, permission
 * costs.read) : champs lus pour l'historique du fournisseur. Montants et libellés fournis par l'API.
 */
export interface SupplierExpenseRow {
  id: string;
  occurredOn: string;
  allocationLabel: string;
  categoryLabel: string;
  kind: 'DEPENSE' | 'AVOIR';
  reference: string | null;
  signedAmount: string;
  currency: string;
  sourceType: 'PLEIN' | 'INTERVENTION' | null;
  sourceId: string | null;
}
