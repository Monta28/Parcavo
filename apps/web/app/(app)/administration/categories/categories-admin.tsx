'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ArchivableStatus, VehicleCategory } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { ConfirmDialog } from '../confirm-dialog';
import { ARCHIVABLE_STATUS_LABELS } from '../labels';
import { CategoryDialog } from './category-dialog';

type DialogState = { mode: 'create' } | { mode: 'edit'; category: VehicleCategory } | null;

function statusOf(value: string): ArchivableStatus {
  return value === 'ARCHIVE' ? 'ARCHIVE' : 'ACTIF';
}

/** Catégories de véhicules de l'organisation (CDC 2.1, 3.3) et permis exigés. */
export function CategoriesAdmin() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [statusChange, setStatusChange] = useState<{ category: VehicleCategory; next: ArchivableStatus } | null>(null);
  const categories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories') });

  const changeStatus = useMutation({
    mutationFn: (change: { category: VehicleCategory; next: ArchivableStatus }) =>
      api<VehicleCategory>(`/vehicle-categories/${change.category.id}`, { method: 'PATCH', body: { status: change.next, expectedVersion: change.category.version } }),
    onSuccess: (_data, change) => {
      toast.success(change.next === 'ARCHIVE' ? 'Catégorie archivée.' : 'Catégorie réactivée.');
      setStatusChange(null);
      void queryClient.invalidateQueries({ queryKey: ['vehicle-categories'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Mise à jour impossible.');
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['vehicle-categories'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Catégories de véhicules"
        description="Catégories communes à toutes les sociétés du groupe et catégories de permis exigées pour les conduire."
        actions={
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <Plus className="size-4" /> Nouvelle catégorie
          </Button>
        }
      />

      {categories.isPending ? (
        <LoadingState />
      ) : categories.isError ? (
        <ErrorState error={categories.error} retry={() => void categories.refetch()} />
      ) : categories.data.length === 0 ? (
        <EmptyState
          title="Aucune catégorie"
          description="Créez les catégories de véhicules utilisées par le parc."
          action={
            <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
              <Plus className="size-4" /> Nouvelle catégorie
            </Button>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Libellé</TableHead>
                <TableHead>Permis exigés</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.data.map((c) => {
                const st = statusOf(c.status);
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.code}</TableCell>
                    <TableCell className="whitespace-normal">{c.label}</TableCell>
                    <TableCell>
                      {c.requiredPermitCategories.length === 0 ? (
                        <span className="text-muted-foreground">Aucun</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1">
                          {c.requiredPermitCategories.map((p) => (
                            <li key={p} className="rounded border bg-muted px-2 py-0.5 text-xs font-medium">
                              {p}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={ARCHIVABLE_STATUS_LABELS[st]} tone={st === 'ACTIF' ? 'success' : 'neutral'} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'edit', category: c })} aria-label={`Modifier la catégorie ${c.code}`}>
                          Modifier
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setStatusChange({ category: c, next: st === 'ACTIF' ? 'ARCHIVE' : 'ACTIF' })}
                          aria-label={`${st === 'ACTIF' ? 'Archiver' : 'Réactiver'} la catégorie ${c.code}`}
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
            {categories.data.length} catégorie{categories.data.length > 1 ? 's' : ''}
          </p>
        </div>
      )}

      {dialog ? (
        <CategoryDialog
          key={dialog.mode === 'edit' ? dialog.category.id : 'new'}
          category={dialog.mode === 'edit' ? dialog.category : undefined}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSaved={() => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['vehicle-categories'] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={statusChange !== null}
        onOpenChange={(open) => {
          if (!open && !changeStatus.isPending) setStatusChange(null);
        }}
        title={statusChange ? `${statusChange.next === 'ARCHIVE' ? 'Archiver' : 'Réactiver'} la catégorie ${statusChange.category.code} ?` : 'Confirmer'}
        description={
          statusChange?.next === 'ARCHIVE' ? (
            <p>La catégorie « {statusChange.category.label} » ne sera plus proposée pour les nouveaux véhicules. Les véhicules déjà classés la conservent.</p>
          ) : (
            <p>La catégorie sera de nouveau proposée à la création et à la modification des véhicules.</p>
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
