'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import { formatIntervals, formatNotices } from '@/components/maintenance/plan-display';
import { managesAnyIn } from '@/components/maintenance/roles';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { CATALOG_STATUS_LABELS, type CatalogStatus, type MaintenanceTemplateView } from '@/lib/maintenance-types';
import { useListParams } from '@/lib/use-list-params';
import { ConfirmDialog } from '../administration/confirm-dialog';
import { ApplyTemplateDialog } from './apply-template-dialog';
import { TemplateDialog } from './template-dialog';

type DialogState = { mode: 'create' } | { mode: 'edit'; template: MaintenanceTemplateView } | { mode: 'apply'; template: MaintenanceTemplateView } | null;

/** Onglet « Modèles » : modèles de plans copiables vers plusieurs véhicules (6.1, D-198). */
export function TemplatesTab() {
  const { session, companyId } = useAppScope();
  const queryClient = useQueryClient();
  const { get, set } = useListParams();
  const includeArchived = get('modelesArchives') === '1';
  const [dialog, setDialog] = useState<DialogState>(null);
  const [statusChange, setStatusChange] = useState<{ template: MaintenanceTemplateView; next: CatalogStatus } | null>(null);
  const templates = useQuery({
    queryKey: ['maintenance-templates', includeArchived ? 'tous' : 'actifs'],
    queryFn: () => api<MaintenanceTemplateView[]>(`/maintenance-templates${toQuery({ includeArchived: includeArchived ? 'true' : undefined })}`),
  });
  const isAdmin = session.isAdmin;
  const canApply = managesAnyIn(session, companyId);

  const changeStatus = useMutation({
    mutationFn: (change: { template: MaintenanceTemplateView; next: CatalogStatus }) =>
      api<MaintenanceTemplateView>(`/maintenance-templates/${change.template.id}`, { method: 'PATCH', body: { status: change.next, expectedVersion: change.template.version } }),
    onSuccess: (_data, change) => {
      toast.success(change.next === 'ARCHIVE' ? 'Modèle archivé.' : 'Modèle réactivé.');
      setStatusChange(null);
      void queryClient.invalidateQueries({ queryKey: ['maintenance-templates'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Mise à jour impossible.');
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['maintenance-templates'] });
        setStatusChange(null);
      }
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <Alert className="max-w-3xl">
          <Info aria-hidden="true" />
          <AlertDescription>
            <p>La copie ne modifie pas les historiques : chaque véhicule reçoit un instantané du modèle ; modifier le modèle ensuite ne change pas les plans déjà copiés.</p>
            <p>Aucun intervalle universel n’est imposé : les intervalles sont ceux retenus pour vos véhicules.</p>
          </AlertDescription>
        </Alert>
        {isAdmin ? (
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <Plus className="size-4" aria-hidden="true" /> Nouveau modèle
          </Button>
        ) : null}
      </div>
      <div className="flex w-fit items-center gap-3 rounded-md border px-3 py-2">
        <Switch id="modeles-archives" checked={includeArchived} onCheckedChange={(checked) => set({ modelesArchives: checked ? '1' : '' })} />
        <Label htmlFor="modeles-archives" className="font-normal">
          Afficher les modèles archivés
        </Label>
      </div>

      {templates.isPending ? (
        <LoadingState />
      ) : templates.isError ? (
        <ErrorState error={templates.error} retry={() => void templates.refetch()} />
      ) : templates.data.length === 0 ? (
        <EmptyState
          title="Aucun modèle"
          description={isAdmin ? 'Créez un modèle pour copier un ensemble d’opérations vers plusieurs véhicules.' : 'L’administrateur n’a encore créé aucun modèle.'}
          action={
            isAdmin ? (
              <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
                <Plus className="size-4" aria-hidden="true" /> Nouveau modèle
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {templates.data.map((t) => (
            <Card key={t.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{t.name}</CardTitle>
                    {t.description ? <CardDescription>{t.description}</CardDescription> : null}
                  </div>
                  <StatusBadge label={CATALOG_STATUS_LABELS[t.status] ?? t.status} tone={t.status === 'ACTIF' ? 'success' : 'neutral'} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Opération</TableHead>
                        <TableHead>Intervalles</TableHead>
                        <TableHead>Préavis</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {t.items.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell className="whitespace-normal font-medium">
                            {i.maintenanceTypeLabel}
                            {i.maintenanceTypeStatus === 'ARCHIVE' ? <span className="block text-xs font-normal text-muted-foreground">Opération archivée : non copiée</span> : null}
                          </TableCell>
                          <TableCell className="whitespace-normal">{formatIntervals(i)}</TableCell>
                          <TableCell className="whitespace-normal">{formatNotices(i) === '—' ? 'Par défaut' : formatNotices(i)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canApply && t.status === 'ACTIF' ? (
                    <Button size="sm" onClick={() => setDialog({ mode: 'apply', template: t })}>
                      Appliquer à des véhicules
                    </Button>
                  ) : null}
                  {isAdmin ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'edit', template: t })} aria-label={`Modifier le modèle ${t.name}`}>
                        Modifier
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setStatusChange({ template: t, next: t.status === 'ACTIF' ? 'ARCHIVE' : 'ACTIF' })}
                        aria-label={`${t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'} le modèle ${t.name}`}
                      >
                        {t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'}
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialog?.mode === 'create' || dialog?.mode === 'edit' ? (
        <TemplateDialog
          key={dialog.mode === 'edit' ? dialog.template.id : 'new'}
          template={dialog.mode === 'edit' ? dialog.template : undefined}
          onOpenChange={(open) => !open && setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['maintenance-templates'] });
            void queryClient.invalidateQueries({ queryKey: ['maintenance-template'] });
          }}
        />
      ) : null}
      {dialog?.mode === 'apply' ? <ApplyTemplateDialog template={dialog.template} onOpenChange={(open) => !open && setDialog(null)} /> : null}

      <ConfirmDialog
        open={statusChange !== null}
        onOpenChange={(open) => {
          if (!open && !changeStatus.isPending) setStatusChange(null);
        }}
        title={statusChange ? `${statusChange.next === 'ARCHIVE' ? 'Archiver' : 'Réactiver'} le modèle « ${statusChange.template.name} » ?` : 'Confirmer'}
        description={
          statusChange?.next === 'ARCHIVE' ? (
            <p>Le modèle ne pourra plus être appliqué. Les plans déjà copiés restent inchangés.</p>
          ) : (
            <p>Le modèle pourra de nouveau être appliqué à des véhicules.</p>
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
