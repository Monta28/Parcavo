'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { ALL } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { FUEL_ENTRY_STATUSES, type FuelEntryView, fuelStatusLabel } from '@/lib/fuel-types';
import { useListParams } from '@/lib/use-list-params';
import { isCivilDate } from '@/lib/zoned-time';
import { FuelAnomalyBadges, FuelStatusBadge, energyLabel, formatFuelLiters, useFuelWriteCompanyIds, useMoney } from './fuel-display';

/**
 * Pleins du périmètre (CDC 8.2, 10.2) : filtres société, véhicule, statut, période et écart montant conservés
 * dans l'URL ; statut et anomalies signalés par l'API ; montants affichés seulement quand l'API les renvoie
 * (costs.read).
 */
export function FuelList() {
  const { session } = useAppScope();
  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Carburant" />
        <EmptyState
          title="Écran réservé au personnel du parc"
          description="Déclarez vos tickets carburant et suivez leur validation depuis l’espace « Mon véhicule »."
          action={
            <Button asChild variant="outline">
              <Link href="/mon-vehicule">Mon véhicule</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <StaffFuelList />;
}

function StaffFuelList() {
  const { companyId: scopeCompanyId, session } = useAppScope();
  const { get, set, page } = useListParams();
  const statut = get('statut');
  const vehicleId = get('vehicule');
  const societe = get('societe');
  const du = get('du');
  const au = get('au');
  const ecart = get('ecart');
  // Filtre société local seulement en vue « Toutes mes sociétés » ; le serveur recoupe avec les habilitations.
  const companyId = scopeCompanyId ?? (societe || null);
  const query = toQuery({
    companyId,
    vehicleId,
    status: statut,
    from: du && isCivilDate(du) ? du : undefined,
    to: au && isCivilDate(au) ? au : undefined,
    amountMismatch: ecart === 'oui' ? 'true' : ecart === 'non' ? 'false' : undefined,
    page,
    pageSize: 25,
  });
  const entries = useQuery({ queryKey: ['fuel-entries', query], queryFn: () => api<Page<FuelEntryView>>(`/fuel-entries${query}`) });
  const pendingQuery = toQuery({ companyId, status: 'SOUMIS', pageSize: 1 });
  const pending = useQuery({ queryKey: ['fuel-entries', pendingQuery], queryFn: () => api<Page<FuelEntryView>>(`/fuel-entries${pendingQuery}`) });
  const writeCompanies = useFuelWriteCompanyIds();
  const canCreate = companyId ? writeCompanies.includes(companyId) : writeCompanies.length > 0;
  const money = useMoney();
  const filtered = Boolean(statut || vehicleId || du || au || ecart || (scopeCompanyId === null && societe));
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';
  const showCompany = companyId === null;
  const items = entries.data?.items ?? [];
  const showAmounts = items.some((e) => e.totalAmount !== null);
  const pendingCount = pending.data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="Carburant"
        description="Pleins saisis par le personnel et tickets soumis par les conducteurs : validation, rejet, correction et justificatifs. La consommation estimée se consulte dans l’onglet « Consommation » de chaque véhicule."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href={vehicleId ? `/carburant/nouveau?vehicule=${encodeURIComponent(vehicleId)}` : '/carburant/nouveau'}>
                <Plus className="size-4" aria-hidden="true" /> Saisir un plein
              </Link>
            </Button>
          ) : null
        }
      />

      {pendingCount > 0 && statut !== 'SOUMIS' ? (
        <div role="status" className="mb-4 flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>{pendingCount === 1 ? '1 ticket conducteur attend une validation.' : `${pendingCount} tickets conducteur attendent une validation.`}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => set({ statut: 'SOUMIS' })}>
            Afficher les pleins à valider
          </Button>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {scopeCompanyId === null && session.companies.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor="fuel-filter-societe" className="text-xs text-muted-foreground">
              Société
            </Label>
            <Select value={societe || ALL} onValueChange={(v) => set({ societe: v === ALL ? '' : v })}>
              <SelectTrigger id="fuel-filter-societe" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Toutes mes sociétés</SelectItem>
                {session.companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="fuel-filter-vehicule" className="text-xs text-muted-foreground">
            Véhicule
          </Label>
          <VehicleFilter id="fuel-filter-vehicule" vehicleId={vehicleId} onChange={(v) => set({ vehicule: v })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fuel-filter-statut" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={statut || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="fuel-filter-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {FUEL_ENTRY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {fuelStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="fuel-filter-du" className="text-xs text-muted-foreground">
            Du
          </Label>
          <Input id="fuel-filter-du" type="date" value={du} max={au || undefined} onChange={(e) => set({ du: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fuel-filter-au" className="text-xs text-muted-foreground">
            Au
          </Label>
          <Input id="fuel-filter-au" type="date" value={au} min={du || undefined} onChange={(e) => set({ au: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fuel-filter-ecart" className="text-xs text-muted-foreground">
            Écart montant
          </Label>
          <Select value={ecart || ALL} onValueChange={(v) => set({ ecart: v === ALL ? '' : v })}>
            <SelectTrigger id="fuel-filter-ecart" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les pleins</SelectItem>
              <SelectItem value="oui">Avec écart signalé</SelectItem>
              <SelectItem value="non">Sans écart signalé</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">Période en dates locales ({session.timezone}), bornes incluses.</p>

      {entries.isPending ? (
        <LoadingState label="Chargement des pleins…" />
      ) : entries.isError ? (
        <ErrorState error={entries.error} retry={() => void entries.refetch()} />
      ) : entries.data.total === 0 ? (
        <EmptyState
          title="Aucun plein"
          description={filtered ? 'Aucun plein ne correspond aux filtres dans votre périmètre.' : 'Aucun plein n’a été saisi ni soumis dans votre périmètre.'}
          action={
            filtered ? (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ statut: '', vehicule: '', societe: '', du: '', au: '', ecart: '' })}>
                Effacer les filtres
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date du plein</TableHead>
                <TableHead>Véhicule</TableHead>
                {showCompany ? <TableHead className="hidden md:table-cell">Société</TableHead> : null}
                <TableHead className="hidden lg:table-cell">Conducteur</TableHead>
                <TableHead className="text-right">Litres</TableHead>
                {showAmounts ? <TableHead className="text-right">Montant</TableHead> : null}
                <TableHead>Statut</TableHead>
                <TableHead>Anomalies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/carburant/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                      {formatDateTime(e.filledAt, session.timezone)}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {energyLabel(e.energy)} · {e.isFullTank ? 'plein complet' : 'plein partiel'}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {e.vehicleCode} · {e.vehicleRegistration}
                  </TableCell>
                  {showCompany ? <TableCell className="hidden md:table-cell">{companyCode(e.companyId)}</TableCell> : null}
                  <TableCell className="hidden lg:table-cell">{e.driverName ?? '—'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatFuelLiters(e.liters)}</TableCell>
                  {showAmounts ? <TableCell className="text-right whitespace-nowrap">{e.totalAmount === null ? <span className="text-muted-foreground">Non communiqué</span> : money(e.totalAmount)}</TableCell> : null}
                  <TableCell>
                    <FuelStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell>
                    <FuelAnomalyBadges entry={e} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={entries.data.page} pageSize={entries.data.pageSize} total={entries.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
