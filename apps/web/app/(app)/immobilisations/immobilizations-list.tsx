'use client';

import { useQuery } from '@tanstack/react-query';
import { Info, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ALL, formatDays, formatHours, toneForImmobilization, useOpsRights } from '@/components/incidents/ops-helpers';
import { placeLabel } from '@/components/incidents/place-fields';
import { useAppScope } from '@/components/layout/session-context';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { IMMOBILIZATION_CAUSE_KIND_LABELS, IMMOBILIZATION_STATUS_LABELS, type ImmobilizationStatus, type ImmobilizationView } from '@/lib/immobilizations-types';
import { useListParams } from '@/lib/use-list-params';
import { ImmobilizeVehicleDialog } from './immobilize-vehicle-dialog';

/** Immobilisations du périmètre (CDC 7.4, 10.2) : actives et terminées, causes, lieu et durée calculée par l'API. */
export function ImmobilizationsList() {
  const { companyId, session } = useAppScope();
  const rights = useOpsRights(companyId);
  const { get, set, page } = useListParams();
  const statut = get('statut');
  const vehicleId = get('vehicule');
  const [createOpen, setCreateOpen] = useState(false);
  const query = toQuery({ companyId, status: statut, vehicleId, page, pageSize: 25 });
  const immobilizations = useQuery({ queryKey: ['immobilizations', query], queryFn: () => api<Page<ImmobilizationView>>(`/immobilizations${query}`) });
  const filtered = Boolean(statut || vehicleId);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <div>
      <PageHeader
        title="Immobilisations"
        description="Véhicules indisponibles : causes (incident, intervention, autre motif), garage ou lieu, fin prévue et remise en disponibilité."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/incidents">Incidents</Link>
            </Button>
            {rights.operational ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden="true" /> Immobiliser un véhicule
              </Button>
            ) : null}
          </>
        }
      />
      <Alert className="mb-4" role="note">
        <Info aria-hidden="true" />
        <AlertDescription>La disponibilité est rétablie seulement après la fin de toutes les causes d’une immobilisation.</AlertDescription>
      </Alert>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="filter-statut" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={statut || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Actives et terminées</SelectItem>
              {(Object.keys(IMMOBILIZATION_STATUS_LABELS) as ImmobilizationStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {IMMOBILIZATION_STATUS_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-vehicule" className="text-xs text-muted-foreground">
            Véhicule
          </Label>
          <VehicleFilter id="filter-vehicule" vehicleId={vehicleId} onChange={(v) => set({ vehicule: v })} />
        </div>
      </div>

      {immobilizations.isPending ? (
        <LoadingState label="Chargement des immobilisations…" />
      ) : immobilizations.isError ? (
        <ErrorState error={immobilizations.error} retry={() => void immobilizations.refetch()} />
      ) : immobilizations.data.total === 0 ? (
        <EmptyState title="Aucune immobilisation" description={filtered ? 'Aucune immobilisation ne correspond aux filtres dans votre périmètre.' : 'Aucun véhicule n’a été immobilisé dans votre périmètre.'} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Véhicule</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Statut</TableHead>
                <TableHead>Causes</TableHead>
                <TableHead>Début</TableHead>
                <TableHead>Fin prévue</TableHead>
                <TableHead>Fin réelle</TableHead>
                <TableHead>Durée</TableHead>
                <TableHead>Lieu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {immobilizations.data.items.map((imm) => {
                const open = imm.causes.filter((c) => !c.endedAt);
                return (
                  <TableRow key={imm.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/immobilisations/${imm.id}`} className="font-medium underline-offset-4 hover:underline">
                        {imm.vehicleCode} · {imm.vehicleRegistration}
                      </Link>
                    </TableCell>
                    {companyId === null ? <TableCell>{companyCode(imm.companyId)}</TableCell> : null}
                    <TableCell>
                      <StatusBadge label={IMMOBILIZATION_STATUS_LABELS[imm.status] ?? imm.status} tone={toneForImmobilization(imm.status)} />
                    </TableCell>
                    <TableCell>
                      <ul className="space-y-0.5 text-sm">
                        {(imm.status === 'ACTIVE' ? open : imm.causes).map((c) => (
                          <li key={c.id}>
                            {IMMOBILIZATION_CAUSE_KIND_LABELS[c.kind] ?? c.kind}
                            {c.incidentReference ? ` ${c.incidentReference}` : c.interventionReference ? ` ${c.interventionReference}` : ''}
                            <span className="block max-w-56 truncate text-xs text-muted-foreground">{c.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(imm.startedAt, session.timezone)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(imm.expectedEndAt, session.timezone)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(imm.endedAt, session.timezone)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatHours(imm.durationHours)}
                      <span className="block text-xs text-muted-foreground">
                        {formatDays(imm.durationDays)}
                        {imm.status === 'ACTIVE' ? ' · en cours' : ''}
                      </span>
                    </TableCell>
                    <TableCell>{placeLabel(imm)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={immobilizations.data.page} pageSize={immobilizations.data.pageSize} total={immobilizations.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
      {createOpen ? <ImmobilizeVehicleDialog initialVehicleId={vehicleId} onOpenChange={(o) => !o && setCreateOpen(false)} /> : null}
    </div>
  );
}
