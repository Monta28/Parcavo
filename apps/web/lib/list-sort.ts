/**
 * Tri au choix de l'utilisateur (CDC 10.1, 15.1) : clé et sens lus dans l'URL (« tri », « sens »), bornés
 * à la liste des tris autorisés par l'API de la ressource ; une valeur inconnue revient au tri par défaut.
 */
export type SortOrder = 'asc' | 'desc';

export function parseListSort<K extends string>(rawSort: string, rawOrder: string, allowed: readonly K[], fallback: K): { sort: K; order: SortOrder } {
  const sort = (allowed as readonly string[]).includes(rawSort) ? (rawSort as K) : fallback;
  return { sort, order: rawOrder === 'desc' ? 'desc' : 'asc' };
}
