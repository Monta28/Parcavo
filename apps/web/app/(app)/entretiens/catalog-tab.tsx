'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { InitialCatalogButton } from '@/components/initial-catalog-button';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { CATALOG_STATUS_LABELS, type CatalogStatus, type MaintenanceTypeView } from '@/lib/maintenance-types';
import { useListParams } from '@/lib/use-list-params';
import { ConfirmDialog } from '../administration/confirm-dialog';
import { MaintenanceTypeDialog } from './maintenance-type-dialog';

type DialogState = { mode: 'create' } | { mode: 'edit'; type: MaintenanceTypeView } | null;

/** Onglet « Catalogue » : opérations d'entretien de l'organisation (6.1) ; modification réservée à l'administrateur. */
export function CatalogTab() {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const { get, set } = useListParams();
  const includeArchived = get('operationsArchivees') === '1';
  const [dialog, setDialog] = useState<DialogState>(null);
  const [statusChange, setStatusChange] = useState<{ type: MaintenanceTypeView; next: CatalogStatus } | null>(null);
  const types = useQuery({
    queryKey: ['maintenance-types', includeArchived ? 'tous' : 'actifs'],
    queryFn: () => api<MaintenanceTypeView[]>(`/maintenance-types${toQuery({ includeArchived: includeArchived ? 'true' : undefined })}`),
  });
  const isAdmin = session.isAdmin;

  const changeStatus = useMutation({
    mutationFn: (change: { type: MaintenanceTypeView; next: CatalogStatus }) =>
      api<MaintenanceTypeView>(`/maintenance-types/${change.type.id}`, { method: 'PATCH', body: { status: change.next, expectedVersion: change.type.version } }),
    onSuccess: (_data, change) => {
      toast.success(change.next === 'ARCHIVE' ? 'Opération archivée.' : 'Opération réactivée.');
      setStatusChange(null);
      void queryClient.invalidateQueries({ queryKey: ['maintenance-types'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Mise à jour impossible.');
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['maintenance-types'] });
        setStatusChange(null);
      }
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Catalogue commun au groupe (vidange, filtres, freins, pneus, courroie, batterie…). {isAdmin ? 'Les opérations archivées ne sont plus proposées pour les nouveaux plans.' : 'Sa modification est réservée à l’administrateur.'}
        </p>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <InstallMaintenanceCatalog />
            <Button onClick={() => setDialog({ mode: 'create' })}>
              <Plus className="size-4" aria-hidden="true" /> Nouvelle opération
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex w-fit items-center gap-3 rounded-md border px-3 py-2">
        <Switch id="catalogue-archives" checked={includeArchived} onCheckedChange={(checked) => set({ operationsArchivees: checked ? '1' : '' })} />
        <Label htmlFor="catalogue-archives" className="font-normal">
          Afficher les opérations archivées
        </Label>
      </div>

      {types.isPending ? (
        <LoadingState />
      ) : types.isError ? (
        <ErrorState error={types.error} retry={() => void types.refetch()} />
      ) : types.data.length === 0 ? (
        <EmptyState
          title="Catalogue vide"
          description={isAdmin ? 'Installez le catalogue initial (vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne, autres) ou ajoutez vos propres opérations.' : 'L’administrateur n’a encore ajouté aucune opération.'}
          action={
            isAdmin ? (
              <div className="flex flex-wrap justify-center gap-2">
                <InstallMaintenanceCatalog size="sm" />
                <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
                  <Plus className="size-4" aria-hidden="true" /> Nouvelle opération
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Libellé</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Statut</TableHead>
                {isAdmin ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.code}</TableCell>
                  <TableCell className="whitespace-normal">{t.label}</TableCell>
                  <TableCell className="max-w-md whitespace-normal text-muted-foreground">{t.description ?? '—'}</TableCell>
                  <TableCell>
                    <StatusBadge label={CATALOG_STATUS_LABELS[t.status] ?? t.status} tone={t.status === 'ACTIF' ? 'success' : 'neutral'} />
                  </TableCell>
                  {isAdmin ? (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'edit', type: t })} aria-label={`Modifier l’opération ${t.code}`}>
                          Modifier
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setStatusChange({ type: t, next: t.status === 'ACTIF' ? 'ARCHIVE' : 'ACTIF' })}
                          aria-label={`${t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'} l’opération ${t.code}`}
                        >
                          {t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {types.data.length} opération{types.data.length > 1 ? 's' : ''}
          </p>
        </div>
      )}

      {dialog ? (
        <MaintenanceTypeDialog
          key={dialog.mode === 'edit' ? dialog.type.id : 'new'}
          type={dialog.mode === 'edit' ? dialog.type : undefined}
          onOpenChange={(open) => !open && setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['maintenance-types'] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={statusChange !== null}
        onOpenChange={(open) => {
          if (!open && !changeStatus.isPending) setStatusChange(null);
        }}
        title={statusChange ? `${statusChange.next === 'ARCHIVE' ? 'Archiver' : 'Réactiver'} l’opération ${statusChange.type.code} ?` : 'Confirmer'}
        description={
          statusChange?.next === 'ARCHIVE' ? (
            <p>« {statusChange.type.label} » ne sera plus proposée pour les nouveaux plans et modèles. Les plans existants et l’historique ne sont pas modifiés.</p>
          ) : (
            <p>L’opération sera de nouveau proposée pour les plans et les modèles.</p>
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

/** Catalogue initial du CDC 6.1, installé à la demande de l'administrateur (opérations absentes seulement). */
function InstallMaintenanceCatalog({ size = 'default' }: { size?: 'default' | 'sm' }) {
  return (
    <InitialCatalogButton
      endpoint="/maintenance-types/initial-catalog"
      title="Installer le catalogue initial des opérations ?"
      description={
        <>
          <p>Ajoute les opérations usuelles absentes : vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne et autre opération.</p>
          <p>Une opération déjà présente (même code ou même libellé, active ou archivée) n’est ni modifiée ni réactivée. Aucun intervalle n’est imposé : les intervalles se fixent plan par plan selon vos consignes.</p>
        </>
      }
      noun={{ singular: 'opération', plural: 'opérations', feminine: true }}
      invalidate={['maintenance-types']}
      size={size}
    />
  );
}
