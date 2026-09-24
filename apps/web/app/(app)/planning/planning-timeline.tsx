'use client';

import { CalendarPlus, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import type { PlanningItem } from '@/lib/reservations-types';
import { cn } from '@/lib/utils';
import { describePlanningItem, planningItemHref, planningStatusLabel, useNow } from './planning-shared';

export interface PlanningRow {
  vehicleId: string;
  code: string;
  registration: string | null;
  /**
   * Société du véhicule : fiche chargée (GET /vehicles) ou, à défaut, société de son élément le plus récent
   * sur la période ; null si inconnue (aucune action proposée alors).
   */
  companyId: string | null;
  /** Libellé du cycle de vie renvoyé par l'API, affiché lorsqu'il n'est pas « Actif ». */
  lifecycleLabel: string | null;
}

export interface PlanningColumn {
  /** Début de la colonne (ms). */
  start: number;
  label: string;
  /** Libellé complet (lecteurs d'écran). */
  fullLabel: string;
  isToday: boolean;
}

const LANE_HEIGHT = 30;
const LABEL_WIDTH = 176;

/** Position relative (0..1) d'un instant sur l'axe, linéaire par colonne (heure d'été comprise). */
function positionOf(t: number, bounds: number[]): number {
  const n = bounds.length - 1;
  const first = bounds[0] ?? 0;
  const last = bounds[n] ?? 0;
  if (n <= 0 || t <= first) return 0;
  if (t >= last) return 1;
  for (let i = 0; i < n; i += 1) {
    const a = bounds[i] ?? 0;
    const b = bounds[i + 1] ?? 0;
    if (t >= a && t < b) return (i + (b > a ? (t - a) / (b - a) : 0)) / n;
  }
  return 1;
}

interface PlacedItem {
  item: PlanningItem;
  left: number;
  right: number;
  lane: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * Répartition en couloirs des éléments qui se chevauchent sur une même ligne (affichage uniquement).
 * Une utilisation en retard ou une intervention en cours dont la fin prévue est dépassée (signalées par
 * l'API) est prolongée visuellement jusqu'à maintenant : elle occupe toujours le véhicule.
 */
function placeItems(items: PlanningItem[], bounds: number[], now: number): { placed: PlacedItem[]; lanes: number } {
  const windowStart = bounds[0] ?? 0;
  const windowEnd = bounds[bounds.length - 1] ?? 0;
  const sorted = [...items].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const laneEnds: number[] = [];
  const placed: PlacedItem[] = [];
  for (const item of sorted) {
    const start = Date.parse(item.startAt);
    const plannedEnd = item.endAt ? Date.parse(item.endAt) : Number.POSITIVE_INFINITY;
    const stillOccupying = item.isLate && (item.kind === 'UTILISATION' || (item.kind === 'INTERVENTION' && item.status === 'EN_COURS'));
    const end = stillOccupying ? Math.max(plannedEnd, now) : plannedEnd;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else laneEnds[lane] = end;
    placed.push({ item, left: positionOf(start, bounds), right: positionOf(Math.min(end, windowEnd), bounds), lane, clippedStart: start < windowStart, clippedEnd: end > windowEnd });
  }
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

function barClass(item: PlanningItem): string {
  if (item.isLate) return 'border-destructive bg-destructive text-white';
  if (item.kind === 'RESERVATION') return item.status === 'CONFIRMEE' ? 'border-dashed border-primary/60 bg-primary/10 text-primary' : 'border-dashed border-success/50 bg-success/10 text-success';
  if (item.kind === 'UTILISATION') return item.status === 'EN_COURS' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-muted text-foreground';
  if (item.kind === 'INTERVENTION') return item.status === 'EN_COURS' ? 'border-warning bg-warning/40 text-warning-foreground' : 'border-dashed border-warning bg-warning/15 text-warning-foreground';
  return item.status === 'ACTIVE' ? 'border-destructive/60 bg-destructive/15 text-destructive' : 'border-border bg-muted text-muted-foreground';
}

const SHORT_KIND: Record<PlanningItem['kind'], string> = { RESERVATION: 'Rés.', UTILISATION: 'Util.', IMMOBILISATION: 'Immob.', INTERVENTION: 'Interv.' };

function shortText(item: PlanningItem): string {
  const who = item.kind === 'IMMOBILISATION' || item.kind === 'INTERVENTION' ? item.label : (item.driverName ?? item.label);
  const late = item.isLate ? (item.kind === 'INTERVENTION' ? ' · fin dépassée' : ' · en retard') : '';
  return `${SHORT_KIND[item.kind]} ${planningStatusLabel(item).toLowerCase()}${late} · ${who}`;
}

/**
 * Vue chronologique par véhicule : une ligne par véhicule, un bloc par élément positionné sur [début, fin[.
 * Chaque bloc est un lien ou un bouton focalisable portant la description complète ; la vue « Liste » en
 * donne l'équivalent tabulaire.
 */
export function PlanningTimeline({
  rows,
  items,
  columns,
  windowEnd,
  timezone,
  minWidth,
  warnedIds,
  onOpenReservation,
  onCreateFor,
  canCreateFor,
}: {
  rows: PlanningRow[];
  items: PlanningItem[];
  columns: PlanningColumn[];
  windowEnd: number;
  timezone: string;
  minWidth: number;
  /** Éléments (intervention ou réservation) concernés par un avertissement de chevauchement de l'API. */
  warnedIds: ReadonlySet<string>;
  onOpenReservation: (reservationId: string) => void;
  onCreateFor: ((row: PlanningRow) => void) | null;
  /** Masque « Réserver » sur les véhicules d'une société où l'utilisateur n'est pas opérationnel. */
  canCreateFor: (row: PlanningRow) => boolean;
}) {
  const now = useNow();
  const bounds = [...columns.map((c) => c.start), windowEnd];
  const nowPos = now >= (bounds[0] ?? 0) && now < windowEnd ? positionOf(now, bounds) : null;
  const byVehicle = new Map<string, PlanningItem[]>();
  for (const item of items) byVehicle.set(item.vehicleId, [...(byVehicle.get(item.vehicleId) ?? []), item]);
  const gridStyle = { backgroundImage: 'linear-gradient(to right, var(--border) 1px, transparent 1px)', backgroundSize: `${100 / columns.length}% 100%` };

  return (
    <div className="overflow-x-auto rounded-md border">
      <div style={{ minWidth }}>
        <div className="flex border-b bg-muted/50 text-xs font-medium text-muted-foreground" aria-hidden="true">
          <div className="sticky left-0 z-20 shrink-0 border-r bg-muted px-3 py-2" style={{ width: LABEL_WIDTH }}>
            Véhicule
          </div>
          <div className="flex flex-1">
            {columns.map((c) => (
              <div key={c.start} className={cn('flex-1 truncate border-l px-1 py-2 text-center first:border-l-0', c.isToday && 'bg-primary/10 text-primary')} title={c.fullLabel}>
                {c.label}
              </div>
            ))}
          </div>
        </div>
        <ul aria-label="Planning par véhicule">
          {rows.map((row) => {
            const { placed, lanes } = placeItems(byVehicle.get(row.vehicleId) ?? [], bounds, now);
            return (
              <li key={row.vehicleId} className="flex border-b last:border-b-0">
                <div className="sticky left-0 z-20 flex shrink-0 items-start justify-between gap-1 border-r bg-background px-3 py-2" style={{ width: LABEL_WIDTH }}>
                  <div className="min-w-0">
                    <Link href={`/vehicules/${row.vehicleId}`} className="block truncate text-sm font-medium underline-offset-4 hover:underline">
                      {row.code}
                    </Link>
                    {row.registration ? <span className="block truncate text-xs text-muted-foreground">{row.registration}</span> : null}
                    {row.lifecycleLabel ? <StatusBadge label={row.lifecycleLabel} tone="warning" className="mt-0.5" /> : null}
                    {placed.length === 0 ? <span className="block text-xs text-muted-foreground">Aucun élément sur la période</span> : <span className="sr-only">{placed.length} élément(s)</span>}
                  </div>
                  {onCreateFor && canCreateFor(row) ? (
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCreateFor(row)} aria-label={`Réserver ${row.code}`} title={`Réserver ${row.code}`}>
                      <CalendarPlus aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                <div className="relative flex-1" style={{ ...gridStyle, height: lanes * LANE_HEIGHT + 12 }}>
                  {columns.map((c, i) =>
                    c.isToday ? <div key={c.start} aria-hidden="true" className="absolute inset-y-0 bg-primary/5" style={{ left: `${(i / columns.length) * 100}%`, width: `${100 / columns.length}%` }} /> : null,
                  )}
                  {nowPos !== null ? <div aria-hidden="true" className="absolute inset-y-0 z-10 w-px bg-destructive" style={{ left: `${nowPos * 100}%` }} /> : null}
                  <ul aria-label={`Éléments du véhicule ${row.code}`}>
                    {placed.map((p) => {
                      const warned = warnedIds.has(p.item.id);
                      const description = `${describePlanningItem(p.item, timezone)}${warned ? '. Avertissement : chevauchement entre une intervention et une réservation confirmée' : ''}`;
                      const className = cn(
                        'absolute z-10 flex items-center overflow-hidden rounded border px-1.5 text-left text-xs font-medium whitespace-nowrap shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                        p.clippedStart && 'rounded-l-none',
                        p.clippedEnd && 'rounded-r-none',
                        barClass(p.item),
                        warned && 'ring-2 ring-warning ring-offset-1',
                      );
                      const style = { left: `${p.left * 100}%`, width: `max(${(p.right - p.left) * 100}%, 6px)`, top: p.lane * LANE_HEIGHT + 6, height: LANE_HEIGHT - 6 };
                      const content = (
                        <>
                          {p.clippedStart ? <span aria-hidden="true">←&nbsp;</span> : null}
                          {warned ? <TriangleAlert className="mr-1 size-3 shrink-0" aria-hidden="true" /> : null}
                          <span className="truncate">{shortText(p.item)}</span>
                          {p.clippedEnd ? <span aria-hidden="true">&nbsp;→</span> : null}
                        </>
                      );
                      return (
                        <li key={`${p.item.kind}-${p.item.id}`}>
                          {p.item.kind === 'RESERVATION' ? (
                            <button type="button" className={className} style={style} title={description} aria-label={`${description}. Ouvrir la réservation`} onClick={() => onOpenReservation(p.item.id)}>
                              {content}
                            </button>
                          ) : (
                            <Link href={planningItemHref(p.item)} className={className} style={style} title={description} aria-label={description}>
                              {content}
                            </Link>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Légende : chaque style est doublé d'un libellé texte dans les blocs. */
export function PlanningLegend() {
  const entries = [
    { label: 'Réservation confirmée', className: 'border-dashed border-primary/60 bg-primary/10' },
    { label: 'Réservation convertie', className: 'border-dashed border-success/50 bg-success/10' },
    { label: 'Utilisation en cours', className: 'border-primary bg-primary' },
    { label: 'Utilisation terminée', className: 'border-border bg-muted' },
    { label: 'En retard', className: 'border-destructive bg-destructive' },
    { label: 'Immobilisation active', className: 'border-destructive/60 bg-destructive/15' },
    { label: 'Intervention planifiée', className: 'border-dashed border-warning bg-warning/15' },
    { label: 'Intervention en cours', className: 'border-warning bg-warning/40' },
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Légende">
      {entries.map((e) => (
        <li key={e.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('inline-block h-3 w-5 rounded-sm border', e.className)} />
          {e.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-3 w-px bg-destructive" />
        Maintenant
      </li>
      <li className="flex items-center gap-1.5">
        <TriangleAlert className="size-3" aria-hidden="true" />
        Chevauchement intervention / réservation (avertissement)
      </li>
      <li>← → : l’élément commence avant ou finit après la période affichée.</li>
    </ul>
  );
}
