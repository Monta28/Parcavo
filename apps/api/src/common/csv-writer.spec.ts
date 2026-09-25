import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { CsvNumber, csvLine, toCsv, toCsvDocument } from './csv-writer.js';

describe('toCsv', () => {
  it('écrit un BOM, le séparateur « ; » et neutralise les formules', () => {
    const csv = toCsv(['a', 'b'], [['=1+1', 'x;y'], ['+33', 'dit "oui"'], [null, 12]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual(['a;b', "'=1+1;\"x;y\"", "'+33;\"dit \"\"oui\"\"\"", ';12', '']);
  });
});

describe('csvLine (D-270)', () => {
  it('écrit les nombres avec la virgule décimale, sans jamais les préfixer', () => {
    expect(csvLine([CsvNumber.of(new Decimal('-5.250')), CsvNumber.of('1234.500'), -5, 2.5, new Decimal('-0.75')])).toBe('-5,25;1234,5;-5;2,5;-0,75');
  });

  it('neutralise le texte « -5 » mais pas le nombre -5', () => {
    expect(csvLine(['-5', CsvNumber.of(-5)])).toBe("'-5;-5");
  });

  it('protège les retours à la ligne et les guillemets', () => {
    expect(csvLine(['ligne 1\nligne 2', 'a"b'])).toBe('"ligne 1\nligne 2";"a""b"');
  });
});

describe('toCsvDocument (D-270)', () => {
  it('bloc de métadonnées, ligne vide, en-tête puis tableau, en CRLF avec BOM', () => {
    const csv = toCsvDocument({ metadata: [['Rapport', 'Inventaire du parc'], ['Filtres', '=cmd']], header: ['Code', 'Distance (km)'], rows: [['V-1', CsvNumber.of('12.5')]] });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual(['Rapport;Inventaire du parc', "Filtres;'=cmd", '', 'Code;Distance (km)', 'V-1;12,5', '']);
  });
});
