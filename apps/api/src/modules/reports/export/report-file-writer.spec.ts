import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ReportColumn, ReportRow } from '../report-types.js';
import { writeCsv, writeXlsx, type ExportDocument } from './report-file-writer.js';

const columns: ReportColumn[] = [
  { key: 'model', label: 'Modèle', unit: null, kind: 'text' },
  { key: 'km', label: 'Distance', unit: 'km', kind: 'decimal', decimals: 0, exportDecimals: 3, missing: 'N/D' },
  { key: 'amount', label: 'Montant', unit: 'TND', kind: 'money', decimals: 3 },
  { key: 'count', label: 'Nombre', unit: null, kind: 'integer' },
  { key: 'on', label: 'Date', unit: null, kind: 'date' },
  { key: 'at', label: 'Horodatage', unit: null, kind: 'datetime' },
  { key: 'ok', label: 'Validé', unit: null, kind: 'boolean' },
  { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: { EN_COURS: 'En cours' } },
];

const rows: ReportRow[] = [
  { id: '1', companyId: 'A', values: { model: '=HYPERLINK("x")', km: new Decimal('1234.5'), amount: new Decimal('-50'), count: -5, on: '2026-09-24', at: new Date('2026-09-24T10:00:00Z'), ok: true, status: 'EN_COURS' } },
  { id: '2', companyId: 'A', values: { model: '-5', km: null, amount: '12.345', count: 3, on: null, at: null, ok: false, status: null } },
];

const doc: ExportDocument = { metadata: [['Rapport', 'Essai'], ['Filtre — Recherche', '+cmd']], columns, timezone: 'Africa/Tunis' };

async function* chunks(): AsyncGenerator<readonly ReportRow[]> {
  yield rows;
}

async function collect(write: (target: PassThrough) => Promise<number>): Promise<{ buffer: Buffer; count: number }> {
  const target = new PassThrough();
  const parts: Buffer[] = [];
  target.on('data', (part: Buffer) => parts.push(part));
  const ended = new Promise<void>((resolve) => target.on('end', resolve));
  const count = await write(target);
  await ended;
  return { buffer: Buffer.concat(parts), count };
}

describe('writeCsv (D-270)', () => {
  it('écrit BOM, métadonnées, ligne vide, en-têtes avec unités puis lignes typées', async () => {
    const { buffer, count } = await collect((t) => writeCsv(t, doc, chunks()));
    expect(count).toBe(2);
    const text = buffer.toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.slice(1).split('\r\n')).toEqual([
      'Rapport;Essai',
      "Filtre — Recherche;'+cmd",
      '',
      'Modèle;Distance (km);Montant (TND);Nombre;Date;Horodatage;Validé;Statut',
      `"'=HYPERLINK(""x"")";1234,500;-50,000;-5;24/09/2026;24/09/2026 11:00;Oui;En cours`,
      "'-5;N/D;12,345;3;;;Non;",
      '',
    ]);
  });
});

describe('kilomètres entiers (km-display.ts, D-201)', () => {
  it('tronque un compteur exporté au km entier, en CSV comme en XLSX, sans jamais l’arrondir', async () => {
    const odometer: ReportColumn[] = [{ key: 'currentKm', label: 'Kilométrage cumulé', unit: 'km', kind: 'decimal', decimals: 0 }];
    const kmDoc: ExportDocument = { metadata: [], columns: odometer, timezone: 'Africa/Tunis' };
    async function* one(): AsyncGenerator<readonly ReportRow[]> {
      yield [{ id: '1', companyId: 'A', values: { currentKm: new Decimal('90000.9') } }];
    }
    const csv = await collect((t) => writeCsv(t, kmDoc, one()));
    expect(csv.buffer.toString('utf8').split('\r\n')).toContain('90000');
    const xlsx = await collect((t) => writeXlsx(t, kmDoc, one()));
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.buffer as unknown as ArrayBuffer);
    expect((book.getWorksheet('Données') as ExcelJS.Worksheet).getRow(2).getCell(1).value).toBe(90000);
  });
});

describe('writeXlsx (D-270)', () => {
  it('feuilles « Données » typée et « Paramètres », aucune formule, textes neutralisés', async () => {
    const { buffer, count } = await collect((t) => writeXlsx(t, doc, chunks()));
    expect(count).toBe(2);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(book.worksheets.map((w) => w.name)).toEqual(['Données', 'Paramètres']);
    const data = book.getWorksheet('Données') as ExcelJS.Worksheet;
    expect(data.getRow(1).values).toEqual([undefined, 'Modèle', 'Distance (km)', 'Montant (TND)', 'Nombre', 'Date', 'Horodatage', 'Validé', 'Statut']);
    const first = data.getRow(2);
    expect(first.getCell(1).value).toBe('\'=HYPERLINK("x")');
    expect(first.getCell(2).value).toBe(1234.5);
    expect(first.getCell(2).type).toBe(ExcelJS.ValueType.Number);
    expect(first.getCell(3).value).toBe(-50);
    expect(first.getCell(4).value).toBe(-5);
    expect(first.getCell(5).value).toEqual(new Date('2026-09-24T00:00:00.000Z'));
    expect(first.getCell(5).type).toBe(ExcelJS.ValueType.Date);
    // Heure murale locale (Africa/Tunis, UTC+1) : 11:00.
    expect(first.getCell(6).value).toEqual(new Date('2026-09-24T11:00:00.000Z'));
    expect(first.getCell(7).value).toBe('Oui');
    expect(first.getCell(8).value).toBe('En cours');
    const second = data.getRow(3);
    expect(second.getCell(1).value).toBe("'-5");
    expect(second.getCell(2).value).toBe('N/D');
    let formulas = 0;
    book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) formulas += 1;
    })));
    expect(formulas).toBe(0);
    const params = book.getWorksheet('Paramètres') as ExcelJS.Worksheet;
    expect(params.getRow(2).values).toEqual([undefined, 'Rapport', 'Essai']);
    expect(params.getRow(3).values).toEqual([undefined, 'Filtre — Recherche', "'+cmd"]);
  });
});
