'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { SimulatorBadge, fuelKindsLabel, useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MAPPING_ODOMETER_KIND_LABELS, UNMAPPED_REASON_LABELS, type MappingView, type ProviderView, type UnitCategory, type UnitRow, type UnitView, type UnitsPage, type VehicleRef } from '@/lib/telemetry-types';
import { useListParams } from '@/lib/use-list-params';
import { CloseMappingDialog, ConfirmMappingDialog, CreateMappingDialog, IgnoreUnitDialog, RejectMappingDialog, UnignoreUnitDialog } from './mapping-dialogs';
import { useManagedCompanies } from './mapping-fields';

const ALL = '__all__';
const CATEGORIES: ReadonlyArray<{ key: UnitCategory; label: string; count: keyof UnitsPage['counts']; empty: string; managersOnly?: boolean }> = [
  { key: 'PROPOSEES', label: 'Propositions à confirmer', count: 'proposees', empty: 'Aucune proposition en attente. Les propositions naissent de la découverte des unités (rapprochement par immatriculation).' },
  { key: 'NON_ASSOCIEES', label: 'Unités non associées', count: 'nonAssociees', empty: 'Toutes les unités présentes chez les fournisseurs sont associées, proposées ou ignorées.' },
  { key: 'ASSOCIEES', label: 'Associations en cours', count: 'associees', empty: 'Aucune association confirmée en cours.' },
  { key: 'VEHICULES_SANS_UNITE', label: 'Véhicules sans unité', count: 'vehiculesSansUnite', empty: 'Tous les véhicules actifs des sociétés où le module est activé ont une unité.' },
  {
    key: 'IGNOREES',
    label: 'Ignorées',
    count: 'ignorees',
    empty: 'Aucune unité ignorée. Une unité volontairement sans véhicule (remorque, boîtier de rechange) s’ignore depuis la liste des unités non associées.',
    managersOnly: true,
  },
];

/**
 * Ignorer ou reprendre une unité (D-249) : administrateur, ou chef de parc d'une société couverte par le
 * fournisseur de l'unité (même règle que la découverte, contrôlée de nouveau par l'API).
 */
export function unitDecider(providers: readonly ProviderView[], canManage: (companyId: string | null | undefined) => boolean): (unit: UnitView) => boolean {
  const covered = new Map(providers.map((p) => [p.id, p.companyIds]));
  return (unit) => (covered.get(unit.providerId) ?? []).some((c) => canManage(c));
}

export type Dialog =
  | { kind: 'confirm'; mapping: MappingView }
  | { kind: 'reject'; mapping: MappingView }
  | { kind: 'close'; mapping: MappingView }
  | { kind: 'create-from-unit'; unit: UnitView }
  | { kind: 'create-from-vehicle'; vehicle: VehicleRef }
  | { kind: 'ignore'; unit: UnitView }
  | { kind: 'unignore'; unit: UnitView }
  | null;

/**
 * Associations unité ↔ véhicule (CDC 14.5 ; D-175, D-186, D-300 à D-302 ; T35) : propositions à
 * confirmer (nature du kilométrage et du carburant, date d'effet), unités non associées avec leur motif,
 * associations en cours (clôture, changement de boîtier), véhicules sans unité et unités ignorées (D-249 :
 * remorque, boîtier de rechange, sans proposition ni alerte). Les décisions sont réservées au chef de parc
 * de la société concernée et à l'administrateur ; les autres rôles consultent.
 */
