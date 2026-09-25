import { describe, expect, it } from 'vitest';
import { fileNameFromDisposition, formatDecimalText, reportCellDisplay, reportHeader } from './report-format';
import type { ReportColumn } from './reports-types';

const plain = (s: string) => s.replace(/[  ]/g, ' ');

function column(overrides: Partial<ReportColumn>): ReportColumn {
  return { key: 'v', label: 'Valeur', unit: null, kind: 'text', cost: false, decimals: null, missing: null, labels: null, estimates: null, ...overrides };
}

describe('Cellules de rapport (CDC 11.2, 11.3)', () => {
  it('reprend un décimal exact sans arrondi ni flottant', () => {
    expect(plain(formatDecimalText('1234567.891'))).toBe('1 234 567,891');
    expect(plain(formatDecimalText('-1500.000'))).toBe('-1 500,000');
    expect(formatDecimalText('12345678901234567890.123')).toBe('12 345 678 901 234 567 890,123');
    expect(formatDecimalText('0')).toBe('0');
    expect(formatDecimalText(42)).toBe('42');
    expect(formatDecimalText('n/a')).toBe('n/a');
  });

  it('en-tête avec unité, comme l’export', () => {
    expect(reportHeader({ label: 'Distance observée', unit: 'km' })).toBe('Distance observée (km)');
    expect(reportHeader({ label: 'Code', unit: null })).toBe('Code');
  });

  it('valeur absente : libellé N/D de l’API, jamais 0', () => {
    const col = column({ key: 'distanceKm', kind: 'decimal', decimals: 0, missing: 'N/D' });
    expect(reportCellDisplay(col, { distanceKm: null }, 'Africa/Tunis')).toEqual({ kind: 'missing', text: 'N/D' });
    expect(reportCellDisplay(column({ key: 'site' }), { site: null }, 'Africa/Tunis')).toEqual({ kind: 'missing', text: '—' });
  });

  it('colonne de coût retirée de la ligne par l’API : masquée, pas vide', () => {
    const col = column({ key: 'costPerKm', kind: 'money', cost: true, missing: 'N/D' });
    expect(reportCellDisplay(col, { id: 'x' }, 'Africa/Tunis')).toEqual({ kind: 'hidden' });
    expect(reportCellDisplay(col, { costPerKm: null }, 'Africa/Tunis')).toEqual({ kind: 'missing', text: 'N/D' });
  });

  it('estimation signalée, libellés d’énumération et dates', () => {
    const nature = column({ key: 'n', kind: 'enum', labels: { ESTIMEE: 'Estimée (borne GPS)', MESUREE: 'Mesurée' }, estimates: ['ESTIMEE'] });
    expect(reportCellDisplay(nature, { n: 'ESTIMEE' }, 'Africa/Tunis')).toEqual({ kind: 'estimate', text: 'Estimée (borne GPS)' });
    expect(reportCellDisplay(nature, { n: 'MESUREE' }, 'Africa/Tunis')).toEqual({ kind: 'value', text: 'Mesurée', numeric: false });
    // Sans désignation par l'API, aucun code n'est traité comme une estimation.
    expect(reportCellDisplay({ ...nature, estimates: null }, { n: 'ESTIMEE' }, 'Africa/Tunis')).toEqual({ kind: 'value', text: 'Estimée (borne GPS)', numeric: false });
    expect(reportCellDisplay(column({ key: 'd', kind: 'date' }), { d: '2026-09-01' }, 'Africa/Tunis')).toEqual({ kind: 'value', text: '01/09/2026', numeric: false });
    expect(reportCellDisplay(column({ key: 't', kind: 'datetime' }), { t: '2026-09-25T23:30:00.000Z' }, 'Africa/Tunis')).toEqual({ kind: 'value', text: '26/09/2026 00:30', numeric: false });
    expect(reportCellDisplay(column({ key: 'b', kind: 'boolean' }), { b: false }, 'Africa/Tunis')).toEqual({ kind: 'value', text: 'Non', numeric: false });
  });

  it('nom de fichier de l’export', () => {
    expect(fileNameFromDisposition(`attachment; filename="rapport-inventaire.csv"; filename*=UTF-8''rapport-%C3%A9t%C3%A9.csv`, 'x')).toBe('rapport-été.csv');
    expect(fileNameFromDisposition('attachment; filename="rapport.xlsx"', 'x')).toBe('rapport.xlsx');
    expect(fileNameFromDisposition(null, 'export.csv')).toBe('export.csv');
  });
});
