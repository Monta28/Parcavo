'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PLAN_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PlanBase, PlanCurrentKm, PlanDueDate, PlanDueKm, PlanStatusBadge, PlanWarnings, formatIntervals } from '@/components/maintenance/plan-display';
import { isManagerOf, managesAnyIn } from '@/components/maintenance/roles';
import { SortableHead, type SortOrder } from '@/components/maintenance/sortable-head';
import { MaintenanceVehiclePicker } from '@/components/maintenance/vehicle-picker';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { PLAN_SORTS, type MaintenancePlanView, type PlanSort, type PlanStatus } from '@/lib/maintenance-types';
import { useListParams } from '@/lib/use-list-params';
import { PlanCreateDialog } from './plan-create-dialog';
import { PlanEditDialog } from './plan-edit-dialog';

const ALL = '__all__';
const STATUSES = Object.keys(PLAN_STATUS_LABELS) as PlanStatus[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SORT: PlanSort = 'urgence';

/** Sens par défaut au premier clic : le plus urgent / le plus proche d'abord. */
const FIRST_ORDER: Record<PlanSort, SortOrder> = { urgence: 'desc', resteKm: 'asc', resteJours: 'asc', echeance: 'asc', vehicule: 'asc', operation: 'asc' };

/** Onglet « Échéances » : plans actifs du périmètre, statuts et restes calculés par l'API (6.1, 6.2). */
export function PlansTab() {
  const { companyId, session } = useAppScope();
  const { get, set, page } = useListParams();
  // Tri et recherche persistants dans l'URL ; une valeur inconnue revient au tri par urgence.
  const rawSort = get('tri');
  const sort: PlanSort = (PLAN_SORTS as string[]).includes(rawSort) ? (rawSort as PlanSort) : DEFAULT_SORT;
  const rawOrder = get('ordre');
  const order: SortOrder = rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : FIRST_ORDER[sort];
  const q = get('q').trim().slice(0, 200);
  // Paramètres d'URL modifiables à la main : une valeur inconnue est ignorée plutôt qu'envoyée à l'API.
  const rawStatus = get('statut');
  const status = (STATUSES as string[]).includes(rawStatus) ? rawStatus : '';
  const urgent = get('urgent') === '1';
  const rawVehicleId = get('vehicule');
  const vehicleId = UUID.test(rawVehicleId) ? rawVehicleId : '';
  const includeInactive = get('inactifs') === '1';
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MaintenancePlanView | null>(null);

  const query = toQuery({
    companyId,
    status: urgent ? undefined : status,
    urgent: urgent ? 'true' : undefined,
    vehicleId,
    includeInactive: includeInactive ? 'true' : undefined,
    q: q || undefined,
    sort,
    order,
    page,
    pageSize: 25,
  });
  const onSort = (key: PlanSort, next: SortOrder) => set({ tri: key === DEFAULT_SORT && next === FIRST_ORDER[key] ? '' : key, ordre: next === FIRST_ORDER[key] ? '' : next });
  const head = (label: string, key: PlanSort, descLabel?: string, ascLabel?: string) => (
    <SortableHead label={label} sortKey={key} current={sort} order={order} onSort={onSort} defaultOrder={FIRST_ORDER[key]} descLabel={descLabel} ascLabel={ascLabel} />
  );
  const plans = useQuery({ queryKey: ['maintenance-plans', query], queryFn: () => api<Page<MaintenancePlanView>>(`/maintenance-plans${query}`) });
  const canCreate = managesAnyIn(session, companyId);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Par défaut, les plans les plus urgents d’abord (en retard, à faire, à prévoir, incomplets, à jour). Cliquez sur un en-tête pour trier autrement. Lorsqu’un plan a deux seuils, le premier atteint déclenche l’action ; les données manquantes ou anciennes sont signalées à part.
        </p>
        {canCreate ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" /> Nouveau plan
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5">
          <Label htmlFor="filtre-recherche">Recherche</Label>
          <Input id="filtre-recherche" type="search" placeholder="Code, immatriculation, opération…" defaultValue={get('q')} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filtre-statut">Statut</Label>
          <Select value={urgent ? ALL : status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v, urgent: '' })} disabled={urgent}>
            <SelectTrigger id="filtre-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PLAN_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filtre-vehicule">Véhicule</Label>
          <MaintenanceVehiclePicker id="filtre-vehicule" value={vehicleId} onChange={(v) => set({ vehicule: v?.id ?? '' })} companyId={companyId} placeholder="Tous les véhicules" clearLabel="Retirer le filtre véhicule" />
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 lg:mt-6">
          <Switch id="filtre-urgent" checked={urgent} onCheckedChange={(checked) => set({ urgent: checked ? '1' : '', statut: '' })} />
          <Label htmlFor="filtre-urgent" className="font-normal">
            Urgents uniquement (à faire, en retard)
          </Label>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 lg:mt-6">
          <Switch id="filtre-inactifs" checked={includeInactive} onCheckedChange={(checked) => set({ inactifs: checked ? '1' : '' })} />
          <Label htmlFor="filtre-inactifs" className="font-normal">
            Inclure les plans désactivés
          </Label>
        </div>
      </div>

      {plans.isPending ? (
        <LoadingState />
      ) : plans.isError ? (
        <ErrorState error={plans.error} retry={() => void plans.refetch()} />
      ) : plans.data.total === 0 ? (
        <EmptyState
          title="Aucun plan d’entretien"
          description={status || urgent || vehicleId || q ? 'Aucun plan ne correspond aux filtres dans votre périmètre.' : 'Créez un plan pour un véhicule ou appliquez un modèle (onglet Modèles).'}
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" aria-hidden="true" /> Nouveau plan
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {head('Véhicule', 'vehicule', 'ordre alphabétique inverse', 'ordre alphabétique')}
                {companyId === null ? <TableHead>Société</TableHead> : null}
                {head('Opération', 'operation', 'ordre alphabétique inverse', 'ordre alphabétique')}
                <TableHead>Base (km / date)</TableHead>
                {head('Échéance km', 'resteKm', 'reste le plus grand d’abord', 'reste le plus faible d’abord')}
                {head('Échéance date', 'resteJours', 'reste le plus grand d’abord', 'reste le plus faible d’abord')}
                <TableHead>Km retenu</TableHead>
                {head('Statut', 'urgence', 'le plus urgent d’abord', 'le moins urgent d’abord')}
                <TableHead>Avertissements</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.data.items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link href={`/vehicules/${p.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                      {p.vehicleCode}
                    </Link>
                  </TableCell>
                  {companyId === null ? <TableCell>{companyCode(p.companyId)}</TableCell> : null}
                  <TableCell className="whitespace-normal">
                    <span className="font-medium">{p.maintenanceTypeLabel}</span>
                    <span className="block text-xs text-muted-foreground">{formatIntervals(p)}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <PlanBase plan={p} timezone={session.timezone} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <PlanDueKm plan={p} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <PlanDueDate plan={p} timezone={session.timezone} />
                  </TableCell>
                  <TableCell>
                    <PlanCurrentKm plan={p} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <PlanStatusBadge status={p.status} />
                      {!p.active ? <StatusBadge label="Désactivé" tone="neutral" /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal">
                    <PlanWarnings warnings={p.warnings} compact />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => set({ plan: p.id, page: page > 1 ? page : null })} aria-label={`Détail du plan ${p.maintenanceTypeLabel} du véhicule ${p.vehicleCode}`}>
                        Détail
                      </Button>
                      {p.active && isManagerOf(session, p.companyId) ? (
                        <Button variant="outline" size="sm" onClick={() => setEditing(p)} aria-label={`Modifier le plan ${p.maintenanceTypeLabel} du véhicule ${p.vehicleCode}`}>
                          Modifier
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={plans.data.page} pageSize={plans.data.pageSize} total={plans.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      {creating ? (
        <PlanCreateDialog
          companyId={companyId}
          initialVehicleId={vehicleId || undefined}
          onOpenChange={(open) => !open && setCreating(false)}
          onCreated={(plan) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
            set({ plan: plan.id, page: page > 1 ? page : null });
          }}
        />
      ) : null}
      {editing ? <PlanEditDialog plan={editing} onOpenChange={(open) => !open && setEditing(null)} onSaved={() => setEditing(null)} /> : null}
    </div>
  );
}
