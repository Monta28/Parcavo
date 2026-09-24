'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useDocumentTypes, type DocumentAction } from '@/components/documents/document-dialogs';
import { DOCUMENTS_KEY } from '@/components/documents/document-helpers';
import { VersionsTable } from '@/components/documents/document-tables';
import { DriverIdFilter, VehicleIdFilter } from '@/components/documents/owner-pickers';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DocumentView } from '@/lib/documents-types';
import type { DriverUsageView } from '@/lib/drivers-types';
import { useListParams } from '@/lib/use-list-params';

const ALL = '__all__';

/**
 * Onglet « Versions » (GET /documents) : toutes les versions du périmètre avec téléchargement du justificatif.
 * driverMode : compte uniquement conducteur, périmètre restreint par l'API et aucun filtre de gestion.
 */
export function VersionsTab({ onAction, onView, driverMode = false }: { onAction: (action: DocumentAction) => void; onView: (versionId: string) => void; driverMode?: boolean }) {
  if (driverMode) return <DriverVersions onAction={onAction} onView={onView} />;
  return <StaffVersions onAction={onAction} onView={onView} />;
}

function StaffVersions({ onAction, onView }: { onAction: (action: DocumentAction) => void; onView: (versionId: string) => void }) {
  const { companyId } = useAppScope();
  const { get, set, page } = useListParams();
  const vehicleId = get('vehicule');
  const driverId = vehicleId ? '' : get('conducteur');
  const documentTypeId = get('type');
  const includeArchived = get('archives') === '1';
  const types = useDocumentTypes(true);

  const query = toQuery({ companyId, vehicleId, driverId, documentTypeId, includeArchived: includeArchived ? 'true' : undefined, page, pageSize: 25 });
  const versions = useQuery({ queryKey: [DOCUMENTS_KEY, 'list', query], queryFn: () => api<Page<DocumentView>>(`/documents${query}`) });
  const filtered = Boolean(vehicleId || driverId || documentTypeId);

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Historique des versions : un renouvellement crée une nouvelle version, une faute de saisie se corrige en place (tracée) et une version erronée est archivée, jamais supprimée.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="versions-vehicule">Véhicule</Label>
          <VehicleIdFilter id="versions-vehicule" vehicleId={vehicleId} companyId={companyId} onChange={(id) => set(id ? { vehicule: id, conducteur: '' } : { vehicule: '' })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="versions-conducteur">Conducteur</Label>
          <DriverIdFilter id="versions-conducteur" driverId={driverId} companyId={companyId} onChange={(id) => set(id ? { conducteur: id, vehicule: '' } : { conducteur: '' })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="versions-type">Type de document</Label>
          <Select value={documentTypeId || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
            <SelectTrigger id="versions-type" className="w-full">
              <SelectValue placeholder={types.isPending ? 'Chargement…' : undefined} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les types</SelectItem>
              {(types.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                  {t.status === 'ARCHIVE' ? ' (type archivé)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 lg:mt-6">
          <Switch id="versions-archives" checked={includeArchived} onCheckedChange={(checked) => set({ archives: checked ? '1' : '' })} />
          <Label htmlFor="versions-archives" className="font-normal">
            Inclure les versions archivées
          </Label>
        </div>
      </div>

      {versions.isPending ? (
        <LoadingState />
      ) : versions.isError ? (
        <ErrorState error={versions.error} retry={() => void versions.refetch()} />
      ) : versions.data.total === 0 ? (
        <EmptyState title="Aucune version de document" description={filtered ? 'Aucune version ne correspond aux filtres dans votre périmètre.' : 'Aucun document n’a encore été enregistré dans votre périmètre.'} />
      ) : (
        <div className="rounded-md border">
          <VersionsTable items={versions.data.items} showObject showCompany={companyId === null} onAction={onAction} onView={onView} />
          <PaginationControls page={versions.data.page} pageSize={versions.data.pageSize} total={versions.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}

/** Section de versions à pagination locale (espace conducteur). */
function VersionsSection({ title, description, path, emptyTitle, emptyDescription, onAction, onView }: { title: string; description: string; path: string; emptyTitle: string; emptyDescription: string; onAction: (action: DocumentAction) => void; onView: (versionId: string) => void }) {
  const [page, setPage] = useState(1);
  const separator = path.includes('?') ? '&' : '?';
  const url = `${path}${separator}${toQuery({ page, pageSize: 25 }).slice(1)}`;
  const versions = useQuery({ queryKey: [DOCUMENTS_KEY, 'list', 'conducteur', url], queryFn: () => api<Page<DocumentView>>(url) });
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {versions.isPending ? (
        <LoadingState />
      ) : versions.isError ? (
        <ErrorState error={versions.error} retry={() => void versions.refetch()} />
      ) : versions.data.total === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="rounded-md border">
          <VersionsTable items={versions.data.items} showObject={false} showCompany={false} onAction={onAction} onView={onView} />
          <PaginationControls page={versions.data.page} pageSize={versions.data.pageSize} total={versions.data.total} onPageChange={setPage} />
        </div>
      )}
    </section>
  );
}

/** Compte uniquement conducteur : ses documents, puis ceux du véhicule de son utilisation en cours (D-209). */
function DriverVersions({ onAction, onView }: { onAction: (action: DocumentAction) => void; onView: (versionId: string) => void }) {
  const current = useQuery({ queryKey: ['usages', 'mine', 'EN_COURS'], queryFn: () => api<Page<DriverUsageView>>(`/usages${toQuery({ status: 'EN_COURS', pageSize: 1 })}`) });
  const usage = current.data?.items[0] ?? null;
  return (
    <div className="space-y-8">
      <VersionsSection
        title="Mes documents"
        description="Documents enregistrés à votre nom (permis, habilitations…)."
        path="/documents"
        emptyTitle="Aucun document personnel"
        emptyDescription="Aucun document n’est enregistré à votre nom."
        onAction={onAction}
        onView={onView}
      />
      {current.isPending ? (
        <LoadingState label="Recherche de votre utilisation en cours…" />
      ) : current.isError ? (
        <ErrorState error={current.error} retry={() => void current.refetch()} />
      ) : usage ? (
        <VersionsSection
          title={`Véhicule en cours : ${usage.vehicleCode} · ${usage.vehicleRegistration}`}
          description="Documents du véhicule que le parc a rendus consultables pendant votre utilisation."
          path={`/documents${toQuery({ vehicleId: usage.vehicleId })}`}
          emptyTitle="Aucun document consultable pour ce véhicule"
          emptyDescription="Le parc n’a rendu aucun document de ce véhicule consultable par le conducteur."
          onAction={onAction}
          onView={onView}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Aucune utilisation en cours : les documents d’un véhicule ne sont consultables que pendant son utilisation.</p>
      )}
    </div>
  );
}
