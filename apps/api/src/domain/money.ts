import { Decimal } from 'decimal.js';
import { roundMoney } from '../common/decimal.js';

/**
 * Montants (TND) et quantités (litres) d'un plein (CDC 8.2, 13.1, D-224) : décimaux exacts, jamais de
 * flottant binaire. Le contrôle litres × prix unitaire / total signale un écart, il ne corrige jamais
 * le total saisi.
 */

/** Décimales maximales des montants et des quantités : DECIMAL(18,3). */
export const AMOUNT_DECIMALS = 3;
/** Chiffres maximum de la partie entière d'un DECIMAL(18,3). */
const INTEGER_DIGITS = 15;

/** Vrai si la valeur est une chaîne décimale exacte, strictement positive, d'au plus `maxDecimals` décimales. */
export function isPositiveDecimalString(value: unknown, maxDecimals = AMOUNT_DECIMALS, maxIntegerDigits = INTEGER_DIGITS): boolean {
  if (typeof value !== 'string') return false;
  const fraction = maxDecimals > 0 ? `(\\.\\d{1,${maxDecimals}})?` : '';
  if (!new RegExp(`^\\d{1,${Math.min(maxIntegerDigits, INTEGER_DIGITS)}}${fraction}$`).test(value)) return false;
  return new Decimal(value).gt(0);
}

/** Tolérance d'écart (D-224) : maximum d'une part fixe (TND) et d'une part relative au total. */
export interface AmountTolerance {
  /** Part fixe en TND (paramètre fuel.amountToleranceTnd). */
  absolute: Decimal;
  /** Part relative au total (paramètre fuel.amountToleranceRatio ; 0,01 = 1 %). */
  ratio: Decimal;
}

/** Construit la tolérance à partir des paramètres (nombres décimaux convertis sans perte via leur écriture). */
export function toleranceOf(absoluteTnd: number | string, ratio: number | string): AmountTolerance {
  return { absolute: new Decimal(absoluteTnd), ratio: new Decimal(ratio) };
}

export interface AmountConsistency {
  /** Faux lorsque le prix unitaire est absent : aucun contrôle possible (D-224). */
  checked: boolean;
  /** |litres × prix unitaire − total|, exact, sans arrondi intermédiaire. */
  gap: Decimal | null;
  /** Seuil appliqué : max(part fixe, part relative × total). */
  threshold: Decimal | null;
  /** Écart strictement supérieur au seuil : signalé, jamais corrigé. */
  mismatch: boolean;
  /** Écart enregistré (arrondi à 3 décimales, demi vers le haut) lorsqu'il est signalé. */
  reportedGap: Decimal | null;
}

/**
 * Arithmétique sans arrondi pour le contrôle d'écart : le constructeur global de decimal.js arrondit chaque
 * opération à 20 chiffres significatifs, alors que le produit de deux DECIMAL(18,3) en compte jusqu'à 36.
 */
const Exact = Decimal.clone({ precision: 64 });

/** Contrôle litres × prix unitaire / total (8.2, D-224). Le total saisi n'est jamais recalculé. */
export function checkAmountConsistency(input: { liters: Decimal; unitPrice: Decimal | null; total: Decimal; tolerance: AmountTolerance }): AmountConsistency {
  if (input.unitPrice === null) return { checked: false, gap: null, threshold: null, mismatch: false, reportedGap: null };
  const total = new Exact(input.total.toString());
  const exactGap = new Exact(input.liters.toString()).times(input.unitPrice.toString()).minus(total).abs();
  const exactThreshold = Exact.max(input.tolerance.absolute.toString(), new Exact(input.tolerance.ratio.toString()).times(total));
  const mismatch = exactGap.gt(exactThreshold);
  // Retour au constructeur commun : une construction ne réduit jamais la précision de la valeur.
  const gap = new Decimal(exactGap.toFixed());
  return { checked: true, gap, threshold: new Decimal(exactThreshold.toFixed()), mismatch, reportedGap: mismatch ? roundMoney(gap) : null };
}
