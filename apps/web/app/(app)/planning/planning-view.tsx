'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { VEHICLE_LIFECYCLE_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { PLANNING_KIND_LABELS, type PlanningItem, type PlanningResponse, type PlanningWarning } from '@/lib/reservations-types';
import { useListParams } from '@/lib/use-list-params';
import type { VehicleView } from '@/lib/vehicles-types';
import { addDays, civilHour, civilStart, daysBetween, isCivilDate, startOfMonth, startOfWeek, todayCivil, weekdayOf } from '@/lib/zoned-time';
import { useVehicleView, VehiclePicker } from './entity-pickers';
import { NewReservationDialog } from './new-reservation-dialog';
import { formatSlot, PlanningTabs, planningItemHref, planningStatusLabel, planningTone, useReservationRights } from './planning-shared';
import { type PlanningColumn, PlanningLegend, type PlanningRow, PlanningTimeline } from './planning-timeline';
import { ReservationDialog } from './reservation-dialog';

type ViewMode = 'jour' | 'semaine' | 'mois';

const VIEW_LABELS: Record<ViewMode, string> = { jour: 'Jour', semaine: 'Semaine', mois: 'Mois' };
const ITEM_OBJECT_LABELS: Record<PlanningItem['kind'], string> = { RESERVATION: 'la réservation', UTILISATION: 'l’utilisation', IMMOBILISATION: 'le véhicule immobilisé', INTERVENTION: 'l’intervention' };
const VEHICLE_ROWS_LIMIT = 100;
const WEEKDAY_INITIALS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

