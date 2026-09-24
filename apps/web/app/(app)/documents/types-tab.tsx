'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useDocumentTypes } from '@/components/documents/document-dialogs';
import { DOCUMENT_TYPES_KEY, DOCUMENTS_KEY } from '@/components/documents/document-helpers';
import { InitialCatalogButton } from '@/components/initial-catalog-button';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { DOCUMENT_OWNER_TYPE_LABELS, DOCUMENT_TYPE_STATUS_LABELS, type DocumentTypeView } from '@/lib/documents-types';
import { useListParams } from '@/lib/use-list-params';
import type { VehicleCategory } from '@/lib/vehicles-types';
import { DocumentTypeDialog } from './document-type-dialog';

function yesNo(value: boolean): string {
  return value ? 'Oui' : 'Non';
}

/** Onglet « Types » (GET /document-types) : consultation ; création, modification et archivage par l'administrateur. */
export function TypesTab() {
  const { session } = useAppScope();
  const { get, set } = useListParams();
  const includeArchived = get('typesArchives') === '1';
  const types = useDocumentTypes(includeArchived);
  const categories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories') });
  const [editing, setEditing] = useState<DocumentTypeView | 'new' | null>(null);
  const [statusChange, setStatusChange] = useState<DocumentTypeView | null>(null);
  const isAdmin = session.isAdmin;

  const categoryLabel = (id: string) => (categories.isPending ? 'chargement…' : (categories.data?.find((c) => c.id === id)?.label ?? 'Catégorie inconnue'));
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? 'Société inconnue';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Chaque type précise son objet, s’il a une date de fin, s’il est requis (absence = « Manquant ») et s’il bloque un départ. Aucun calendrier réglementaire n’est calculé : seules les dates saisies
          comptent. {isAdmin ? '' : 'Le paramétrage est réservé à l’administrateur groupe.'}
        </p>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <InstallDocumentCatalog />
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" /> Nouveau type
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex w-fit items-center gap-3 rounded-md border px-3 py-2">
        <Switch id="types-archives" checked={includeArchived} onCheckedChange={(checked) => set({ typesArchives: checked ? '1' : '' })} />
        <Label htmlFor="types-archives" className="font-normal">
          Inclure les types archivés
        </Label>
      </div>

      {types.isPending ? (
        <LoadingState />
      ) : types.isError ? (
        <ErrorState error={types.error} retry={() => void types.refetch()} />
      ) : types.data.length === 0 ? (
        <EmptyState
          title="Aucun type de document"
          description={isAdmin ? 'Installez les types usuels (assurance, visite technique, vignette, carte grise…) ou créez vos propres types pour suivre la conformité.' : 'L’administrateur n’a encore paramétré aucun type de document.'}
          action={
            isAdmin ? (
              <div className="flex flex-wrap justify-center gap-2">
                <InstallDocumentCatalog size="sm" />
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus className="size-4" aria-hidden="true" /> Nouveau type
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
                <TableHead>Objet</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead>Requis</TableHead>
                <TableHead>Bloque un départ</TableHead>
                <TableHead>Préavis</TableHead>
                <TableHead>Visible conducteur</TableHead>
                <TableHead>Portée</TableHead>
                <TableHead>Statut</TableHead>
                {isAdmin ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.code}</TableCell>
                  <TableCell className="font-medium">{t.label}</TableCell>
                  <TableCell>{DOCUMENT_OWNER_TYPE_LABELS[t.ownerType]}</TableCell>
                  <TableCell>{t.hasExpiry ? 'Avec date de fin' : 'Sans expiration'}</TableCell>
                  <TableCell>{yesNo(t.required)}</TableCell>
                  <TableCell>{t.blocksCheckout ? <StatusBadge label="Bloquant" tone="danger" /> : 'Non'}</TableCell>
                  <TableCell>{t.hasExpiry ? (t.noticeDays.length > 0 ? `${t.noticeDays.join(', ')} j` : 'Aucun') : '—'}</TableCell>
                  <TableCell>{yesNo(t.visibleToDriver)}</TableCell>
                  <TableCell className="max-w-56 whitespace-normal text-xs">
                    {t.vehicleCategoryIds.length === 0 && t.companyIds.length === 0 ? (
                      'Toutes'
                    ) : (
                      <>
                        {t.vehicleCategoryIds.length > 0 ? <span className="block">Catégories : {t.vehicleCategoryIds.map(categoryLabel).join(', ')}</span> : null}
                        {t.companyIds.length > 0 ? <span className="block">Sociétés : {t.companyIds.map(companyCode).join(', ')}</span> : null}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={DOCUMENT_TYPE_STATUS_LABELS[t.status]} tone={t.status === 'ACTIF' ? 'success' : 'neutral'} />
                  </TableCell>
                  {isAdmin ? (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {t.status === 'ACTIF' ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(t)} aria-label={`Modifier le type ${t.label}`}>
                            Modifier
                          </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" onClick={() => setStatusChange(t)} aria-label={`${t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'} le type ${t.label}`}>
                          {t.status === 'ACTIF' ? 'Archiver' : 'Réactiver'}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editing ? (
        <DocumentTypeDialog
          type={editing === 'new' ? undefined : editing}
          categories={categories.data ?? []}
          categoriesPending={categories.isPending}
          categoriesError={categories.isError ? categories.error : null}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {statusChange ? <TypeStatusDialog type={statusChange} onClose={() => setStatusChange(null)} /> : null}
    </div>
  );
}

/** Archivage ou réactivation d'un type (PATCH /document-types/:id { status, expectedVersion }), confirmé. */
function TypeStatusDialog({ type, onClose }: { type: DocumentTypeView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const archiving = type.status === 'ACTIF';
  const change = useMutation({
    mutationFn: () => api<DocumentTypeView>(`/document-types/${type.id}`, { method: 'PATCH', body: { status: archiving ? 'ARCHIVE' : 'ACTIF', expectedVersion: type.version } }),
    onSuccess: () => {
      toast.success(archiving ? `Type « ${type.label} » archivé.` : `Type « ${type.label} » réactivé.`);
      void queryClient.invalidateQueries({ queryKey: [DOCUMENT_TYPES_KEY] });
      void queryClient.invalidateQueries({ queryKey: [DOCUMENTS_KEY] });
      onClose();
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Modification impossible.');
      if (isApiError(error) && error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        void queryClient.invalidateQueries({ queryKey: [DOCUMENT_TYPES_KEY] });
        onClose();
      }
    },
  });
  return (
    <AlertDialog open onOpenChange={(open) => !open && !change.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archiving ? `Archiver le type « ${type.label} » ?` : `Réactiver le type « ${type.label} » ?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {archiving
              ? 'Le type ne produira plus de ligne de conformité, d’alerte ni de blocage, et ses documents ne pourront plus être enregistrés, renouvelés ni corrigés. Les versions existantes sont conservées.'
              : 'Le type redevient disponible : la conformité et les alertes des objets concernés sont recalculées.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {change.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {isApiError(change.error) ? change.error.message : 'Modification impossible.'}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={change.isPending}>Annuler</AlertDialogCancel>
          <Button type="button" variant={archiving ? 'destructive' : 'default'} disabled={change.isPending} onClick={() => change.mutate()}>
            {change.isPending ? 'Traitement…' : archiving ? 'Archiver le type' : 'Réactiver le type'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Types de documents usuels (CDC 7.1) installés à la demande de l'administrateur (types absents seulement). */
function InstallDocumentCatalog({ size = 'default' }: { size?: 'default' | 'sm' }) {
  return (
    <InitialCatalogButton
      endpoint="/document-types/initial-catalog"
      title="Installer les types de documents usuels ?"
      description={
        <>
          <p>
            Véhicule : assurance, visite technique, vignette / taxe, carte grise, licence de transport, autorisation, contrat de location, document libre. Conducteur : licence / carte professionnelle,
            autorisation de conduite, document libre. Le permis de conduire se gère sur la fiche du conducteur.
          </p>
          <p>Les types ajoutés sont facultatifs et non bloquants : à vous de décider ensuite ce qui est requis ou bloque un départ. Un type déjà présent (même code, ou même libellé pour le même objet) n’est pas modifié.</p>
        </>
      }
      noun={{ singular: 'type', plural: 'types', feminine: false }}
      invalidate={[DOCUMENT_TYPES_KEY, DOCUMENTS_KEY]}
      size={size}
    />
  );
}
