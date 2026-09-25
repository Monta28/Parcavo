'use client';

import { Lock } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { reportCellDisplay, reportHeader } from '@/lib/report-format';
import type { ReportColumn, ReportItem } from '@/lib/reports-types';
import { cn } from '@/lib/utils';

const NUMERIC_KINDS = new Set(['integer', 'decimal', 'money']);
const LONG_TEXT = 40;

/**
 * Tableau d'un rapport : colonnes décrites par meta.columns (libellé, unité), valeurs affichées telles que
 * l'API les renvoie. Valeur absente : libellé de l'API (N/D, Inconnu…), jamais 0 ; estimation signalée ;
 * colonne de coût retirée d'une ligne par l'API : « Masqué ».
 */
export function ReportTable({ columns, items, timezone, caption }: { columns: ReportColumn[]; items: ReportItem[]; timezone: string; caption?: string }) {
  return (
    <Table className="report-table">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.key} scope="col" className={cn('min-w-24 py-2 align-bottom whitespace-normal', NUMERIC_KINDS.has(column.kind) && 'text-right')}>
              {reportHeader(column)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item, index) => (
          <TableRow key={`${item.id}-${index}`}>
            {columns.map((column) => (
              <TableCell key={column.key} className={cn('align-top', NUMERIC_KINDS.has(column.kind) && 'text-right tabular-nums')}>
                <ReportCell column={column} item={item} timezone={timezone} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ReportCell({ column, item, timezone }: { column: ReportColumn; item: Record<string, unknown>; timezone: string }) {
  const cell = reportCellDisplay(column, item, timezone);
  switch (cell.kind) {
    case 'hidden':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Montant masqué : permission costs.read requise sur la société de cette ligne.">
          <Lock className="size-3" aria-hidden="true" />
          Masqué
          <span className="sr-only"> (permission costs.read requise sur la société de cette ligne)</span>
        </span>
      );
    case 'missing':
      return <span className="text-muted-foreground italic">{cell.text}</span>;
    case 'estimate':
      return <StatusBadge label={cell.text} tone="warning" />;
    default:
      // Texte long (motif N/D, description) : renvoyé à la ligne dans une colonne de largeur minimale.
      return cell.text.length > LONG_TEXT ? <span className="block max-w-md min-w-64 whitespace-normal">{cell.text}</span> : <>{cell.text}</>;
  }
}