/** Formatage d'une date civile (sans décalage de fuseau). */
function formatCivil(civil: string, options: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = civil.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface PlanningWindow {
  start: string;
  days: number;
  title: string;
  previous: string;
  next: string;
}

function windowFor(mode: ViewMode, anchor: string): PlanningWindow {
  if (mode === 'jour') {
    return { start: anchor, days: 1, title: capitalize(formatCivil(anchor, { dateStyle: 'full' })), previous: addDays(anchor, -1), next: addDays(anchor, 1) };
  }
  if (mode === 'semaine') {
    const start = startOfWeek(anchor);
    return {
      start,
      days: 7,
      title: `Semaine du ${formatCivil(start, { dateStyle: 'short' })} au ${formatCivil(addDays(start, 6), { dateStyle: 'short' })}`,
      previous: addDays(anchor, -7),
      next: addDays(anchor, 7),
    };
  }
  const start = startOfMonth(anchor);
  return { start, days: daysBetween(start, startOfMonth(anchor, 1)), title: capitalize(formatCivil(start, { month: 'long', year: 'numeric' })), previous: startOfMonth(anchor, -1), next: startOfMonth(anchor, 1) };
}

function columnsFor(mode: ViewMode, win: PlanningWindow, timezone: string, today: string): PlanningColumn[] {
  if (mode === 'jour') {
    return Array.from({ length: 24 }, (_, h) => ({ start: civilHour(win.start, h, timezone).getTime(), label: `${h} h`, fullLabel: `${h} h – ${h + 1} h`, isToday: false }));
  }
  return Array.from({ length: win.days }, (_, i) => {
    const day = addDays(win.start, i);
    const label = mode === 'semaine' ? formatCivil(day, { weekday: 'short', day: '2-digit', month: '2-digit' }) : `${WEEKDAY_INITIALS[weekdayOf(day)]} ${Number(day.slice(8))}`;
    return { start: civilStart(day, timezone).getTime(), label, fullLabel: formatCivil(day, { dateStyle: 'full' }), isToday: day === today };
  });
}

export function PlanningView() {
  const { session } = useAppScope();
  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Planning" />
        <EmptyState
          title="Planning réservé au personnel de gestion du parc"
          description="Vos réservations à venir et votre utilisation en cours sont affichées dans « Mon véhicule »."
          action={
            <Button asChild variant="outline">
              <Link href="/mon-vehicule">Ouvrir Mon véhicule</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <StaffPlanning />;
}

function StaffPlanning() {
  const { session, companyId } = useAppScope();
  const queryClient = useQueryClient();
  const { canCreate, canOperate } = useReservationRights();
  const { get, set } = useListParams();
  const timezone = session.timezone;
  const today = todayCivil(timezone);
  const rawMode = get('vue');
  const mode: ViewMode = rawMode === 'jour' || rawMode === 'mois' ? rawMode : 'semaine';
  const rawDate = get('date');
  const anchor = isCivilDate(rawDate) ? rawDate : today;
  const vehicleId = get('vehicule');
  const display = get('affichage') === 'liste' ? 'liste' : 'chronologie';
  const hideFree = get('libres') === 'masquer';
  const reservationId = get('reservation');
  const [newFor, setNewFor] = useState<string | null>(null);

  const win = windowFor(mode, anchor);
  const from = civilStart(win.start, timezone).toISOString();
  const windowEnd = civilStart(addDays(win.start, win.days), timezone);
  const query = toQuery({ companyId, vehicleId, from, to: windowEnd.toISOString() });
  const planning = useQuery({ queryKey: ['planning', query], queryFn: () => api<PlanningResponse>(`/planning${query}`) });
  const vehiclesQuery = toQuery({ companyId, pageSize: VEHICLE_ROWS_LIMIT, sort: 'code' });
  const vehicles = useQuery({ queryKey: ['vehicles', vehiclesQuery], queryFn: () => api<Page<VehicleView>>(`/vehicles${vehiclesQuery}`), enabled: !vehicleId && !hideFree });
  const selectedVehicle = useVehicleView(vehicleId);

  const columns = columnsFor(mode, win, timezone, today);
  const minWidth = 176 + (mode === 'jour' ? 24 * 44 : mode === 'semaine' ? 7 * 120 : win.days * 38);

  const items = planning.data?.items ?? [];
  const warnings = planning.data?.warnings ?? [];
  const warnedIds = new Set(warnings.flatMap((w) => [w.interventionId, w.reservationId]));
  const rowMap = new Map<string, PlanningRow>();
  const rowOf = (v: VehicleView): PlanningRow => ({ vehicleId: v.id, code: v.code, registration: v.registration, companyId: v.companyId, lifecycleLabel: v.lifecycleStatus === 'ACTIF' ? null : VEHICLE_LIFECYCLE_LABELS[v.lifecycleStatus] });
  if (vehicleId && selectedVehicle.data) rowMap.set(vehicleId, rowOf(selectedVehicle.data));
  if (!vehicleId && !hideFree) for (const v of vehicles.data?.items ?? []) rowMap.set(v.id, rowOf(v));
  // Véhicule sans fiche chargée : société de son élément le plus récent sur la période (l'API reste juge).
  const latestFirst = [...items].sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
  for (const item of latestFirst) if (!rowMap.has(item.vehicleId)) rowMap.set(item.vehicleId, { vehicleId: item.vehicleId, code: item.vehicleCode, registration: null, companyId: item.companyId, lifecycleLabel: null });
  const rows = [...rowMap.values()].sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
  const codeOf = new Map(rows.map((r) => [r.vehicleId, r.code]));
  const sortedItems = [...items].sort((a, b) => (codeOf.get(a.vehicleId) ?? '').localeCompare(codeOf.get(b.vehicleId) ?? '', 'fr', { numeric: true }) || Date.parse(a.startAt) - Date.parse(b.startAt));
  const truncatedVehicles = !vehicleId && !hideFree && (vehicles.data?.total ?? 0) > VEHICLE_ROWS_LIMIT;

  const openReservation = (id: string) => set({ reservation: id });

  return (
    <div>
      <PageHeader
        title="Planning"
        description={`Réservations, utilisations, immobilisations et interventions par véhicule. Créneaux [début, fin[ ; heures du fuseau de l’organisation (${timezone}).`}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['planning'] });
                void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
              }}
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Actualiser
            </Button>
            {canCreate ? (
              <Button onClick={() => setNewFor(vehicleId)}>
                <Plus className="size-4" aria-hidden="true" /> Nouvelle réservation
              </Button>
            ) : null}
          </>
        }
      />
      <PlanningTabs />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Période" className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => set({ date: win.previous })} aria-label={mode === 'jour' ? 'Jour précédent' : mode === 'semaine' ? 'Semaine précédente' : 'Mois précédent'}>
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button variant="outline" onClick={() => set({ date: '' })} disabled={!rawDate}>
              Aujourd’hui
            </Button>
            <Button variant="outline" size="icon" onClick={() => set({ date: win.next })} aria-label={mode === 'jour' ? 'Jour suivant' : mode === 'semaine' ? 'Semaine suivante' : 'Mois suivant'}>
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <h2 className="text-lg font-semibold" aria-live="polite">
            {win.title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Vue" className="inline-flex rounded-md border p-0.5">
            {(Object.keys(VIEW_LABELS) as ViewMode[]).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? 'default' : 'ghost'} aria-pressed={mode === m} onClick={() => set({ vue: m === 'semaine' ? '' : m })}>
                {VIEW_LABELS[m]}
              </Button>
            ))}
          </div>
          <div role="group" aria-label="Affichage" className="inline-flex rounded-md border p-0.5">
            <Button size="sm" variant={display === 'chronologie' ? 'default' : 'ghost'} aria-pressed={display === 'chronologie'} onClick={() => set({ affichage: '' })}>
              Chronologie
            </Button>
            <Button size="sm" variant={display === 'liste' ? 'default' : 'ghost'} aria-pressed={display === 'liste'} onClick={() => set({ affichage: 'liste' })}>
              Liste
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="planning-date">Aller à la date</Label>
          <Input id="planning-date" type="date" value={anchor} onChange={(e) => isCivilDate(e.target.value) && set({ date: e.target.value === today ? '' : e.target.value })} />
        </div>
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="planning-vehicle">Véhicule</Label>
          <VehiclePicker id="planning-vehicle" value={vehicleId} onChange={(v) => set({ vehicule: v })} companyId={companyId} clearLabel="Tous les véhicules" />
        </div>
        <div className="flex items-center gap-2 lg:pb-2">
          <Checkbox id="planning-hide-free" checked={hideFree} onCheckedChange={(c) => set({ libres: c === true ? 'masquer' : '' })} disabled={Boolean(vehicleId)} />
          <Label htmlFor="planning-hide-free" className="font-normal">
            Masquer les véhicules sans élément
          </Label>
        </div>
      </div>

      {warnings.length > 0 ? <PlanningWarnings warnings={warnings} onOpenReservation={openReservation} /> : null}

      {planning.isPending ? (
        <LoadingState label="Chargement du planning…" />
      ) : planning.isError ? (
        <ErrorState error={planning.error} retry={() => void planning.refetch()} />
      ) : rows.length === 0 ? (
        vehicles.isPending && !vehicleId && !hideFree ? (
          <LoadingState label="Chargement des véhicules…" />
        ) : (
          <EmptyState title="Aucun élément sur la période" description="Aucune réservation, utilisation, immobilisation ni intervention ne chevauche cette période dans votre périmètre." />
        )
      ) : display === 'chronologie' ? (
        <div className="space-y-3">
          <PlanningLegend />
          <PlanningTimeline
            rows={rows}
            items={items}
            columns={columns}
            windowEnd={windowEnd.getTime()}
            timezone={timezone}
            minWidth={minWidth}
            warnedIds={warnedIds}
            onOpenReservation={openReservation}
            onCreateFor={canCreate ? (row) => setNewFor(row.vehicleId) : null}
            canCreateFor={(row) => row.companyId !== null && canOperate(row.companyId)}
          />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="Aucun élément sur la période" description="Aucune réservation, utilisation, immobilisation ni intervention ne chevauche cette période dans votre périmètre." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <caption className="sr-only">Éléments du planning — {win.title}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Véhicule</TableHead>
                <TableHead>Élément</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Conducteur</TableHead>
                <TableHead>Créneau</TableHead>
                <TableHead>Objet</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedItems.map((item) => (
                <TableRow key={`${item.kind}-${item.id}`}>
                  <TableCell>
                    <Link href={`/vehicules/${item.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                      {item.vehicleCode}
                    </Link>
                  </TableCell>
                  <TableCell>{PLANNING_KIND_LABELS[item.kind]}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge label={planningStatusLabel(item)} tone={item.isLate ? 'info' : planningTone(item)} />
                      {item.isLate ? <StatusBadge label={item.kind === 'INTERVENTION' ? 'Fin prévue dépassée' : 'En retard'} tone="danger" /> : null}
                      {warnedIds.has(item.id) ? <StatusBadge label="Chevauchement signalé" tone="warning" /> : null}
                    </div>
                  </TableCell>
                  <TableCell>{item.driverName ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatSlot(item.startAt, item.endAt, timezone)}</TableCell>
                  <TableCell className="max-w-64 truncate" title={item.label}>
                    {item.label}
                  </TableCell>
                  <TableCell>
                    {item.kind === 'RESERVATION' ? (
                      <Button variant="link" className="h-auto p-0" onClick={() => openReservation(item.id)}>
                        {canOperate(item.companyId) && item.status === 'CONFIRMEE' ? 'Gérer' : 'Ouvrir'}
                        <span className="sr-only"> la réservation {item.vehicleCode} du {formatSlot(item.startAt, item.endAt, timezone)}</span>
                      </Button>
                    ) : (
                      <Link href={planningItemHref(item)} className="underline-offset-4 hover:underline">
                        Ouvrir<span className="sr-only"> {ITEM_OBJECT_LABELS[item.kind]} {item.vehicleCode}</span>
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {truncatedVehicles ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Seuls les {VEHICLE_ROWS_LIMIT} premiers véhicules (par code) sont listés en plus de ceux ayant un élément sur la période, tous affichés : filtrez par véhicule pour en voir un autre.
        </p>
      ) : null}
      {vehicles.isError && !planning.isError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Liste des véhicules indisponible ({isApiError(vehicles.error) ? vehicles.error.message : 'erreur de chargement'}) : seuls les véhicules ayant un élément sur la période sont affichés.
        </p>
      ) : null}

      {newFor !== null ? <NewReservationDialog defaultVehicleId={newFor || undefined} onClose={() => setNewFor(null)} /> : null}
      {reservationId ? <ReservationDialog key={reservationId} reservationId={reservationId} onClose={() => set({ reservation: '' })} /> : null}
    </div>
  );
}

/**
 * Avertissements de l'API (sans blocage) : intervention planifiée ou en cours qui chevauche une réservation
 * confirmée du même véhicule. Rien n'est refusé : déplacer l'une ou l'autre, ou prévenir le conducteur.
 */
function PlanningWarnings({ warnings, onOpenReservation }: { warnings: PlanningWarning[]; onOpenReservation: (reservationId: string) => void }) {
  return (
    <section aria-labelledby="planning-warnings-title" className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <h2 id="planning-warnings-title" className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4" aria-hidden="true" />
        {warnings.length === 1 ? 'Une intervention chevauche une réservation confirmée' : `${warnings.length} chevauchements entre interventions et réservations confirmées`}
      </h2>
      <p className="mt-1 text-muted-foreground">Avertissement sans blocage : déplacez l’intervention ou la réservation, ou prévenez le conducteur.</p>
      <ul className="mt-2 space-y-1.5">
        {warnings.map((w) => (
          <li key={`${w.interventionId}-${w.reservationId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{w.message}</span>
            <Link href={`/interventions/${w.interventionId}`} className="underline underline-offset-4">
              Intervention {w.interventionReference}
            </Link>
            <Button variant="link" className="h-auto p-0" onClick={() => onOpenReservation(w.reservationId)}>
              Réservation de {w.driverName}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
