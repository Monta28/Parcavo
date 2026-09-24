/**
 * Portée d'un type de document (D-210) : un type s'applique aux objets de son propriétaire
 * (véhicule ou conducteur), restreint le cas échéant à des catégories de véhicule et à des sociétés.
 * Listes vides = aucune restriction. Implémentation unique, utilisée par la conformité, les alertes
 * et le contrôle de départ.
 */
export interface DocumentTypeScope {
  ownerType: 'VEHICULE' | 'CONDUCTEUR';
  vehicleCategoryIds: readonly string[];
  companyIds: readonly string[];
}

export interface DocumentOwnerFacts {
  ownerType: 'VEHICULE' | 'CONDUCTEUR';
  companyId: string;
  /** Catégorie du véhicule (sans objet pour un conducteur). */
  categoryId?: string | null;
}

export function isDocumentTypeApplicable(type: DocumentTypeScope, owner: DocumentOwnerFacts): boolean {
  if (type.ownerType !== owner.ownerType) return false;
  if (type.companyIds.length > 0 && !type.companyIds.includes(owner.companyId)) return false;
  if (owner.ownerType === 'VEHICULE' && type.vehicleCategoryIds.length > 0) {
    if (!owner.categoryId || !type.vehicleCategoryIds.includes(owner.categoryId)) return false;
  }
  return true;
}

/**
 * Gravité d'une alerte d'échéance documentaire (D-212) : paliers de préavis du plus large au plus
 * court → INFO, ATTENTION, URGENT ; expiré → CRITIQUE si bloquant, URGENT sinon.
 */
export function documentAlertSeverity(noticeDays: readonly number[], noticeThreshold: number | null, expired: boolean, blocking: boolean): 'INFO' | 'ATTENTION' | 'URGENT' | 'CRITIQUE' {
  if (expired) return blocking ? 'CRITIQUE' : 'URGENT';
  const sorted = [...new Set(noticeDays)].filter((n) => n >= 0).sort((a, b) => b - a);
  if (noticeThreshold === null || sorted.length === 0) return 'INFO';
  const rank = sorted.indexOf(noticeThreshold);
  if (rank <= 0) return sorted.length === 1 ? 'URGENT' : 'INFO';
  if (rank === sorted.length - 1) return 'URGENT';
  return 'ATTENTION';
}
