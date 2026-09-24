import { Decimal } from 'decimal.js';

/**
 * Montants, quantités et kilomètres en décimal exact (CDC 13.1). Les échanges JSON utilisent des
 * chaînes ("1234.567") pour éviter toute perte de précision côté client.
 */
export { Decimal };

export type DecimalInput = Decimal | string | number;

export function toDecimal(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function toDecimalOrNull(value: DecimalInput | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : toDecimal(value);
}

/** Sérialisation stable (3 décimales) pour les DTO de réponse. */
export function decimalToString(value: DecimalInput | null | undefined, decimals = 3): string | null {
  if (value === null || value === undefined) return null;
  return toDecimal(value).toFixed(decimals);
}

export function isPositive(value: DecimalInput): boolean {
  return toDecimal(value).gt(0);
}

export function isNonNegative(value: DecimalInput): boolean {
  return toDecimal(value).gte(0);
}

export function roundKm(value: DecimalInput): Decimal {
  return toDecimal(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

export function roundMoney(value: DecimalInput, decimals = 3): Decimal {
  return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}
