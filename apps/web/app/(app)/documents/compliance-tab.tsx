'use client';

import { useQuery } from '@tanstack/react-query';
import { DOCUMENT_STATUS, DOCUMENT_STATUS_LABELS } from '@parc-auto/contracts';
import { useDocumentTypes, type DocumentAction } from '@/components/documents/document-dialogs';
import { DOCUMENTS_KEY } from '@/components/documents/document-helpers';
import { ComplianceTable } from '@/components/documents/document-tables';
import { DriverIdFilter, VehicleIdFilter } from '@/components/documents/owner-pickers';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { DOCUMENT_OWNER_TYPE_LABELS, type ComplianceRow, type DocumentOwnerType } from '@/lib/documents-types';
import { useListParams } from '@/lib/use-list-params';

const ALL = '__all__';
const OWNER_TYPES = Object.keys(DOCUMENT_OWNER_TYPE_LABELS) as DocumentOwnerType[];

/** Onglet « Conformité » : une ligne par objet et type applicable (GET /documents/compliance), filtres dans l'URL. */
export function ComplianceTab({ onAction, onView }: { onAction: (action: DocumentAction) => void; onView: (versionId: string) => void }) {
  const { companyId } = useAppScope();
  const { get, set, page } = useListParams();
  const rawOwner = get('proprietaire');
  const ownerType = (OWNER_TYPES as string[]).includes(rawOwner) ? (rawOwner as DocumentOwnerType) : '';
  const rawStatus = get('statut');
  const status = (DOCUMENT_STATUS as readonly string[]).includes(rawStatus) ? rawStatus : '';
  const blocking = get('bloquant') === '1';
  const vehicleId = ownerType === 'CONDUCTEUR' ? '' : get('vehicule');
  const driverId = ownerType === 'VEHICULE' ? '' : get('conducteur');
  const documentTypeId = get('type');
  const types = useDocumentTypes();

  const query = toQuery({ companyId, ownerType, status, blocking: blocking ? 'true' : undefined, vehicleId, driverId, documentTypeId, page, pageSize: 25 });
  const rows = useQuery({ queryKey: [DOCUMENTS_KEY, 'compliance', query], queryFn: () => api<Page<ComplianceRow>>(`/documents/compliance${query}`) });
  const filtered = Boolean(ownerType || status || blocking || vehicleId || driverId || documentTypeId);

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Une ligne par véhicule ou conducteur et par type de document applicable. Une date de fin reste valable jusqu’à la fin de ce jour ; une version future ne remplace pas une version encore valide. Les
        documents bloquants manquants ou expirés empêchent un nouveau départ (sauf dérogation motivée), jamais une restitution.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="conformite-proprietaire">Objet</Label>
          <Select value={ownerType || ALL} onValueChange={(v) => set({ proprietaire: v === ALL ? '' : v, type: '' })}>
            <SelectTrigger id="conformite-proprietaire" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Véhicules et conducteurs</SelectItem>
              {OWNER_TYPES.map((o) => (
                <SelectItem key={o} value={o}>
                  {o === 'VEHICULE' ? 'Véhicules' : 'Conducteurs'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conformite-statut">Statut</Label>
          <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="conformite-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {DOCUMENT_STATUS.map((s) => (
                <SelectItem key={s} value={s}>
                  {DOCUMENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conformite-type">Type de document</Label>
          <Select value={documentTypeId || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
            <SelectTrigger id="conformite-type" className="w-full">
              <SelectValue placeholder={types.isPending ? 'Chargement…' : undefined} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les types</SelectItem>
              {(types.data ?? [])
                .filter((t) => !ownerType || t.ownerType === ownerType)
                .map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        {ownerType !== 'CONDUCTEUR' ? (
          <div className="space-y-1.5">
            <Label htmlFor="conformite-vehicule">Véhicule</Label>
            <VehicleIdFilter id="conformite-vehicule" vehicleId={vehicleId} companyId={companyId} onChange={(id) => set(id ? { vehicule: id, conducteur: '' } : { vehicule: '' })} />
          </div>
        ) : null}
        {ownerType !== 'VEHICULE' ? (
          <div className="space-y-1.5">
            <Label htmlFor="conformite-conducteur">Conducteur</Label>
            <DriverIdFilter id="conformite-conducteur" driverId={driverId} companyId={companyId} onChange={(id) => set(id ? { conducteur: id, vehicule: '' } : { conducteur: '' })} />
          </div>
        ) : null}
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 lg:mt-6">
          <Switch id="conformite-bloquant" checked={blocking} onCheckedChange={(checked) => set({ bloquant: checked ? '1' : '' })} />
          <Label htmlFor="conformite-bloquant" className="font-normal">
            Bloquant un départ uniquement
          </Label>
        </div>
      </div>

      {rows.isPending ? (
        <LoadingState label="Calcul de la conformité…" />
      ) : rows.isError ? (
        <ErrorState error={rows.error} retry={() => void rows.refetch()} />
      ) : rows.data.total === 0 ? (
        <EmptyState
          title="Aucune ligne de conformité"
          description={filtered ? 'Aucun document ne correspond aux filtres dans votre périmètre.' : 'Aucun type de document n’est requis ni enregistré pour les véhicules et conducteurs actifs de votre périmètre.'}
        />
      ) : (
        <div className="rounded-md border">
          <ComplianceTable rows={rows.data.items} showObject showCompany={companyId === null} onAction={onAction} onView={onView} />
          <PaginationControls page={rows.data.page} pageSize={rows.data.pageSize} total={rows.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
