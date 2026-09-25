'use client';

import { useQuery } from '@tanstack/react-query';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { IMPORT_BATCH_STATUSES, IMPORT_BATCH_STATUS_LABELS, type ImportBatchView, type ImportModel } from '@/lib/imports-types';
import { useListParams } from '@/lib/use-list-params';
import { toneForBatch } from './import-tones';

const ALL = '__all__';

/** Historique des lots (GET /imports) : l'administrateur voit tous les lots, le chef de parc les siens. */
export function ImportsHistory({ models }: { models: ImportModel[] }) {
  const { session } = useAppScope();
  const { get, set, page } = useListParams();
  const kind = get('type');
  const status = get('statut');
  const query = toQuery({ kind, status, page, pageSize: 25 });
  const batches = useQuery({ queryKey: ['imports', query], queryFn: () => api<Page<ImportBatchView>>(`/imports${query}`) });
  const labelOf = (k: string) => models.find((m) => m.kind === k)?.label ?? k;

  return (
    <section aria-labelledby="imports-history-title" className="space-y-4">
      <div>
        <h2 id="imports-history-title" className="text-lg font-semibold">
          Historique des lots
        </h2>
        <p className="text-sm text-muted-foreground">
          {session.isAdmin ? 'Tous les lots de l’organisation.' : 'Les lots que vous avez téléversés.'} Un lot téléversé ou contrôlé peut être repris jusqu’à sa confirmation ou son abandon.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select value={kind || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Modèle">
            <SelectValue placeholder="Modèle" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les modèles</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.kind} value={m.kind}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Statut du lot">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {IMPORT_BATCH_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {IMPORT_BATCH_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {batches.isPending ? (
        <LoadingState />
      ) : batches.isError ? (
        <ErrorState error={batches.error} retry={() => void batches.refetch()} />
      ) : batches.data.total === 0 ? (
        <EmptyState title="Aucun lot d’import" description={kind || status ? 'Aucun lot ne correspond aux filtres.' : 'Les fichiers envoyés apparaîtront ici avec leur rapport.'} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fichier</TableHead>
                <TableHead>Modèle</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Lignes</TableHead>
                <TableHead className="text-right">En erreur</TableHead>
                <TableHead>Téléversé le</TableHead>
                {session.isAdmin ? <TableHead>Par</TableHead> : null}
                <TableHead>Confirmé le</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.data.items.map((b) => {
                const open = b.status === 'TELEVERSE' || b.status === 'CONTROLE';
                return (
                  <TableRow key={b.id}>
                    <TableCell className="max-w-64 truncate font-medium" title={b.fileName}>
                      {b.fileName}
                    </TableCell>
                    <TableCell>{labelOf(b.kind)}</TableCell>
                    <TableCell>
                      <StatusBadge label={IMPORT_BATCH_STATUS_LABELS[b.status]} tone={toneForBatch(b.status)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.rowCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.counts ? b.counts.errors : '—'}</TableCell>
                    <TableCell>{formatDateTime(b.createdAt, session.timezone)}</TableCell>
                    {session.isAdmin ? <TableCell>{b.createdByName ?? '—'}</TableCell> : null}
                    <TableCell>{formatDateTime(b.committedAt, session.timezone)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => set({ lot: b.id })} aria-label={`${open ? 'Reprendre' : 'Consulter'} le lot ${b.fileName}`}>
                        {open ? 'Reprendre' : b.counts ? 'Consulter le rapport' : 'Consulter'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={batches.data.page} pageSize={batches.data.pageSize} total={batches.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </section>
  );
}
