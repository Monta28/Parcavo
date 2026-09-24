'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Plus } from 'lucide-react';
import Link from 'next/link';
import { INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
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
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { INTERVENTION_COST_STATUS_LABELS, INTERVENTION_KIND_LABELS, type GarageOption, type InterventionSort, type InterventionView } from '@/lib/interventions-types';
import { useListParams } from '@/lib/use-list-params';
import { ALL, toneForCostStatus, toneForInterventionStatus, useInterventionRights, useOperationalCompanyIds } from './intervention-helpers';

const OPEN = 'OUVERTES';

type SortOrder = 'asc' | 'desc';

/** Colonnes triables (tris autorisés par l'API) ; les dates s'ouvrent sur la plus récente. */
const SORTABLE: Record<'reference' | 'vehicleCode' | 'status' | 'plannedStartAt' | 'performedOn', { firstOrder: SortOrder }> = {
  reference: { firstOrder: 'asc' },
  vehicleCode: { firstOrder: 'asc' },
  status: { firstOrder: 'asc' },
  plannedStartAt: { firstOrder: 'desc' },
  performedOn: { firstOrder: 'desc' },
};

function isSortable(value: string): value is keyof typeof SORTABLE & InterventionSort {
  return Object.hasOwn(SORTABLE, value);
}

/** En-tête de colonne triable, annoncé aux technologies d'assistance (aria-sort). */
function SortableHead({ label, field, sort, order, onSort, className }: { label: string; field: keyof typeof SORTABLE; sort: string; order: SortOrder; onSort: (field: keyof typeof SORTABLE) => void; className?: string }) {
  const active = sort === field;
  const Icon = active ? (order === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={className} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => onSort(field)}>
        {label}
        <Icon className={active ? 'size-3.5' : 'size-3.5 opacity-50'} aria-hidden="true" />
        <span className="sr-only">{active ? ` (trié par ordre ${order === 'asc' ? 'croissant' : 'décroissant'}, activer pour inverser)` : ' (activer pour trier)'}</span>
      </button>
    </TableHead>
  );
}

