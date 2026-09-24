'use client';

import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RESERVATION_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { RESERVATION_STATUSES, type ReservationView } from '@/lib/reservations-types';
import { useListParams } from '@/lib/use-list-params';
import { addDays, civilStart, isCivilDate } from '@/lib/zoned-time';
import { DriverSearchPicker, VehiclePicker } from '../entity-pickers';
import { NewReservationDialog } from '../new-reservation-dialog';
import { formatSlot, PlanningTabs, reservationStatusLabel, toneForReservation, useReservationRights } from '../planning-shared';
import { convertHref, ReservationDialog, type ReservationDialogMode } from '../reservation-dialog';

const ALL = '__all__';

/** Liste des réservations (GET /reservations) : filtres persistants dans l'URL et actions par ligne. */
export function ReservationsList() {
  const { session, companyId } = useAppScope();
  const { canCreate, canOperate } = useReservationRights();
  const { get, set, page } = useListParams();
  const timezone = session.timezone;
  const rawStatus = get('statut');
  const status = (RESERVATION_STATUSES as string[]).includes(rawStatus) ? rawStatus : '';
  const fromDate = get('du');
  const toDate = get('au');
  const vehicleId = get('vehicule');
  const driverId = get('conducteur');
  const order = get('ordre') === 'desc' ? 'desc' : 'asc';
  const reservationId = get('reservation');
  const [dialogMode, setDialogMode] = useState<ReservationDialogMode>('detail');
  const [creating, setCreating] = useState(false);

  const query = toQuery({
    companyId,
    status,
    from: isCivilDate(fromDate) ? civilStart(fromDate, timezone).toISOString() : undefined,
    to: isCivilDate(toDate) ? civilStart(addDays(toDate, 1), timezone).toISOString() : undefined,
    vehicleId,
    driverId: session.isDriverOnly ? undefined : driverId,
    order,
    page,
    pageSize: 25,
  });
  const reservations = useQuery({ queryKey: ['reservations', query], queryFn: () => api<Page<ReservationView>>(`/reservations${query}`) });

  // Conserve la page courante à l'ouverture et à la fermeture d'une réservation.
  const keepPage = page > 1 ? page : undefined;
  const open = (id: string, mode: ReservationDialogMode) => {
    setDialogMode(mode);
    set({ reservation: id, page: keepPage });
  };

  return (
    <div>
      <PageHeader
        title="Réservations"
        description={session.isDriverOnly ? `Vos réservations. Heures du fuseau ${timezone}.` : `Créneaux [début, fin[ ; heures du fuseau de l’organisation (${timezone}). La création vaut confirmation après contrôles.`}
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" /> Nouvelle réservation
            </Button>
          ) : null
        }
      />
      {session.isDriverOnly ? null : <PlanningTabs />}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 xl:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="reservations-status">Statut</Label>
          <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
            <SelectTrigger id="reservations-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {Object.entries(RESERVATION_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reservations-from">Du</Label>
          <Input id="reservations-from" type="date" value={isCivilDate(fromDate) ? fromDate : ''} onChange={(e) => set({ du: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reservations-to">Au (inclus)</Label>
          <Input id="reservations-to" type="date" value={isCivilDate(toDate) ? toDate : ''} onChange={(e) => set({ au: e.target.value })} />
        </div>
        {session.isDriverOnly ? null : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="reservations-vehicle">Véhicule</Label>
              <VehiclePicker id="reservations-vehicle" value={vehicleId} onChange={(v) => set({ vehicule: v })} companyId={companyId} clearLabel="Tous les véhicules" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reservations-driver">Conducteur</Label>
              <DriverSearchPicker id="reservations-driver" value={driverId} onChange={(d) => set({ conducteur: d })} companyId={companyId} clearLabel="Tous les conducteurs" />
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="reservations-order">Tri par début</Label>
          <Select value={order} onValueChange={(v) => set({ ordre: v === 'desc' ? 'desc' : '' })}>
            <SelectTrigger id="reservations-order" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">Plus anciennes d’abord</SelectItem>
              <SelectItem value="desc">Plus récentes d’abord</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {reservations.isPending ? (
        <LoadingState label="Chargement des réservations…" />
      ) : reservations.isError ? (
        <ErrorState error={reservations.error} retry={() => void reservations.refetch()} />
      ) : reservations.data.total === 0 ? (
        <EmptyState title="Aucune réservation" description={session.isDriverOnly ? 'Aucune de vos réservations ne correspond aux filtres.' : 'Aucune réservation ne correspond aux filtres dans votre périmètre.'} />
      ) : session.isDriverOnly ? (
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="Mes réservations">
            {reservations.data.items.map((r) => (
              <li key={r.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold">
                      {r.vehicleCode} · {r.vehicleRegistration}
                    </p>
                    <p className="text-muted-foreground">{formatSlot(r.startAt, r.endAt, timezone)}</p>
                    <p className="break-words">{r.purpose}</p>
                    {r.destination ? <p className="text-muted-foreground">{r.destination}</p> : null}
                  </div>
                  <StatusBadge label={reservationStatusLabel(r.status)} tone={toneForReservation(r.status)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  <Button variant="link" className="h-auto p-0" onClick={() => open(r.id, 'detail')}>
                    Voir le détail<span className="sr-only"> de la réservation {r.vehicleCode} du {formatDateTime(r.startAt, timezone)}</span>
                  </Button>
                  {r.convertedUsageId ? (
                    <Link href={`/utilisations/${r.convertedUsageId}`} className="text-sm underline underline-offset-4">
                      Ouvrir l’utilisation
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <PaginationControls page={reservations.data.page} pageSize={reservations.data.pageSize} total={reservations.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Véhicule</TableHead>
                <TableHead>Conducteur</TableHead>
                <TableHead>Début (inclus)</TableHead>
                <TableHead>Fin (exclue)</TableHead>
                <TableHead>Motif</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Créée par</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.data.items.map((r) => {
                const actionable = r.status === 'CONFIRMEE' && !session.isDriverOnly && canOperate(r.companyId);
                const name = `${r.vehicleCode} du ${formatDateTime(r.startAt, timezone)}`;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      {session.isDriverOnly ? (
                        <span className="font-medium">{r.vehicleCode}</span>
                      ) : (
                        <Link href={`/vehicules/${r.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                          {r.vehicleCode}
                        </Link>
                      )}
                      <span className="block text-xs text-muted-foreground">{r.vehicleRegistration}</span>
                    </TableCell>
                    <TableCell>{r.driverName}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(r.startAt, timezone)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(r.endAt, timezone)}</TableCell>
                    <TableCell className="max-w-64">
                      <span className="block truncate" title={r.purpose}>
                        {r.purpose}
                      </span>
                      {r.destination ? <span className="block truncate text-xs text-muted-foreground">{r.destination}</span> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={reservationStatusLabel(r.status)} tone={toneForReservation(r.status)} />
                    </TableCell>
                    <TableCell>{r.createdByName ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions sur la réservation ${name}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => open(r.id, 'detail')}>Voir le détail</DropdownMenuItem>
                          {r.convertedUsageId ? (
                            <DropdownMenuItem asChild>
                              <Link href={`/utilisations/${r.convertedUsageId}`}>Ouvrir l’utilisation</Link>
                            </DropdownMenuItem>
                          ) : null}
                          {actionable ? (
                            <>
                              <DropdownMenuItem onSelect={() => open(r.id, 'modifier')}>Modifier</DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link href={convertHref(r.id)}>Convertir en remise</Link>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => open(r.id, 'non-honoree')}>Déclarer non honorée</DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => open(r.id, 'annuler')}>
                                Annuler la réservation
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={reservations.data.page} pageSize={reservations.data.pageSize} total={reservations.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      {creating ? <NewReservationDialog defaultVehicleId={vehicleId || undefined} onClose={() => setCreating(false)} /> : null}
      {reservationId ? (
        <ReservationDialog
          key={`${reservationId}-${dialogMode}`}
          reservationId={reservationId}
          initialMode={dialogMode}
          onClose={() => {
            setDialogMode('detail');
            set({ reservation: '', page: keepPage });
          }}
        />
      ) : null}
    </div>
  );
}
