import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { kmLabel, kmValue, truncateKm } from './km-display.js';

describe('affichage des kilomètres : troncature, jamais d’arrondi (CDC 13.1)', () => {
  it.each([
    ['90300.6', '90300'],
    ['90300.999', '90300'],
    ['90300.5', '90300'],
    ['90300.4', '90300'],
    ['90300', '90300'],
    ['0.9', '0'],
    ['0', '0'],
    // Reste négatif (échéance dépassée) : troncature vers zéro, jamais « -0 ».
    ['-200.7', '-200'],
    ['-0.5', '0'],
  ])('%s → %s', (input, expected) => {
    expect(kmValue(input)).toBe(expected);
    expect(truncateKm(new Decimal(input)).toFixed(0)).toBe(expected);
  });

  it('accepte un Decimal Prisma (toString) et conserve null', () => {
    expect(kmValue({ toString: () => '120499.9' })).toBe('120499');
    expect(kmValue(null)).toBeNull();
    expect(kmValue(undefined)).toBeNull();
  });

  it('différence avec l’arrondi : toFixed(0) donnerait 90 301', () => {
    expect(new Decimal('90300.6').toFixed(0)).toBe('90301');
    expect(kmValue('90300.6')).toBe('90300');
  });

  it('libellé français tronqué', () => {
    expect(kmLabel('90000.9').replace(/\s/g, ' ')).toBe('90 000 km');
  });
});
