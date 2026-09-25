// Liens internes fournis par l'API (lien d'action d'une alerte, écran de traitement d'un objet bloquant).
// Seuls les chemins relatifs vers une section qui existe dans apps/web/app/(app) sont rendus cliquables :
// un chemin inconnu est affiché sans lien plutôt qu'un lien vers une page absente. La page ouverte
// revérifie les droits côté serveur : le lien n'ouvre aucun accès.

const EXISTING_SECTIONS = new Set([
  'tableau-de-bord',
  'vehicules',
  'conducteurs',
  'planning',
  'utilisations',
  'kilometrage',
  'entretiens',
  'interventions',
  'documents',
  'incidents',
  'immobilisations',
  'fournisseurs',
  'carburant',
  'depenses',
  'alertes',
  'rapports',
  'imports',
  'telematique',
  'administration',
]);

/** Chemin interne de l'application (jamais d'URL externe ou protocolaire) vers une section existante, sinon null. */
export function appPathOrNull(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  const section = path.slice(1).split(/[/?#]/, 1)[0] ?? '';
  return EXISTING_SECTIONS.has(section) ? path : null;
}
