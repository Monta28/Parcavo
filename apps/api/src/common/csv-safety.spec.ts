import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { isSpreadsheetFormulaLike, neutralizeSpreadsheetCell, neutralizeSpreadsheetText } from './csv-safety.js';

describe('Neutralisation des formules (D-270, T34)', () => {
  it('préfixe les textes commençant par = + - @ tabulation ou retour chariot', () => {
    for (const text of ['=HYPERLINK("http://x","clic")', '+33 1 23', '-5', '@SUM(A1)', '\tcmd', '\rcmd']) {
      expect(neutralizeSpreadsheetText(text)).toBe(`'${text}`);
      expect(isSpreadsheetFormulaLike(text)).toBe(true);
    }
  });

  it('préfixe aussi les variantes pleine chasse ＝ ＋ － ＠', () => {
    for (const text of ['＝1+1', '＋1', '－5', '＠SUM(A1)']) {
      expect(neutralizeSpreadsheetCell(text)).toBe(`'${text}`);
    }
  });

  it('ne préfixe jamais un nombre, même négatif', () => {
    expect(neutralizeSpreadsheetCell(-5)).toBe('-5');
    expect(neutralizeSpreadsheetCell(new Decimal('-12.500'))).toBe('-12.5');
    expect(neutralizeSpreadsheetCell(BigInt(-3))).toBe('-3');
  });

  it('laisse intacts les textes ordinaires et vide les valeurs absentes', () => {
    expect(neutralizeSpreadsheetCell('Peugeot 208')).toBe('Peugeot 208');
    expect(neutralizeSpreadsheetCell(' =espace')).toBe(' =espace');
    expect(neutralizeSpreadsheetCell('a=b')).toBe('a=b');
    expect(neutralizeSpreadsheetCell(null)).toBe('');
    expect(neutralizeSpreadsheetCell(undefined)).toBe('');
    expect(neutralizeSpreadsheetCell(true)).toBe('true');
    expect(neutralizeSpreadsheetCell(new Date('2026-09-24T10:00:00Z'))).toBe('2026-09-24T10:00:00.000Z');
  });
});
