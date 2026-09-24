/**
 * Protection des exports contre l'interprétation de cellules textuelles comme formules
 * (CDC 11.2, T34). Une valeur commençant par =, +, -, @, tabulation ou retour chariot est
 * préfixée d'une apostrophe, ce que les tableurs affichent comme texte.
 */
const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function neutralizeSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = stringify(value);
  return DANGEROUS_PREFIX.test(text) ? `'${text}` : text;
}

function stringify(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return value.toString();
    case 'object':
      return value instanceof Date ? value.toISOString() : JSON.stringify(value);
    default:
      return '';
  }
}

export function isSpreadsheetFormulaLike(value: string): boolean {
  return DANGEROUS_PREFIX.test(value);
}
