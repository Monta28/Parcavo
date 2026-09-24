'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { DISTANCE_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { UsageView } from '@/lib/usages-types';
import { useListParams } from '@/lib/use-list-params';
import type { VehicleView } from '@/lib/vehicles-types';
import { DriverPicker, VehiclePicker } from './entity-pickers';
import { dayEndIso, dayStartIso, toneForDistance, useOperationalIn } from './usage-helpers';

const ALL = '__all__';

/** Utilisations (CDC 4.3 à 4.5, 10.2) : en cours, historique et retours dépassés, filtres persistants dans l'URL. */
export function UsagesList() {
  const { companyId, session } = useAppScope();
  const { get, set, page } = useListParams();
  const status = get('statut');
  const late = get('retard') === '1';
  const vehicleId = get('vehicule');
  const driverId = get('conducteur');
  const from = get('du');
  const to = get('au');
  const canCheckout = useOperationalIn(companyId) && !session.isDriverOnly;
  const staff = !session.isDriverOnly;

  const query = toQuery({ companyId, status, late: late ? 'true' : undefined, vehicleId, driverId, from: dayStartIso(from, session.timezone), to: dayEndIso(to, session.timezone), page, pageSize: 25 });
  const usages = useQuery({ queryKey: ['usages', query], queryFn: () => api<Page<UsageView>>(`/usages${query}`) });
  const vehicle = useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`), enabled: staff && Boolean(vehicleId) });
  const driver = useQuery({ queryKey: ['driver', driverId], queryFn: () => api<DriverView>(`/drivers/${driverId}`), enabled: staff && Boolean(driverId) });
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';
  const hasFilters = Boolean(status || late || vehicleId || driverId || from || to);

  return (
    <div>
      <PageHeader
        title="Utilisations"
        description="Remises et restitutions réelles : utilisations en cours, historique et retours dépassés."
        actions={
          canCheckout ? (
            <Button asChild>
              <Link href="/utilisations/nouvelle">
                <Plus className="size-4" aria-hidden="true" /> Nouvelle remise
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" role="search" aria-label="Filtres des utilisations">
        <div className="space-y-1">
          <Label htmlFor="filter-status">Statut</Label>
          <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-status" className="w-full">
              <SelectValue placeholder="Statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {Object.entries(USAGE_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {staff ? (
          <div className="space-y-1">
            <Label htmlFor="filter-vehicle">Véhicule</Label>
            <VehiclePicker
              id="filter-vehicle"
              companyId={companyId}
              includeInactive
              value={vehicleId ? (vehicle.data ?? null) : null}
              loadingValue={Boolean(vehicleId) && vehicle.isPending}
              onChange={(v) => set({ vehicule: v?.id ?? '' })}
              placeholder={vehicleId && vehicle.isError ? 'Véhicule filtré introuvable' : 'Tous les véhicules'}
              clearLabel="Retirer le filtre véhicule"
            />
          </div>
        ) : null}
        {staff ? (
          <div className="space-y-1">
            <Label htmlFor="filter-driver">Conducteur</Label>
            <DriverPicker
              id="filter-driver"
              companyId={companyId}
              value={driverId ? (driver.data ?? null) : null}
              loadingValue={Boolean(driverId) && driver.isPending}
              onChange={(d) => set({ conducteur: d?.id ?? '' })}
              placeholder={driverId && driver.isError ? 'Conducteur filtré introuvable' : 'Tous les conducteurs'}
              clearLabel="Retirer le filtre conducteur"
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="filter-from">Remise à partir du</Label>
          <Input id="filter-from" type="date" value={from} max={to || undefined} onChange={(e) => set({ du: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-to">Remise jusqu’au</Label>
          <Input id="filter-to" type="date" value={to} min={from || undefined} onChange={(e) => set({ au: e.target.value })} />
        </div>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <div className="flex items-center gap-2">
            <Checkbox id="filter-late" checked={late} onCheckedChange={(v) => set({ retard: v === true ? '1' : '' })} />
            <Label htmlFor="filter-late">Retours dépassés uniquement</Label>
          </div>
          {hasFilters ? (
            <Button
              type="button"
              variant="link"
              className="h-auto justify-start p-0"
              onClick={() => set({ statut: '', retard: '', vehicule: '', conducteur: '', du: '', au: '' })}
            >
              Réinitialiser les filtres
            </Button>
          ) : null}
        </div>
      </div>

      {usages.isPending ? (
        <LoadingState label="Chargement des utilisations…" />
      ) : usages.isError ? (
        <ErrorState error={usages.error} retry={() => void usages.refetch()} />
      ) : usages.data.total === 0 ? (
        <EmptyState
          title="Aucune utilisation"
          description={hasFilters ? 'Aucune utilisation ne correspond aux filtres dans votre périmètre.' : 'Aucune remise n’a encore été enregistrée dans votre périmètre.'}
          action={
            canCheckout && !hasFilters ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/utilisations/nouvelle">Enregistrer une remise</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Véhicule</TableHead>
                {companyId === null && staff ? <TableHead>Société</TableHead> : null}
                <TableHead>Conducteur</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Remise</TableHead>
                <TableHead>Retour prévu</TableHead>
                <TableHead>Retour réel</TableHead>
                <TableHead>Distance</TableHead>
                <TableHead>
                  <span className="sr-only">Détail</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usages.data.items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    {staff ? (
                      <Link href={`/vehicules/${u.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                        {u.vehicleCode}
                      </Link>
                    ) : (
                      <span className="font-medium">{u.vehicleCode}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">{u.vehicleRegistration}</span>
                  </TableCell>
                  {companyId === null && staff ? <TableCell>{companyCode(u.companyId)}</TableCell> : null}
                  <TableCell>
                    {staff ? (
                      <Link href={`/conducteurs/${u.driverId}`} className="underline-offset-4 hover:underline">
                        {u.driverName}
                      </Link>
                    ) : (
                      u.driverName
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={USAGE_STATUS_LABELS[u.status] ?? u.status} tone={u.status === 'EN_COURS' ? 'info' : 'neutral'} />
                  </TableCell>
                  <TableCell>{formatDateTime(u.checkedOutAt, session.timezone)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{formatDateTime(u.expectedReturnAt, session.timezone)}</span>
                      {u.isLate ? <StatusBadge label="Retour dépassé" tone="danger" /> : null}
                    </div>
                  </TableCell>
                  <TableCell>{u.returnedAt ? formatDateTime(u.returnedAt, session.timezone) : <span className="text-muted-foreground">Non restitué</span>}</TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <span>{formatKm(u.distanceKm)}</span>
                      <StatusBadge label={DISTANCE_STATUS_LABELS[u.distanceStatus] ?? u.distanceStatus} tone={toneForDistance(u.distanceStatus)} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Link href={`/utilisations/${u.id}`} className="font-medium underline-offset-4 hover:underline">
                      Ouvrir<span className="sr-only"> l’utilisation {u.vehicleCode} du {formatDateTime(u.checkedOutAt, session.timezone)}</span>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={usages.data.page} pageSize={usages.data.pageSize} total={usages.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