export function AssociationsTab() {
  const { companyId, session } = useAppScope();
  const companyCode = useCompanyCodes();
  const { canManage, managedIds } = useManagedCompanies();
  const { get, set, page } = useListParams();
  // Une unité non associée n'a pas encore de société : l'association est ouverte à qui gère au moins une société.
  const managesAny = managedIds.length > 0;
  // Catégorie « Ignorées » et décisions sur l'unité : administrateur et chefs de parc seulement.
  const categories = CATEGORIES.filter((c) => !c.managersOnly || managesAny);
  const requested = get('categorie') as UnitCategory;
  const category: UnitCategory = categories.some((c) => c.key === requested) ? requested : 'PROPOSEES';
  const q = get('q');
  const providerId = get('fournisseur');
  const query = toQuery({ category, companyId, providerId, q, page, pageSize: 25 });
  const units = useQuery({ queryKey: ['telemetry', 'units', query], queryFn: () => api<UnitsPage>(`/telemetry/units${query}`) });
  const providers = useQuery({ queryKey: ['telemetry', 'providers', 'scope', companyId], queryFn: () => api<Page<ProviderView>>(`/telemetry/providers${toQuery({ companyId, pageSize: 100 })}`) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const current = categories.find((c) => c.key === category) ?? (CATEGORIES[0] as (typeof CATEGORIES)[number]);
  const canDecideUnit = unitDecider(providers.data?.items ?? [], canManage);

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Catégories d’unités" className="flex flex-wrap gap-2">
        {categories.map((c) => {
          const count = units.data?.counts[c.count];
          const active = c.key === category;
          return (
            <Button key={c.key} aria-pressed={active} variant={active ? 'secondary' : 'outline'} size="sm" className={cn(active && 'border-primary')} onClick={() => set({ categorie: c.key })}>
              {c.label}
              {count !== undefined ? <span className={cn('ml-1 rounded-full px-2 text-xs font-semibold', c.key === 'PROPOSEES' && count > 0 ? 'bg-warning/20 text-warning-foreground' : 'bg-muted')}>{count}</span> : null}
            </Button>
          );
        })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Input aria-label="Rechercher" placeholder="Unité, code ou immatriculation…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        <Select value={providerId || ALL} onValueChange={(v) => set({ fournisseur: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Fournisseur">
            <SelectValue placeholder="Fournisseur" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les fournisseurs</SelectItem>
            {(providers.data?.items ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                {p.isSimulator ? ' (SIMULATEUR — données fictives)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {units.isPending ? (
        <LoadingState />
      ) : units.isError ? (
        <ErrorState error={units.error} retry={() => void units.refetch()} />
      ) : units.data.total === 0 ? (
        <EmptyState title={`${current.label} : aucune`} description={q || providerId ? 'Aucun élément ne correspond aux filtres.' : current.empty} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {category !== 'VEHICULES_SANS_UNITE' ? <TableHead>Unité</TableHead> : null}
                {category !== 'NON_ASSOCIEES' && category !== 'IGNOREES' ? <TableHead>Véhicule</TableHead> : null}
                {category === 'NON_ASSOCIEES' ? <TableHead>Motif</TableHead> : null}
                {category === 'IGNOREES' ? <TableHead>Ignorée le</TableHead> : null}
                {category === 'PROPOSEES' ? <TableHead>Proposée le</TableHead> : null}
                {category === 'ASSOCIEES' ? <TableHead>Natures</TableHead> : null}
                {category === 'ASSOCIEES' ? <TableHead>Depuis le</TableHead> : null}
                {category === 'NON_ASSOCIEES' ? <TableHead className="hidden md:table-cell">Vue le</TableHead> : null}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.data.items.map((row) => (
                <UnitTableRow
                  key={row.mapping?.id ?? row.unit?.id ?? row.vehicle?.id}
                  row={row}
                  category={category}
                  timezone={session.timezone}
                  companyCode={companyCode}
                  canManage={canManage}
                  managesAny={managesAny}
                  canDecideUnit={canDecideUnit}
                  onDialog={setDialog}
                />
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={units.data.page} pageSize={units.data.pageSize} total={units.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      {dialog?.kind === 'confirm' ? <ConfirmMappingDialog mapping={dialog.mapping} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'reject' ? <RejectMappingDialog mapping={dialog.mapping} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'close' ? <CloseMappingDialog mapping={dialog.mapping} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'create-from-unit' ? <CreateMappingDialog unit={dialog.unit} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'create-from-vehicle' ? <CreateMappingDialog vehicle={dialog.vehicle} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'ignore' ? <IgnoreUnitDialog unit={dialog.unit} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'unignore' ? <UnignoreUnitDialog unit={dialog.unit} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function UnitCell({ unit, fallback }: { unit: UnitView | null; fallback: { label: string; externalId: string; declaredRegistration: string | null; providerName: string; isSimulator: boolean } | null }) {
  const u = unit ?? fallback;
  if (!u) return <TableCell>—</TableCell>;
  return (
    <TableCell className="whitespace-normal">
      <span className="font-medium">{u.label}</span> <span className="text-muted-foreground">({u.externalId})</span>
      <span className="block text-xs text-muted-foreground">
        {u.providerName} · immatriculation déclarée : {u.declaredRegistration ?? 'aucune'}
      </span>
      {u.isSimulator ? <SimulatorBadge className="mt-1" /> : null}
    </TableCell>
  );
}

function VehicleCell({ vehicle, companyCode }: { vehicle: VehicleRef | null; companyCode: (id: string) => string }) {
  if (!vehicle) return <TableCell>—</TableCell>;
  return (
    <TableCell className="whitespace-normal">
      <Link href={`/vehicules/${vehicle.id}`} className="font-medium underline-offset-4 hover:underline">
        {vehicle.code}
      </Link>{' '}
      · {vehicle.registration}
      <span className="block text-xs text-muted-foreground">{companyCode(vehicle.companyId)}</span>
    </TableCell>
  );
}

/** Ligne d'une catégorie ; les actions affichées dépendent des droits (l'API les contrôle de nouveau). */
export function UnitTableRow({
  row,
  category,
  timezone,
  companyCode,
  canManage,
  managesAny,
  canDecideUnit,
  onDialog,
}: {
  row: UnitRow;
  category: UnitCategory;
  timezone: string;
  companyCode: (id: string) => string;
  canManage: (companyId: string | null | undefined) => boolean;
  managesAny: boolean;
  canDecideUnit: (unit: UnitView) => boolean;
  onDialog: (d: Dialog) => void;
}) {
  const m = row.mapping;
  const fallbackUnit = m ? { label: m.unitLabel, externalId: m.unitExternalId, declaredRegistration: m.unitDeclaredRegistration, providerName: m.providerName, isSimulator: m.isSimulator } : null;
  const vehicle = row.vehicle ?? m?.vehicle ?? null;
  return (
    <TableRow>
      {category !== 'VEHICULES_SANS_UNITE' ? <UnitCell unit={row.unit} fallback={fallbackUnit} /> : null}
      {category !== 'NON_ASSOCIEES' && category !== 'IGNOREES' ? <VehicleCell vehicle={vehicle} companyCode={companyCode} /> : null}
      {category === 'NON_ASSOCIEES' ? (
        <TableCell className="whitespace-normal text-sm">{row.unmappedReason ? UNMAPPED_REASON_LABELS[row.unmappedReason] : '—'}</TableCell>
      ) : null}
      {category === 'PROPOSEES' && m ? (
        <TableCell className="whitespace-normal">
          {formatDateTime(m.proposedAt, timezone)}
          {m.proposalReason ? <span className="block text-xs text-muted-foreground">{m.proposalReason}</span> : null}
        </TableCell>
      ) : null}
      {category === 'ASSOCIEES' && m ? (
        <TableCell className="whitespace-normal text-sm">
          <StatusBadge label={MAPPING_ODOMETER_KIND_LABELS[m.odometerKind]} tone={m.odometerKind === 'DISTANCE_GPS' ? 'warning' : 'info'} />
          <span className="block text-xs text-muted-foreground">{fuelKindsLabel(m.fuelKinds)}</span>
        </TableCell>
      ) : null}
      {category === 'ASSOCIEES' && m ? <TableCell>{formatDateTime(m.validFrom, timezone)}</TableCell> : null}
      {category === 'NON_ASSOCIEES' && row.unit ? <TableCell className="hidden md:table-cell">{formatDateTime(row.unit.lastSeenAt, timezone)}</TableCell> : null}
      {category === 'IGNOREES' && row.unit ? (
        <TableCell className="whitespace-normal">
          {formatDateTime(row.unit.ignoredAt, timezone)}
          {row.unit.ignoredReason ? <span className="block text-xs text-muted-foreground">Motif : {row.unit.ignoredReason}</span> : null}
          {!row.unit.presentAtProvider ? <span className="block text-xs text-muted-foreground">Absente chez le fournisseur lors de la dernière découverte.</span> : null}
        </TableCell>
      ) : null}
      <TableCell>
        <div className="flex flex-wrap justify-end gap-2">
          {category === 'PROPOSEES' && m && canManage(m.vehicle.companyId) ? (
            <>
              <Button size="sm" onClick={() => onDialog({ kind: 'confirm', mapping: m })} aria-label={`Confirmer l’association ${m.unitLabel} → ${m.vehicle.code}`}>
                Confirmer
              </Button>
              <Button variant="outline" size="sm" onClick={() => onDialog({ kind: 'reject', mapping: m })} aria-label={`Rejeter la proposition ${m.unitLabel} → ${m.vehicle.code}`}>
                Rejeter
              </Button>
            </>
          ) : null}
          {category === 'ASSOCIEES' && m && canManage(m.vehicle.companyId) ? (
            <Button variant="outline" size="sm" onClick={() => onDialog({ kind: 'close', mapping: m })} aria-label={`Clôturer ou changer le boîtier de ${m.vehicle.code}`}>
              Clôturer / changer de boîtier
            </Button>
          ) : null}
          {category === 'NON_ASSOCIEES' && row.unit && managesAny ? (
            <Button variant="outline" size="sm" onClick={() => row.unit && onDialog({ kind: 'create-from-unit', unit: row.unit })} aria-label={`Associer l’unité ${row.unit.label}`}>
              Associer à un véhicule
            </Button>
          ) : null}
          {category === 'NON_ASSOCIEES' && row.unit && canDecideUnit(row.unit) ? (
            <Button variant="ghost" size="sm" onClick={() => row.unit && onDialog({ kind: 'ignore', unit: row.unit })} aria-label={`Ignorer l’unité ${row.unit.label}`}>
              Ignorer cette unité
            </Button>
          ) : null}
          {category === 'IGNOREES' && row.unit && canDecideUnit(row.unit) ? (
            <Button variant="outline" size="sm" onClick={() => row.unit && onDialog({ kind: 'unignore', unit: row.unit })} aria-label={`Ne plus ignorer l’unité ${row.unit.label}`}>
              Ne plus ignorer
            </Button>
          ) : null}
          {category === 'VEHICULES_SANS_UNITE' && row.vehicle && canManage(row.vehicle.companyId) ? (
            <Button variant="outline" size="sm" onClick={() => row.vehicle && onDialog({ kind: 'create-from-vehicle', vehicle: row.vehicle })} aria-label={`Associer une unité au véhicule ${row.vehicle.code}`}>
              Associer une unité
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
