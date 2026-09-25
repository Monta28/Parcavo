'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { IMPORT_CREATED_OBJECT_TYPES, IMPORT_ROW_STATUSES, IMPORT_ROW_STATUS_LABELS, type ImportBatchView, type ImportModel, type ImportRowStatus, type ImportRowView } from '@/lib/imports-types';
import { objectHref } from '@/lib/object-links';
import { cn } from '@/lib/utils';
import { toneForRow } from './import-tones';

const ALL = '__all__';
const PAGE_SIZE = 25;

/**
 * Résultat ligne par ligne (GET /imports/:id/rows) : numéro de ligne du fichier, statut, valeurs lues,
 * cellules en erreur mises en évidence, messages par colonne et avertissements, fiche créée.
 */
export function ImportRows({ batch, model }: { batch: ImportBatchView; model: ImportModel }) {
  const [status, setStatus] = useState<ImportRowStatus | ''>('');
  const [page, setPage] = useState(1);
  const query = toQuery({ status, page, pageSize: PAGE_SIZE });
  const rows = useQuery({ queryKey: ['import-rows', batch.id, batch.version, query], queryFn: () => api<Page<ImportRowView>>(`/imports/${batch.id}/rows${query}`) });

  const mapping = batch.columnMapping ?? {};
  const columns = model.columns.filter((c) => mapping[c.name]);
  // Lien vers la page de l'objet créé, seulement après confirmation et pour les objets qui en ont une.
  const createdType = batch.status === 'CONFIRME' ? IMPORT_CREATED_OBJECT_TYPES[batch.kind] : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status || ALL}
          onValueChange={(v) => {
            setStatus(v === ALL ? '' : (v as ImportRowStatus));
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Statut des lignes" className="w-64">
            <SelectValue placeholder="Statut des lignes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes les lignes</SelectItem>
            {IMPORT_ROW_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {IMPORT_ROW_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.isPending ? (
        <LoadingState label="Chargement des lignes…" />
      ) : rows.isError ? (
        <ErrorState error={rows.error} retry={() => void rows.refetch()} />
      ) : rows.data.total === 0 ? (
        <EmptyState title="Aucune ligne" description={status ? 'Aucune ligne n’a ce statut.' : 'Le contrôle n’a produit aucune ligne.'} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <caption className="sr-only">Lignes du fichier {batch.fileName} et résultat du contrôle</caption>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Ligne</TableHead>
                <TableHead>Statut</TableHead>
                {columns.map((c) => (
                  <TableHead key={c.name} className="align-bottom">
                    <span className="block font-mono text-xs">{c.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">« {mapping[c.name]} »</span>
                  </TableHead>
                ))}
                <TableHead className="min-w-72">Erreurs et avertissements</TableHead>
                {createdType ? <TableHead>Fiche créée</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.items.map((row) => (
                <TableRow key={row.rowNumber} className={row.status === 'ERREUR' ? 'bg-destructive/5' : undefined}>
                  <TableCell className="text-right font-medium tabular-nums">{row.rowNumber}</TableCell>
                  <TableCell>
                    <StatusBadge label={IMPORT_ROW_STATUS_LABELS[row.status]} tone={toneForRow(row.status)} />
                  </TableCell>
                  {columns.map((c) => {
                    const messages = row.errors.filter((e) => e.column === c.name).map((e) => e.message);
                    const value = row.values[c.name];
                    return (
                      <TableCell
                        key={c.name}
                        title={messages.length > 0 ? messages.join(' ') : undefined}
                        className={cn('max-w-56 truncate', messages.length > 0 && 'bg-destructive/10 font-medium text-destructive ring-1 ring-destructive/40 ring-inset')}
                      >
                        {value ? value : <span className="text-muted-foreground">—</span>}
                        {messages.length > 0 ? <span className="sr-only"> (en erreur)</span> : null}
                      </TableCell>
                    );
                  })}
                  <TableCell className="whitespace-normal">
                    {row.errors.length === 0 && row.notes.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {row.errors.map((e, i) => (
                          <li key={`e${i}`} className="text-destructive">
                            {e.column ? <span className="font-mono text-xs">{e.column}</span> : 'Ligne'} : {e.message}
                          </li>
                        ))}
                        {row.notes.map((n, i) => (
                          <li key={`n${i}`} className="text-warning-foreground">
                            Avertissement : {n}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  {createdType ? (
                    <TableCell>
                      <CreatedObjectLink href={objectHref(createdType, row.createdObjectId)} rowNumber={row.rowNumber} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={rows.data.page} pageSize={rows.data.pageSize} total={rows.data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

function CreatedObjectLink({ href, rowNumber }: { href: string | null; rowNumber: number }) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <Link href={href} className="underline underline-offset-4">
      Ouvrir la fiche<span className="sr-only"> créée par la ligne {rowNumber}</span>
    </Link>
  );
}
