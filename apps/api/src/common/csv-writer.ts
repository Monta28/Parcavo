import { Decimal } from 'decimal.js';
import { neutralizeSpreadsheetCell } from './csv-safety.js';

/**
 * Écriture CSV unique (rapports d'import, exports, 11.2, D-270) : UTF-8 avec BOM pour les tableurs,
 * séparateur « ; », fins de ligne CRLF, guillemets RFC 4180, virgule décimale pour les nombres, et
 * neutralisation des seules cellules texte interprétables comme formules (T34). Aucune autre fonction
 * n'écrit de CSV destiné à l'utilisateur.
 */
export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';
export const CSV_EOL = '\r\n';

/**
 * Nombre typé (valeur décimale canonique « 1234.500 » ou « -5 ») : jamais neutralisé, écrit avec la
 * virgule décimale. Évite de confondre un nombre négatif avec un texte commençant par « - ».
 */
export class CsvNumber {
  constructor(readonly value: string) {}

  static of(value: Decimal | number | string): CsvNumber {
    return new CsvNumber(value instanceof Decimal ? value.toFixed() : typeof value === 'number' ? value.toString() : new Decimal(value).toFixed());
  }
}

function cellText(cell: unknown): string {
  if (cell instanceof CsvNumber) return cell.value.replace('.', ',');
  if (typeof cell === 'number' || cell instanceof Decimal) return cell.toString().replace('.', ',');
  return neutralizeSpreadsheetCell(cell);
}

/** Une ligne CSV (sans fin de ligne). */
export function csvLine(cells: ReadonlyArray<unknown>): string {
  return cells.map((cell) => quote(cellText(cell))).join(CSV_SEPARATOR);
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines = [header, ...rows].map((row) => csvLine(row));
  return `${CSV_BOM}${lines.join(CSV_EOL)}${CSV_EOL}`;
}

/**
 * Document CSV d'export (D-270) : bloc de métadonnées (libellé ; valeur), une ligne vide, puis
 * l'en-tête et le tableau.
 */
export function toCsvDocument(input: { metadata: ReadonlyArray<readonly [string, string]>; header: readonly string[]; rows: ReadonlyArray<ReadonlyArray<unknown>> }): string {
  return `${CSV_BOM}${csvPreamble(input.metadata, input.header)}${input.rows.map((row) => csvLine(row) + CSV_EOL).join('')}`;
}

/** Métadonnées, ligne vide et en-tête (sans BOM) : début d'un export écrit en flux. */
export function csvPreamble(metadata: ReadonlyArray<readonly [string, string]>, header: readonly string[]): string {
  return `${metadata.map(([label, value]) => csvLine([label, value]) + CSV_EOL).join('')}${CSV_EOL}${csvLine(header)}${CSV_EOL}`;
}

function quote(text: string): string {
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
