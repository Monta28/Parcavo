import { once } from 'node:events';
import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { neutralizeSpreadsheetText } from '../../../common/csv-safety.js';
import { CSV_BOM, CSV_EOL, CsvNumber, csvLine, csvPreamble } from '../../../common/csv-writer.js';
import { columnDecimalText } from '../report-support.js';
import type { RawValue, ReportColumn, ReportRow } from '../report-types.js';
import { civilDateCell, formatCivilDate, formatLocalDateTime, localWallClock } from './format.js';

export type ExportFormat = 'csv' | 'xlsx';

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Contenu d'un export : bloc de paramètres (libellé, valeur), colonnes et fuseau des horodatages. */
export interface ExportDocument {
  metadata: ReadonlyArray<readonly [string, string]>;
  columns: readonly ReportColumn[];
  timezone: string;
}

/** En-tête d'une colonne : libellé et unité (D-270). */
export function headerLabel(col: ReportColumn): string {
  return col.unit ? `${col.label} (${col.unit})` : col.label;
}

function decimalsOf(col: ReportColumn): number {
  return col.exportDecimals ?? col.decimals ?? 3;
}

function asDecimal(value: RawValue): Decimal {
  return value instanceof Decimal ? value : new Decimal(typeof value === 'number' || typeof value === 'string' ? value : 0);
}

function text(value: RawValue): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Cellule CSV typée : nombre (CsvNumber, virgule décimale), date locale ou texte (neutralisé à l'écriture). */
export function csvCell(col: ReportColumn, value: RawValue, timezone: string): unknown {
  if (value === null) return col.missing ?? '';
  switch (col.kind) {
    case 'decimal':
    case 'money':
      return new CsvNumber(columnDecimalText(col, asDecimal(value), decimalsOf(col)));
    case 'integer':
      return typeof value === 'number' ? value : Number(value);
    case 'date':
      return formatCivilDate(text(value));
    case 'datetime':
      return value instanceof Date ? formatLocalDateTime(value, timezone) : text(value);
    case 'boolean':
      return value === true ? 'Oui' : 'Non';
    case 'enum':
      return col.labels?.[text(value)] ?? text(value);
    default:
      return text(value);
  }
}

/** Cellule XLSX typée : nombres et dates natifs, textes neutralisés ; jamais de formule. */
export function xlsxCell(col: ReportColumn, value: RawValue, timezone: string): ExcelJS.CellValue {
  if (value === null) return col.missing ?? null;
  switch (col.kind) {
    case 'decimal':
    case 'money':
      return Number(columnDecimalText(col, asDecimal(value), decimalsOf(col)));
    case 'integer':
      return typeof value === 'number' ? value : Number(value);
    case 'date':
      return civilDateCell(text(value));
    case 'datetime':
      return value instanceof Date ? localWallClock(value, timezone) : neutralizeSpreadsheetText(text(value));
    case 'boolean':
      return value === true ? 'Oui' : 'Non';
    case 'enum':
      return neutralizeSpreadsheetText(col.labels?.[text(value)] ?? text(value));
    default:
      return neutralizeSpreadsheetText(text(value));
  }
}

function numFmt(col: ReportColumn): string | undefined {
  switch (col.kind) {
    case 'decimal':
    case 'money': {
      const d = decimalsOf(col);
      return d === 0 ? '#,##0' : `#,##0.${'0'.repeat(d)}`;
    }
    case 'integer':
      return '0';
    case 'date':
      return 'dd/mm/yyyy';
    case 'datetime':
      return 'dd/mm/yyyy hh:mm';
    default:
      return undefined;
  }
}

async function write(target: Writable, chunk: string): Promise<void> {
  if (!target.write(chunk)) await once(target, 'drain');
}

/**
 * CSV d'export (D-270) : BOM UTF-8, séparateur « ; », CRLF, virgule décimale, bloc de paramètres puis ligne
 * vide puis tableau. Écrit en flux ; termine le flux cible. Renvoie le nombre de lignes écrites.
 */
export async function writeCsv(target: Writable, doc: ExportDocument, rows: AsyncIterable<readonly ReportRow[]>): Promise<number> {
  let count = 0;
  await write(target, CSV_BOM + csvPreamble(doc.metadata, doc.columns.map(headerLabel)));
  for await (const chunk of rows) {
    let buffer = '';
    for (const row of chunk) {
      buffer += csvLine(doc.columns.map((c) => csvCell(c, row.values[c.key] ?? null, doc.timezone))) + CSV_EOL;
      count += 1;
    }
    if (buffer) await write(target, buffer);
  }
  target.end();
  return count;
}

/**
 * XLSX d'export (D-270) : feuille « Données » (nombres et dates typés, en-têtes avec unités) et feuille
 * « Paramètres » (rapport, génération, auteur, périmètre, filtres, unités). Écrit en flux ; termine le flux.
 */
export async function writeXlsx(target: Writable, doc: ExportDocument, rows: AsyncIterable<readonly ReportRow[]>): Promise<number> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: target, useStyles: true, useSharedStrings: false });
  const data = workbook.addWorksheet('Données', { views: [{ state: 'frozen', ySplit: 1 }] });
  data.columns = doc.columns.map((c) => {
    const fmt = numFmt(c);
    return { header: headerLabel(c), key: c.key, width: Math.min(60, Math.max(12, headerLabel(c).length + 2)), ...(fmt ? { style: { numFmt: fmt } } : {}) };
  });
  const header = data.getRow(1);
  header.font = { bold: true };
  header.commit();
  let count = 0;
  for await (const chunk of rows) {
    for (const row of chunk) {
      data.addRow(doc.columns.map((c) => xlsxCell(c, row.values[c.key] ?? null, doc.timezone))).commit();
      count += 1;
    }
  }
  data.commit();
  const params = workbook.addWorksheet('Paramètres');
  params.columns = [
    { header: 'Paramètre', key: 'label', width: 28 },
    { header: 'Valeur', key: 'value', width: 100 },
  ];
  const paramsHeader = params.getRow(1);
  paramsHeader.font = { bold: true };
  paramsHeader.commit();
  for (const [label, value] of doc.metadata) params.addRow([neutralizeSpreadsheetText(label), neutralizeSpreadsheetText(value)]).commit();
  params.addRow([]).commit();
  params.addRow(['Colonne', 'Unité']).commit();
  for (const c of doc.columns) params.addRow([neutralizeSpreadsheetText(c.label), c.unit ?? '']).commit();
  params.commit();
  await workbook.commit();
  return count;
}

export async function writeExport(format: ExportFormat, target: Writable, doc: ExportDocument, rows: AsyncIterable<readonly ReportRow[]>): Promise<number> {
  return format === 'csv' ? writeCsv(target, doc, rows) : writeXlsx(target, doc, rows);
}