/** Interventions préventives et correctives du périmètre (CDC 6.3, 10.2), filtres conservés dans l'URL. */
export function InterventionsList() {
  const { companyId, session } = useAppScope();
  const rights = useInterventionRights(companyId);
  const operationalCompanies = useOperationalCompanyIds();
  const { get, set, page } = useListParams();
  const q = get('q');
  const statut = get('statut');
  const kind = get('type');
  const vehicleId = get('vehicule');
  const from = get('du');
  const to = get('au');
  const supplierId = get('fournisseur');
  const requestedSort = get('tri');
  const sort = isSortable(requestedSort) ? requestedSort : '';
  const order: SortOrder = get('sens') === 'desc' ? 'desc' : 'asc';
  const query = toQuery({
    companyId,
    q,
    status: statut && statut !== OPEN ? statut : undefined,
    open: statut === OPEN ? 'true' : undefined,
    kind,
    vehicleId,
    supplierId,
    from,
    to,
    sort: sort || undefined,
    order: sort ? order : undefined,
    page,
    pageSize: 25,
  });

  const interventions = useQuery({ queryKey: ['interventions', query], queryFn: () => api<Page<InterventionView>>(`/interventions${query}`) });
  // Garages et fournisseurs du périmètre, archivés compris (historique d'un fournisseur).
  const suppliers = useQuery({ queryKey: ['suppliers', 'intervention-filter', companyId], queryFn: () => api<Page<GarageOption>>(`/suppliers${toQuery({ companyId, pageSize: 100 })}`) });
  const supplierOptions = suppliers.data?.items ?? [];
  const canCreate = companyId ? rights.operational : operationalCompanies.length > 0;
  const canReadCosts = rights.can('costs.read');
  const filtered = Boolean(q || statut || kind || vehicleId || supplierId || from || to);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';
  const onSort = (field: keyof typeof SORTABLE) => set({ tri: field, sens: sort === field ? (order === 'asc' ? 'desc' : 'asc') : SORTABLE[field].firstOrder });

  return (
    <div>
      <PageHeader
        title="Interventions"
        description="Entretiens préventifs et réparations correctives : planification, exécution, clôture et coûts. Planifier une intervention ne signifie pas qu’elle a été exécutée."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/interventions/nouvelle">
                <Plus className="size-4" aria-hidden="true" /> Nouvelle intervention
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <div className="space-y-1">
          <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
            Référence
          </Label>
          <Input id="filter-q" placeholder="INT-2026-…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-status" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={statut || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-status" className="w-full">
              <SelectValue placeholder="Statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              <SelectItem value={OPEN}>Ouvertes (brouillon, planifiée, en cours)</SelectItem>
              {Object.entries(INTERVENTION_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-kind" className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select value={kind || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-kind" className="w-full">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Préventif et correctif</SelectItem>
              {Object.entries(INTERVENTION_KIND_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-vehicle" className="text-xs text-muted-foreground">
            Véhicule
          </Label>
          <VehicleFilter id="filter-vehicle" vehicleId={vehicleId} onChange={(v) => set({ vehicule: v })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-supplier" className="text-xs text-muted-foreground">
            Garage / fournisseur
          </Label>
          <Select value={supplierId || ALL} onValueChange={(v) => set({ fournisseur: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-supplier" className="w-full">
              <SelectValue placeholder="Tous les fournisseurs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les fournisseurs</SelectItem>
              {supplierId && !supplierOptions.some((s) => s.id === supplierId) ? <SelectItem value={supplierId}>Fournisseur sélectionné</SelectItem> : null}
              {supplierOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                  {companyId === null ? ` · ${companyCode(s.companyId)}` : ''}
                  {s.status === 'ARCHIVE' ? ' (archivé)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-from" className="text-xs text-muted-foreground">
            Du
          </Label>
          <Input id="filter-from" type="date" value={from} max={to || undefined} onChange={(e) => set({ du: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-to" className="text-xs text-muted-foreground">
            Au
          </Label>
          <Input id="filter-to" type="date" value={to} min={from || undefined} onChange={(e) => set({ au: e.target.value })} />
        </div>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        La période porte sur la date effective de réalisation, sinon sur le jour du début réel, sinon sur celui du début prévu (jours du fuseau {session.timezone}).
      </p>

      {interventions.isPending ? (
        <LoadingState />
      ) : interventions.isError ? (
        <ErrorState error={interventions.error} retry={() => void interventions.refetch()} />
      ) : interventions.data.total === 0 ? (
        <EmptyState
          title="Aucune intervention"
          description={filtered ? 'Aucune intervention ne correspond aux filtres dans votre périmètre.' : 'Aucune intervention n’a encore été enregistrée dans votre périmètre.'}
          action={
            !filtered && canCreate ? (
              <Button size="sm" asChild>
                <Link href="/interventions/nouvelle">
                  <Plus className="size-4" aria-hidden="true" /> Nouvelle intervention
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
            {interventions.data.total} intervention{interventions.data.total > 1 ? 's' : ''}
            {canReadCosts ? '' : ' · Coûts non visibles avec vos habilitations'}
          </p>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Référence" field="reference" sort={sort} order={order} onSort={onSort} />
                  <SortableHead label="Véhicule" field="vehicleCode" sort={sort} order={order} onSort={onSort} />
                  {companyId === null ? <TableHead className="hidden md:table-cell">Société</TableHead> : null}
                  <TableHead>Type</TableHead>
                  <SortableHead label="Statut" field="status" sort={sort} order={order} onSort={onSort} />
                  <SortableHead label="Dates prévues" field="plannedStartAt" sort={sort} order={order} onSort={onSort} className="hidden lg:table-cell" />
                  <SortableHead label="Dates réelles" field="performedOn" sort={sort} order={order} onSort={onSort} className="hidden lg:table-cell" />
                  <TableHead className="hidden md:table-cell">Garage</TableHead>
                  {canReadCosts ? <TableHead className="text-right">Coût</TableHead> : null}
                  <TableHead>État du coût</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {interventions.data.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/interventions/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                        {i.reference}
                      </Link>
                      {i.isHistorical ? <span className="block text-xs text-muted-foreground">Saisie a posteriori</span> : null}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{i.vehicleCode}</span>
                      <span className="block text-xs text-muted-foreground">{i.vehicleRegistration}</span>
                    </TableCell>
                    {companyId === null ? <TableCell className="hidden md:table-cell">{companyCode(i.companyId)}</TableCell> : null}
                    <TableCell>{INTERVENTION_KIND_LABELS[i.kind] ?? i.kind}</TableCell>
                    <TableCell>
                      <StatusBadge label={INTERVENTION_STATUS_LABELS[i.status] ?? i.status} tone={toneForInterventionStatus(i.status)} />
                    </TableCell>
                    <TableCell className="hidden whitespace-normal lg:table-cell">
                      {i.plannedStartAt ? (
                        <>
                          <span className="block">du {formatDateTime(i.plannedStartAt, session.timezone)}</span>
                          {i.plannedEndAt ? <span className="block text-muted-foreground">au {formatDateTime(i.plannedEndAt, session.timezone)}</span> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-normal lg:table-cell">
                      {i.performedOn ? <span className="block">Réalisée le {formatDate(i.performedOn)}</span> : null}
                      {i.startedAt ? <span className="block text-muted-foreground">Début {formatDateTime(i.startedAt, session.timezone)}</span> : null}
                      {!i.performedOn && !i.startedAt ? '—' : null}
                    </TableCell>
                    <TableCell className="hidden whitespace-normal md:table-cell">{i.supplierName ?? '—'}</TableCell>
                    {canReadCosts ? <TableCell className="text-right tabular-nums">{i.totalAmount !== null ? formatMoney(i.totalAmount, session.currency, session.currencyDecimals) : '—'}</TableCell> : null}
                    <TableCell>
                      {i.status === 'TERMINEE' ? <StatusBadge label={INTERVENTION_COST_STATUS_LABELS[i.costStatus] ?? i.costStatus} tone={toneForCostStatus(i.costStatus)} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls page={interventions.data.page} pageSize={interventions.data.pageSize} total={interventions.data.total} onPageChange={(p) => set({ page: p })} />
          </div>
        </>
      )}
    </div>
  );
}
