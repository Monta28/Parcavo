import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { columnDecimalText } from './report-support.js';

describe('columnDecimalText (écran et export des rapports)', () => {
  it('tronque un kilométrage affiché au km entier (km-display.ts, D-201), jamais arrondi', () => {
    expect(columnDecimalText({ unit: 'km' }, new Decimal('90000.9'), 0)).toBe('90000');
    expect(columnDecimalText({ unit: 'km' }, new Decimal('1234.5'), 0)).toBe('1234');
  });

  it('garde les décimales exactes d’un kilométrage exporté à trois décimales', () => {
    expect(columnDecimalText({ unit: 'km' }, new Decimal('1234.5'), 3)).toBe('1234.500');
  });

  it('arrondit les autres grandeurs à leurs décimales d’affichage', () => {
    expect(columnDecimalText({ unit: 'L/100 km' }, new Decimal('6.25'), 1)).toBe('6.3');
    expect(columnDecimalText({ unit: null }, new Decimal('-50'), 3)).toBe('-50.000');
  });
});
