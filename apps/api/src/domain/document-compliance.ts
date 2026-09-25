import type { CivilDate } from './civil-date.js';
import { isDocumentTypeApplicable, type DocumentOwnerFacts, type DocumentTypeScope } from './document-applicability.js';
import { computeDocumentStatus, type DocumentTypeRule, type DocumentVersionDates } from './document-status.js';

/**
 * Non-conformité documentaire bloquante d'un objet (CDC 3.2, 7.2, 11.1 ; D-210, D-269) : un type
 * applicable (document-applicability.ts) dont le statut au jour local (document-status.ts) est MANQUANT
 * ou EXPIRE et qui bloque un nouveau départ. Indicateur distinct du statut opérationnel : il ne change
 * pas la partition disponible / en utilisation / immobilisé.
 */
export interface ComplianceTypeRule extends DocumentTypeRule, DocumentTypeScope {
  id: string;
}

export interface OwnedVersionDates extends DocumentVersionDates {
  documentTypeId: string;
}

/** Types bloquants non conformes de l'objet (tableau vide : conforme). */
export function blockingNonCompliantTypeIds(types: readonly ComplianceTypeRule[], versions: readonly OwnedVersionDates[], owner: DocumentOwnerFacts, today: CivilDate): string[] {
  const blocking: string[] = [];
  for (const type of types) {
    if (!type.blocksCheckout || !isDocumentTypeApplicable(type, owner)) continue;
    const own = versions.filter((v) => v.documentTypeId === type.id);
    if (computeDocumentStatus(type, own, today).blocksCheckout) blocking.push(type.id);
  }
  return blocking;
}
