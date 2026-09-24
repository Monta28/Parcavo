import { Decimal } from 'decimal.js';

/**
 * Kilomètres affichés (CDC 13.1, D-201, D-202) : le compteur s'affiche au kilomètre entier, TRONQUÉ et
 * jamais arrondi (90 000,9 km s'affiche 90 000 km, comme au tableau de bord). Règle unique côté
 * backend : toute valeur kilométrique exposée « à l'unité » par l'API et tout libellé « … km » passent
 * par ces fonctions ; `Decimal#toFixed(0)` (arrondi au plus proche) est proscrit pour les kilomètres.
 */

/** Toute valeur décimale exacte : chaîne, nombre, decimal.js ou Decimal Prisma (via toString). */
export type KmInput = Decimal | string | number | { toString(): string };

function toDecimal(value: KmInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(typeof value === 'number' ? value : value.toString());
}

/** Kilomètre entier affiché : partie entière (troncature vers zéro), sans arrondi. */
export function truncateKm(value: KmInput): Decimal {
  return toDecimal(value).toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/** Valeur exposée par l'API (chaîne décimale entière, ex. « 90300 ») ; null reste null. */
export function kmValue(value: KmInput | null | undefined): string | null {
  return value === null || value === undefined ? null : truncateKm(value).toFixed(0);
}

/** Libellé français (« 90 300 km ») pour les messages et motifs. */
export function kmLabel(value: KmInput): string {
  return `${truncateKm(value).toNumber().toLocaleString('fr-FR')} km`;
}
