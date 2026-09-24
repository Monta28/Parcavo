/**
 * Regroupe sous une même clé les erreurs d'un champ et de ses sous-chemins renvoyés par l'API
 * (ex. « requiredPermitCategories.0 » ou « memberships.1.role »), pour les afficher près du champ.
 */
export function collectErrors(errors: Record<string, string[]>, prefix: string): Record<string, string[]> {
  const messages = Object.entries(errors)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
    .flatMap(([, list]) => list);
  return messages.length > 0 ? { [prefix]: [...new Set(messages)] } : {};
}
