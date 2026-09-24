'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ArchivableStatus, CompanyView, DepartmentView, SiteView } from '@/lib/admin-types';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { useListParams } from '@/lib/use-list-params';
import { ConfirmDialog } from '../confirm-dialog';
import { ALL, ARCHIVABLE_STATUS_LABELS } from '../labels';
import { DepartmentDialog } from './department-dialog';
import { SiteDialog } from './site-dialog';

type SiteDialogState = { mode: 'create' } | { mode: 'edit'; site: SiteView } | null;
type DepartmentDialogState = { mode: 'create' } | { mode: 'edit'; department: DepartmentView } | null;
type StatusChange = { kind: 'site'; item: SiteView; next: ArchivableStatus } | { kind: 'department'; item: DepartmentView; next: ArchivableStatus } | null;

function statusOf(value: string): ArchivableStatus {
  return value === 'ARCHIVE' ? 'ARCHIVE' : 'ACTIF';
}

/** Sites et services d'une société (CDC 2.1). */
export function SitesAdmin() {
  const { companyId: scopeCompanyId } = useAppScope();
  const queryClient = useQueryClient();
  const { get, set, page } = useListParams();
  const siteStatus = get('statut');
  const [siteDialog, setSiteDialog] = useState<SiteDialogState>(null);
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState>(null);
  const [statusChange, setStatusChange] = useState<StatusChange>(null);

  const companies = useQuery({ queryKey: ['companies', 'options'], queryFn: () => api<Page<CompanyView>>(`/companies${toQuery({ pageSize: 100, sort: 'code' })}`) });
  const companyItems = companies.data?.items ?? [];
  const requested = get('societe') || scopeCompanyId || '';
  const company = companyItems.find((c) => c.id === requested) ?? companyItems.find((c) => c.status === 'ACTIF') ?? companyItems[0];
  const companyId = company?.id ?? '';
  const companyLabel = company ? `${company.code} · ${company.legalName}` : '';

  const sitesQuery = toQuery({ companyId, status: siteStatus, page, pageSize: 25 });
  const sites = useQuery({ queryKey: ['sites', 'admin', sitesQuery], queryFn: () => api<Page<SiteView>>(`/sites${sitesQuery}`), enabled: Boolean(companyId) });
  const departments = useQuery({ queryKey: ['departments', companyId], queryFn: () => api<DepartmentView[]>(`/departments${toQuery({ companyId })}`), enabled: Boolean(companyId) });

  const changeStatus = useMutation({
    mutationFn: (change: NonNullable<StatusChange>) =>
      api(`/${change.kind === 'site' ? 'sites' : 'departments'}/${change.item.id}`, { method: 'PATCH', body: { status: change.next, expectedVersion: change.item.version } }),
    onSuccess: (_data, change) => {
      const what = change.kind === 'site' ? 'Site' : 'Service';
      toast.success(change.next === 'ARCHIVE' ? `${what} archivé.` : `${what} réactivé.`);
      setStatusChange(null);
      void queryClient.invalidateQueries({ queryKey: [change.kind === 'site' ? 'sites' : 'departments'] });
    },
    onError: (error, change) => {
      toast.error(isApiError(error) ? error.message : 'Mise à jour impossible.');
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: [change.kind === 'site' ? 'sites' : 'departments'] });
    },
  });

  return (
    <div>
      <PageHeader title="Sites et services" description="Sites (lieux de stationnement ou d’exploitation) et services de chaque société." />

      {companies.isPending ? (
        <LoadingState label="Chargement des sociétés…" />
      ) : companies.isError ? (
        <ErrorState error={companies.error} retry={() => void companies.refetch()} />
      ) : !company ? (
        <EmptyState title="Aucune société" description="Créez d’abord une société dans l’onglet Sociétés." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="sites-company">Société</Label>
              <Select value={companyId} onValueChange={(v) => set({ societe: v })}>
                <SelectTrigger id="sites-company" className="w-full">
                  <SelectValue placeholder="Société" />
                </SelectTrigger>
                <SelectContent>
                  {companyItems.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} · {c.legalName}
                      {c.status === 'ARCHIVE' ? ' (archivée)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>Sites de la société {companyLabel}.</CardDescription>
              <CardAction>
                <Button size="sm" onClick={() => setSiteDialog({ mode: 'create' })}>
                  <Plus className="size-4" /> Nouveau site
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <Select value={siteStatus || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
                  <SelectTrigger aria-label="Statut des sites" className="w-full">
                    <SelectValue placeholder="Statut" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Tous les statuts</SelectItem>
                    {Object.entries(ARCHIVABLE_STATUS_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {sites.isPending ? (
                <LoadingState label="Chargement des sites…" />
              ) : sites.isError ? (
                <ErrorState error={sites.error} retry={() => void sites.refetch()} />
              ) : sites.data.total === 0 ? (
                <EmptyState title="Aucun site" description={siteStatus ? 'Aucun site ne correspond au filtre.' : 'Aucun site n’est encore déclaré pour cette société.'} />
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        <TableHead className="hidden md:table-cell">Adresse</TableHead>
                        <TableHead className="hidden sm:table-cell">Responsable</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sites.data.items.map((s) => {
                        const st = statusOf(s.status);
                        return (
                          <TableRow key={s.id}>
                            <TableCell className="font-medium">{s.name}</TableCell>
                            <TableCell className="hidden whitespace-normal md:table-cell">{s.address ?? '—'}</TableCell>
                            <TableCell className="hidden sm:table-cell">{s.managerName ?? '—'}</TableCell>
                            <TableCell>
                              <StatusBadge label={ARCHIVABLE_STATUS_LABELS[st]} tone={st === 'ACTIF' ? 'success' : 'neutral'} />
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-2">
                                <Button variant="outline" size="sm" onClick={() => setSiteDialog({ mode: 'edit', site: s })} aria-label={`Modifier le site ${s.name}`}>
                                  Modifier
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setStatusChange({ kind: 'site', item: s, next: st === 'ACTIF' ? 'ARCHIVE' : 'ACTIF' })}
                                  aria-label={`${st === 'ACTIF' ? 'Archiver' : 'Réactiver'} le site ${s.name}`}
                                >
                                  {st === 'ACTIF' ? 'Archiver' : 'Réactiver'}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <PaginationControls page={sites.data.page} pageSize={sites.data.pageSize} total={sites.data.total} onPageChange={(p) => set({ page: p })} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Services</CardTitle>
              <CardDescription>Services (départements) de la société {companyLabel}.</CardDescription>
              <CardAction>
                <Button size="sm" onClick={() => setDepartmentDialog({ mode: 'create' })}>
                  <Plus className="size-4" /> Nouveau service
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {departments.isPending ? (
                <LoadingState label="Chargement des services…" />
              ) : departments.isError ? (
                <ErrorState error={departments.error} retry={() => void departments.refetch()} />
              ) : departments.data.length === 0 ? (
                <EmptyState title="Aucun service" description="Aucun service n’est encore déclaré pour cette société." />
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {departments.data.map((d) => {
                        const st = statusOf(d.status);
                        return (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">{d.name}</TableCell>
                            <TableCell>
                              <StatusBadge label={ARCHIVABLE_STATUS_LABELS[st]} tone={st === 'ACTIF' ? 'success' : 'neutral'} />
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-2">
                                <Button variant="outline" size="sm" onClick={() => setDepartmentDialog({ mode: 'edit', department: d })} aria-label={`Renommer le service ${d.name}`}>
                                  Renommer
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setStatusChange({ kind: 'department', item: d, next: st === 'ACTIF' ? 'ARCHIVE' : 'ACTIF' })}
                                  aria-label={`${st === 'ACTIF' ? 'Archiver' : 'Réactiver'} le service ${d.name}`}
                                >
                                  {st === 'ACTIF' ? 'Archiver' : 'Réactiver'}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <p className="px-3 py-3 text-sm text-muted-foreground">
                    {departments.data.length} service{departments.data.length > 1 ? 's' : ''}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {siteDialog && company ? (
        <SiteDialog
          key={siteDialog.mode === 'edit' ? siteDialog.site.id : 'new'}
          companyId={companyId}
          companyLabel={companyLabel}
          site={siteDialog.mode === 'edit' ? siteDialog.site : undefined}
          onOpenChange={(open) => {
            if (!open) setSiteDialog(null);
          }}
          onSaved={() => {
            setSiteDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['sites'] });
          }}
        />
      ) : null}

      {departmentDialog && company ? (
        <DepartmentDialog
          key={departmentDialog.mode === 'edit' ? departmentDialog.department.id : 'new'}
          companyId={companyId}
          companyLabel={companyLabel}
          department={departmentDialog.mode === 'edit' ? departmentDialog.department : undefined}
          onOpenChange={(open) => {
            if (!open) setDepartmentDialog(null);
          }}
          onSaved={() => {
            setDepartmentDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['departments'] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={statusChange !== null}
        onOpenChange={(open) => {
          if (!open && !changeStatus.isPending) setStatusChange(null);
        }}
        title={
          statusChange
            ? `${statusChange.next === 'ARCHIVE' ? 'Archiver' : 'Réactiver'} ${statusChange.kind === 'site' ? 'le site' : 'le service'} « ${statusChange.item.name} » ?`
            : 'Confirmer'
        }
        description={
          statusChange?.next === 'ARCHIVE' ? (
            <p>Il ne sera plus proposé dans les formulaires. L’historique qui y fait référence est conservé et il pourra être réactivé.</p>
          ) : (
            <p>Il sera de nouveau proposé dans les formulaires de la société.</p>
          )
        }
        confirmLabel={statusChange?.next === 'ARCHIVE' ? 'Archiver' : 'Réactiver'}
        destructive={statusChange?.next === 'ARCHIVE'}
        pending={changeStatus.isPending}
        onConfirm={() => {
          if (statusChange) changeStatus.mutate(statusChange);
        }}
      />
    </div>
  );
}
