import { Decimal } from 'decimal.js';

/**
 * Protection des exports contre l'interprétation de cellules textuelles comme formules
 * (CDC 11.2, T34, D-270). Seules les valeurs TEXTE commençant par =, +, -, @, tabulation ou retour
 * chariot — y compris leurs variantes pleine chasse (＝ ＋ － ＠) que certains tableurs convertissent —
 * sont préfixées d'une apostrophe. Les nombres ne sont jamais préfixés : -5 reste un nombre.
 */
const DANGEROUS_PREFIX = /^[=+\-@\t\r＝＋－＠]/;

/** Vrai si un texte serait interprété comme une formule par un tableur. */
export function isSpreadsheetFormulaLike(value: string): boolean {
  return DANGEROUS_PREFIX.test(value);
}

/** Neutralise un texte (apostrophe en tête) s'il commence par un caractère de formule. */
export function neutralizeSpreadsheetText(text: string): string {
  return isSpreadsheetFormulaLike(text) ? `'${text}` : text;
}

/**
 * Représentation textuelle sûre d'une cellule : nombres (number, bigint, Decimal) inchangés, textes
 * neutralisés, dates en ISO 8601, valeurs absentes vides.
 */
export function neutralizeSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (value instanceof Decimal) return value.toString();
  return neutralizeSpreadsheetText(stringify(value));
}

function stringify(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value.toString();
    case 'object':
      return value instanceof Date ? value.toISOString() : JSON.stringify(value);
    default:
      return '';
  }
}
