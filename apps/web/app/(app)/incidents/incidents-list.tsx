'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { ALL, toneForIncidentStatus, toneForSeverity, useOpsRights } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { IncidentView } from '@/lib/incidents-types';
import { useListParams } from '@/lib/use-list-params';

/** Filtre « non clôturés » (open=true côté API : OUVERT, EN_TRAITEMENT, RESOLU). */
const OPEN = 'NON_CLOTURES';

/** Incidents du périmètre (CDC 7.3, 10.2) : filtres conservés dans l'URL, déclaration et accès au suivi. */
export function IncidentsList() {
  const { companyId, session } = useAppScope();
  const rights = useOpsRights(companyId);
  const { get, set, page } = useListParams();
  const q = get('q');
  const statut = get('statut');
  const type = get('type');
  const gravite = get('gravite');
  const vehicleId = get('vehicule');
  const query = toQuery({
    companyId,
    q,
    status: statut && statut !== OPEN ? statut : undefined,
    open: statut === OPEN ? 'true' : undefined,
    type,
    severity: gravite,
    vehicleId,
    page,
    pageSize: 25,
  });
  const incidents = useQuery({ queryKey: ['incidents', query], queryFn: () => api<Page<IncidentView>>(`/incidents${query}`) });
  const filtered = Boolean(q || statut || type || gravite || vehicleId);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <div>
      <PageHeader
        title="Incidents"
        description="Pannes, dommages, accidents, crevaisons, anomalies de compteur et contraventions : déclaration, traitement, résolution technique puis clôture administrative."
        actions={
          <>
            {rights.staff ? (
              <Button variant="outline" asChild>
                <Link href="/immobilisations">Immobilisations</Link>
              </Button>
            ) : null}
            {rights.operational ? (
              <Button asChild>
                <Link href={vehicleId ? `/incidents/nouveau?vehicule=${encodeURIComponent(vehicleId)}` : '/incidents/nouveau'}>
                  <Plus className="size-4" aria-hidden="true" /> Déclarer un incident
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
            Recherche
          </Label>
          <Input id="filter-q" placeholder="Référence ou description" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-statut" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={statut || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              <SelectItem value={OPEN}>Non clôturés</SelectItem>
              {Object.entries(INCIDENT_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-type" className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select value={type || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les types</SelectItem>
              {Object.entries(INCIDENT_TYPE_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-gravite" className="text-xs text-muted-foreground">
            Gravité
          </Label>
          <Select value={gravite || ALL} onValueChange={(v) => set({ gravite: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-gravite" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les gravités</SelectItem>
              {Object.entries(INCIDENT_SEVERITY_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {rights.staff ? (
          <div className="space-y-1">
            <Label htmlFor="filter-vehicule" className="text-xs text-muted-foreground">
              Véhicule
            </Label>
            <VehicleFilter id="filter-vehicule" vehicleId={vehicleId} onChange={(v) => set({ vehicule: v })} />
          </div>
        ) : null}
      </div>

      {incidents.isPending ? (
        <LoadingState label="Chargement des incidents…" />
      ) : incidents.isError ? (
        <ErrorState error={incidents.error} retry={() => void incidents.refetch()} />
      ) : incidents.data.total === 0 ? (
        <EmptyState
          title="Aucun incident"
          description={filtered ? 'Aucun incident ne correspond aux filtres dans votre périmètre.' : 'Aucun incident n’a été déclaré dans votre périmètre.'}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Date du fait</TableHead>
                <TableHead>Véhicule</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Type</TableHead>
                <TableHead>Gravité</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Conducteur lié</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link href={`/incidents/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                      {i.reference}
                    </Link>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground">{i.description}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(i.occurredAt, session.timezone)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {i.vehicleCode} · {i.vehicleRegistration}
                  </TableCell>
                  {companyId === null ? <TableCell>{companyCode(i.companyId)}</TableCell> : null}
                  <TableCell>{INCIDENT_TYPE_LABELS[i.type] ?? i.type}</TableCell>
                  <TableCell>
                    <StatusBadge label={INCIDENT_SEVERITY_LABELS[i.severity] ?? i.severity} tone={toneForSeverity(i.severity)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge label={INCIDENT_STATUS_LABELS[i.status] ?? i.status} tone={toneForIncidentStatus(i.status)} />
                      {i.openImmobilizationCauseId ? <StatusBadge label="Immobilisé" tone="danger" /> : null}
                    </div>
                  </TableCell>
                  <TableCell>{i.driverName ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={incidents.data.page} pageSize={incidents.data.pageSize} total={incidents.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
