/**
 * Normalisation des immatriculations (CDC 3.1) : espaces, casse et séparateurs neutralisés pour
 * contrôler les doublons, sans détruire la valeur d'affichage. Compatible avec les formats
 * non tunisiens et provisoires (lettres de tout alphabet et chiffres conservés).
 */
/**
 * Équivalences appliquées avant comparaison : la mention « تونس » (Tunisie) des plaques tunisiennes
 * est équivalente à « TU » (translittération usuelle) ; « ن ت » (نقل تونس, transport) à « NT » ;
 * « ر س » (رابطة سيارات, série spéciale) à « RS ». Une même plaque saisie en arabe ou en latin
 * est donc détectée comme doublon. La valeur affichée n'est jamais modifiée.
 */
export const REGISTRATION_EQUIVALENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/تونس/gu, 'TU'],
  [/ن\s*ت/gu, 'NT'],
  [/ر\s*س/gu, 'RS'],
];

export function normalizeRegistration(value: string): string {
  let text = value.normalize('NFKC');
  for (const [pattern, replacement] of REGISTRATION_EQUIVALENCES) text = text.replace(pattern, replacement);
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();
}

export function normalizeVin(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toUpperCase().replace(/\s+/g, '');
  return v.length > 0 ? v : null;
}
