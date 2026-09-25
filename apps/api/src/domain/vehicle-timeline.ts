/**
 * Chronologie métier du dossier véhicule (onglet Historique, CDC 3.1 ; D-109, D-275) : règles pures de
 * visibilité des objets historiques après transfert, ordre et pagination d'une chronologie fusionnée à
 * partir de plusieurs sources triées.
 */

/** Familles d'objets qui alimentent la chronologie. */
export const TIMELINE_OBJECT_KINDS = [
  'DOSSIER',
  'SOCIETE',
  'UTILISATION',
  'RELEVE',
  'COMPTEUR',
  'INTERVENTION',
  'PLAN',
  'DOCUMENT',
  'INCIDENT',
  'IMMOBILISATION',
  'RESERVATION',
  'AFFECTATION',
] as const;
export type TimelineObjectKind = (typeof TIMELINE_OBJECT_KINDS)[number];

/**
 * Ce que voit un lecteur d'un objet dont la société historique n'est pas dans ses habilitations (D-275) :
 * - TECHNIQUE : visible en vue technique (auteur « Utilisateur d’une autre société », sans texte libre) ;
 * - SI_TERMINEE : visible en vue technique seulement si l'intervention est TERMINEE (sans montant,
 *   lignes, fournisseur ni pièces jointes) ;
 * - SI_PARTAGE : visible seulement si la version de document a été partagée avec l'une de ses sociétés ;
 * - MASQUE : jamais visible (utilisations, réservations, incidents, immobilisations, affectations).
 */
export type ForeignCompanyPolicy = 'TECHNIQUE' | 'SI_TERMINEE' | 'SI_PARTAGE' | 'MASQUE';

export const FOREIGN_COMPANY_POLICY: Readonly<Record<TimelineObjectKind, ForeignCompanyPolicy>> = {
  DOSSIER: 'TECHNIQUE',
  SOCIETE: 'TECHNIQUE',
  RELEVE: 'TECHNIQUE',
  COMPTEUR: 'TECHNIQUE',
  PLAN: 'TECHNIQUE',
  INTERVENTION: 'SI_TERMINEE',
  DOCUMENT: 'SI_PARTAGE',
  UTILISATION: 'MASQUE',
  INCIDENT: 'MASQUE',
  IMMOBILISATION: 'MASQUE',
  RESERVATION: 'MASQUE',
  AFFECTATION: 'MASQUE',
};

/** Niveau d'accès à un objet historique : complet, vue technique réduite, ou invisible. */
export type TimelineAccess = 'COMPLET' | 'TECHNIQUE' | 'MASQUE';

/** Auteur affiché à la place d'un utilisateur d'une société hors habilitations (D-275). */
export const OTHER_COMPANY_AUTHOR = 'Utilisateur d’une autre société';

/**
 * Accès d'un lecteur du dossier courant à un objet historique (D-275). La règle suppose que le lecteur
 * voit le dossier courant du véhicule (sinon 404 en amont) : un objet de sa propre société historique
 * est complet ; un objet d'une autre société suit la politique de sa famille.
 */
export function timelineAccess(
  kind: TimelineObjectKind,
  facts: { companyReadable: boolean; interventionCompleted?: boolean; sharedWithReader?: boolean },
): TimelineAccess {
  if (facts.companyReadable) return 'COMPLET';
  switch (FOREIGN_COMPANY_POLICY[kind]) {
    case 'TECHNIQUE':
      return 'TECHNIQUE';
    case 'SI_TERMINEE':
      return facts.interventionCompleted === true ? 'TECHNIQUE' : 'MASQUE';
    case 'SI_PARTAGE':
      return facts.sharedWithReader === true ? 'TECHNIQUE' : 'MASQUE';
    default:
      return 'MASQUE';
  }
}

/** Élément ordonnable de la chronologie : date, rang du type d'événement, identifiant d'objet. */
export interface TimelineSortKey {
  occurredAt: Date;
  rank: number;
  objectId: string;
}

export type TimelineOrder = 'asc' | 'desc';

/**
 * Ordre total de la chronologie : date, puis rang du type (création avant transfert, relevé avant remise…),
 * puis identifiant ; « desc » est l'inverse exact de « asc ». Chaque source doit être triée par
 * (date, identifiant) dans le même sens pour que la fusion soit exacte.
 */
export function compareTimeline(
  order: TimelineOrder,
): (a: TimelineSortKey, b: TimelineSortKey) => number {
  const sign = order === 'asc' ? 1 : -1;
  return (a, b) => {
    const byDate = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (byDate !== 0) return sign * byDate;
    if (a.rank !== b.rank) return sign * (a.rank - b.rank);
    return sign * (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);
  };
}

/**
 * Page d'une chronologie fusionnée : chaque source fournit ses page × pageSize premiers éléments dans
 * l'ordre demandé ; les éléments de la page globale figurent nécessairement parmi eux.
 */
export function mergeTimelinePage<T extends TimelineSortKey>(
  sources: ReadonlyArray<readonly T[]>,
  order: TimelineOrder,
  page: { page: number; pageSize: number },
): T[] {
  const skip = (page.page - 1) * page.pageSize;
  return sources
    .flat()
    .sort(compareTimeline(order))
    .slice(skip, skip + page.pageSize);
}

/** Nombre d'éléments à lire dans chaque source pour servir une page. */
export function sourceWindow(page: { page: number; pageSize: number }): number {
  return page.page * page.pageSize;
}
