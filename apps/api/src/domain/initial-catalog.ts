/**
 * Catalogue initial livré (CDC 6.1, 7.1) : opérations d'entretien et types de documents usuels, proposés
 * à l'installation par l'administrateur (jamais installés d'office). L'installation n'ajoute que les
 * éléments absents (même code ou même libellé déjà présents : ignorés) et ne modifie aucun élément
 * existant. Aucun intervalle, aucune exigence ni aucun blocage n'est imposé : les opérations n'ont pas
 * d'intervalle (6.1 : aucun intervalle universel) et les types de documents sont installés « facultatifs,
 * non bloquants » ; l'administrateur décide ensuite de ce qui est requis ou bloquant (7.1, 7.2).
 * Le permis de conduire n'est pas un type de document : il est suivi par la fiche permis du conducteur
 * (DriverPermit, D-133), seule source de vérité du contrôle au départ.
 */

export interface InitialMaintenanceType {
  code: string;
  label: string;
  description: string;
}

export interface InitialDocumentType {
  code: string;
  label: string;
  ownerType: 'VEHICULE' | 'CONDUCTEUR';
  hasExpiry: boolean;
}

/** Opérations citées par le CDC 6.1 : vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne, autres. */
export const INITIAL_MAINTENANCE_TYPES: readonly InitialMaintenanceType[] = [
  { code: 'VIDANGE_MOTEUR', label: 'Vidange moteur', description: 'Vidange de l’huile moteur.' },
  { code: 'FILTRES', label: 'Filtres', description: 'Remplacement des filtres (huile, air, carburant, habitacle).' },
  { code: 'FREINS', label: 'Freins', description: 'Contrôle et remplacement des plaquettes, disques et liquide de frein.' },
  { code: 'PNEUS', label: 'Pneus', description: 'Contrôle, permutation et remplacement des pneumatiques.' },
  { code: 'COURROIE', label: 'Courroie', description: 'Remplacement de la courroie de distribution ou d’accessoires.' },
  { code: 'BATTERIE', label: 'Batterie', description: 'Contrôle et remplacement de la batterie.' },
  { code: 'CONTROLE_TECHNIQUE_INTERNE', label: 'Contrôle technique interne', description: 'Contrôle périodique réalisé par l’atelier ou le garage du parc (distinct de la visite technique réglementaire).' },
  { code: 'AUTRE_OPERATION', label: 'Autre opération', description: 'Opération d’entretien non listée au catalogue.' },
];

/**
 * Types cités par le CDC 7.1 (assurance, visite technique, carte grise, vignette/taxe, licence, autorisation,
 * contrat de location, document libre), par objet propriétaire. L'expiration suit la nature du document ;
 * exigence et blocage restent à paramétrer par l'administrateur.
 */
export const INITIAL_DOCUMENT_TYPES: readonly InitialDocumentType[] = [
  { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'VISITE_TECHNIQUE', label: 'Visite technique', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'VIGNETTE_TAXE', label: 'Vignette / taxe de circulation', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'CARTE_GRISE', label: 'Carte grise', ownerType: 'VEHICULE', hasExpiry: false },
  { code: 'LICENCE_VEHICULE', label: 'Licence de transport', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'AUTORISATION_VEHICULE', label: 'Autorisation de circulation spécifique', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'CONTRAT_LOCATION', label: 'Contrat de location', ownerType: 'VEHICULE', hasExpiry: true },
  { code: 'DOCUMENT_LIBRE_VEHICULE', label: 'Document libre (véhicule)', ownerType: 'VEHICULE', hasExpiry: false },
  { code: 'LICENCE_CONDUCTEUR', label: 'Licence / carte professionnelle', ownerType: 'CONDUCTEUR', hasExpiry: true },
  { code: 'AUTORISATION_CONDUCTEUR', label: 'Autorisation de conduite', ownerType: 'CONDUCTEUR', hasExpiry: true },
  { code: 'DOCUMENT_LIBRE_CONDUCTEUR', label: 'Document libre (conducteur)', ownerType: 'CONDUCTEUR', hasExpiry: false },
];

/** Libellé comparable : sans accents, casse ni espaces superflus (« Vidange  moteur » = « vidange moteur »). */
export function comparableLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface CatalogCandidate {
  code: string;
  label: string;
  /** Portée de comparaison des libellés (ex. objet propriétaire d'un type de document). */
  scope?: string;
}

export type SkipReason = 'CODE_EXISTANT' | 'LIBELLE_EXISTANT';

/**
 * Partage le catalogue initial entre éléments à créer et éléments ignorés parce qu'un élément existant
 * (actif ou archivé) porte déjà le même code, ou le même libellé dans la même portée. Aucun élément
 * existant n'est jamais proposé à la modification.
 */
export function planCatalogInstall<T extends CatalogCandidate>(
  initial: readonly T[],
  existing: ReadonlyArray<CatalogCandidate>,
): { toCreate: T[]; skipped: Array<{ code: string; label: string; reason: SkipReason }> } {
  const codes = new Set(existing.map((e) => e.code));
  const labels = new Set(existing.map((e) => `${e.scope ?? ''}|${comparableLabel(e.label)}`));
  const toCreate: T[] = [];
  const skipped: Array<{ code: string; label: string; reason: SkipReason }> = [];
  for (const item of initial) {
    if (codes.has(item.code)) skipped.push({ code: item.code, label: item.label, reason: 'CODE_EXISTANT' });
    else if (labels.has(`${item.scope ?? ''}|${comparableLabel(item.label)}`)) skipped.push({ code: item.code, label: item.label, reason: 'LIBELLE_EXISTANT' });
    else toCreate.push(item);
  }
  return { toCreate, skipped };
}
