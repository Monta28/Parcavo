'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompanyView } from '@/lib/admin-types';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDate } from '@/lib/format';
import { useListParams } from '@/lib/use-list-params';
import { CompanyDialog } from './company-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { ALL, COMPANY_STATUS_LABELS } from './labels';

type DialogState = { mode: 'create' } | { mode: 'edit'; company: CompanyView } | null;

/** Sociétés du groupe (CDC 2.1) : création, modification, activation de la télématique, archivage. */
export function CompaniesAdmin() {
  const { session } = useAppScope();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { get, set, page } = useListParams();
  const q = get('q');
  const status = get('statut');
  const query = toQuery({ q, status, page, pageSize: 25, sort: 'code' });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [archiving, setArchiving] = useState<CompanyView | null>(null);

  const companies = useQuery({ queryKey: ['companies', query], queryFn: () => api<Page<CompanyView>>(`/companies${query}`) });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['companies'] });
    // Le sélecteur de société de l'en-tête provient de la session serveur.
    router.refresh();
  };

  const archive = useMutation({
    mutationFn: (company: CompanyView) => api<CompanyView>(`/companies/${company.id}/archive`, { method: 'POST', body: { expectedVersion: company.version } }),
    onSuccess: (saved) => {
      toast.success(`Société ${saved.code} archivée.`);
      setArchiving(null);
      refreshAll();
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Archivage impossible.');
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Sociétés"
        description="Sociétés du groupe : identité, coordonnées, activation de la télématique et archivage."
        actions={
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <Plus className="size-4" /> Nouvelle société
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Rechercher une société" placeholder="Code ou raison sociale…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Statut">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {Object.entries(COMPANY_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {companies.isPending ? (
        <LoadingState />
      ) : companies.isError ? (
        <ErrorState error={companies.error} retry={() => void companies.refetch()} />
      ) : companies.data.total === 0 ? (
        <EmptyState
          title="Aucune société"
          description={q || status ? 'Aucune société ne correspond aux filtres.' : 'Créez la première société du groupe.'}
          action={
            q || status ? null : (
              <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
                <Plus className="size-4" /> Nouvelle société
              </Button>
            )
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
            {companies.data.total} société{companies.data.total > 1 ? 's' : ''}
          </p>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Raison sociale</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Télématique</TableHead>
                  <TableHead className="hidden md:table-cell">Contact</TableHead>
                  <TableHead className="hidden lg:table-cell">Créée le</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.data.items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.code}</TableCell>
                    <TableCell className="whitespace-normal">
                      {c.legalName}
                      {c.taxIdentifier ? <span className="block text-xs text-muted-foreground">Id. fiscal : {c.taxIdentifier}</span> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={COMPANY_STATUS_LABELS[c.status]} tone={c.status === 'ACTIF' ? 'success' : 'neutral'} />
                      {c.archivedAt ? <span className="block text-xs text-muted-foreground">le {formatDate(c.archivedAt, session.timezone)}</span> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={c.telemetryEnabled ? 'Activée' : 'Désactivée'} tone={c.telemetryEnabled ? 'info' : 'neutral'} />
                    </TableCell>
                    <TableCell className="hidden whitespace-normal md:table-cell">
                      {c.email || c.phone ? (
                        <>
                          {c.email ? <span className="block">{c.email}</span> : null}
                          {c.phone ? <span className="block text-muted-foreground">{c.phone}</span> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{formatDate(c.createdAt, session.timezone)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'edit', company: c })} aria-label={`Modifier la société ${c.code}`}>
                          Modifier
                        </Button>
                        {c.status === 'ACTIF' ? (
                          <Button variant="outline" size="sm" onClick={() => setArchiving(c)} aria-label={`Archiver la société ${c.code}`}>
                            Archiver
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls page={companies.data.page} pageSize={companies.data.pageSize} total={companies.data.total} onPageChange={(p) => set({ page: p })} />
          </div>
        </>
      )}

      {dialog ? (
        <CompanyDialog
          key={dialog.mode === 'edit' ? dialog.company.id : 'new'}
          company={dialog.mode === 'edit' ? dialog.company : undefined}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSaved={() => {
            setDialog(null);
            refreshAll();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open && !archive.isPending) setArchiving(null);
        }}
        title={archiving ? `Archiver la société ${archiving.code} ?` : 'Archiver la société ?'}
        description={
          <>
            <p>La société {archiving?.legalName} ne sera plus proposée pour de nouvelles opérations. Son historique est conservé ; il n’existe pas de suppression.</p>
            <p>L’archivage est refusé tant que des véhicules actifs ou hors service, ou des utilisations en cours, lui sont rattachés.</p>
          </>
        }
        confirmLabel="Archiver"
        destructive
        pending={archive.isPending}
        onConfirm={() => {
          if (archiving) archive.mutate(archiving);
        }}
      />
    </div>
  );
}
