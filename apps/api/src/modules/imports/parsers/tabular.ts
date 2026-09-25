import ExcelJS from 'exceljs';
import { BusinessRuleError } from '../../../common/errors.js';
import type { Cell } from './values.js';

export interface TableRow {
  /** Numéro de ligne dans le fichier (l'en-tête est la ligne 1), cité dans le rapport. */
  line: number;
  cells: Cell[];
}

export interface Table {
  headers: string[];
  rows: TableRow[];
}

/**
 * Lecture d'un fichier d'import (CDC 12.1, D-278) : CSV UTF-8 (BOM accepté, séparateur « ; » ou « , »
 * détecté sur la ligne d'en-tête, guillemets RFC 4180) ou XLSX (feuille « Données », sinon la
 * première ; cellules date typées ; formules sans valeur en cache et cellules fusionnées refusées).
 */
export async function readTable(buffer: Buffer, fileName: string, maxRows: number): Promise<Table> {
  const lower = fileName.toLowerCase();
  const table = lower.endsWith('.xlsx') ? await readXlsx(buffer) : readCsv(buffer);
  const rows = table.rows.filter((r) => r.cells.some((c) => c !== null && (typeof c !== 'string' || c.trim() !== '')));
  if (table.headers.length === 0) throw new BusinessRuleError('FICHIER_VIDE', 'Le fichier ne contient pas de ligne d’en-tête.');
  if (rows.length === 0) throw new BusinessRuleError('FICHIER_VIDE', 'Le fichier ne contient aucune ligne de données.');
  if (rows.length > maxRows) throw new BusinessRuleError('TROP_DE_LIGNES', `Le fichier contient ${rows.length} lignes : maximum ${maxRows} par lot.`);
  return { headers: table.headers, rows };
}

function readCsv(buffer: Buffer): Table {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new BusinessRuleError('ENCODAGE_INVALIDE', 'Le fichier CSV doit être encodé en UTF-8.');
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  // Un guillemet n'ouvre une valeur citée qu'en début de champ (RFC 4180) ; ailleurs il est littéral.
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === separator) {
      record.push(field);
      field = '';
      atFieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  if (inQuotes) throw new BusinessRuleError('CSV_INVALIDE', 'Guillemet non fermé dans le fichier CSV.');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...rest] = records;
  return { headers: header.map((h) => h.trim()), rows: rest.map((cells, index) => ({ line: index + 2, cells })) };
}

async function readXlsx(buffer: Buffer): Promise<Table> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BusinessRuleError('XLSX_INVALIDE', 'Classeur XLSX illisible.');
  }
  const sheet = workbook.getWorksheet('Données') ?? workbook.worksheets[0];
  if (!sheet) throw new BusinessRuleError('XLSX_INVALIDE', 'Le classeur ne contient aucune feuille.');
  const merges = (sheet.model as { merges?: string[] }).merges ?? [];
  if (merges.length > 0) throw new BusinessRuleError('CELLULES_FUSIONNEES', `Cellules fusionnées refusées (${merges.slice(0, 3).join(', ')}).`);
  const headers: string[] = [];
  const rows: TableRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: Cell[] = [];
    const count = Math.max(row.cellCount, headers.length);
    for (let c = 1; c <= count; c += 1) {
      const cell = row.getCell(c);
      values.push(toCell(cell.value, rowNumber, c, cell.numFmt));
    }
    if (headers.length === 0) headers.push(...values.map((v) => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? v.date : '')));
    else rows.push({ line: rowNumber, cells: values });
  });
  return { headers, rows };
}

function toCell(value: ExcelJS.CellValue, row: number, col: number, numFmt?: string): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // ExcelJS restitue l'heure murale du classeur en UTC ; minuit n'est une heure que si le format en affiche une.
    const iso = value.toISOString();
    const time = iso.slice(11, 23);
    return time !== '00:00:00.000' || /h/i.test(numFmt ?? '') ? { date: iso.slice(0, 10), time } : { date: iso.slice(0, 10) };
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      if (result === undefined || result === null || typeof result === 'object') throw new BusinessRuleError('FORMULE_SANS_VALEUR', `Formule sans valeur calculée (ligne ${row}, colonne ${col}) : enregistrez les valeurs.`);
      return toCell(result, row, col, numFmt);
    }
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return String((value as { text: string }).text);
    if ('error' in value) throw new BusinessRuleError('CELLULE_ERREUR', `Cellule en erreur (ligne ${row}, colonne ${col}).`);
  }
  return String(value);
}
