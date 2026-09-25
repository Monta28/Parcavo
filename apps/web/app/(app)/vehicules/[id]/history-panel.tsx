'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowRightLeft,
  BadgeCheck,
  CalendarOff,
  CalendarPlus,
  CalendarX,
  CarFront,
  CircleCheck,
  CirclePlay,
  CircleX,
  ClipboardList,
  ClipboardX,
  ExternalLink,
  FileClock,
  FilePlus,
  Gauge,
  KeyRound,
  Milestone,
  OctagonPause,
  RefreshCcw,
  RotateCcw,
  TriangleAlert,
  Undo2,
  UserCheck,
  UserMinus,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import type { Page, SessionInfo } from '@/lib/api-types';
import { TIMELINE_CATEGORIES, TIMELINE_CATEGORY_LABELS, type TimelineCategory, type TimelineDetail, type TimelineEvent, type TimelineEventType } from '@/lib/audit-types';
import { formatDate, formatDateTime, formatKm, formatMoney } from '@/lib/format';
import { objectHref } from '@/lib/object-links';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;
const ALL = '__all__';

type Order = 'desc' | 'asc';

const ORDERS: Record<Order, string> = { desc: 'Plus récents d’abord', asc: 'Plus anciens d’abord' };

/** Icône par type d'événement ; le libellé (titre) est fourni par l'API. */
const EVENT_ICONS: Record<TimelineEventType, LucideIcon> = {
  VEHICULE_CREE: CarFront,
  SOCIETE_TRANSFERT: ArrowRightLeft,
  AFFECTATION_DEBUT: UserCheck,
  AFFECTATION_FIN: UserMinus,
  RESERVATION_CREEE: CalendarPlus,
  RESERVATION_ANNULEE: CalendarX,
  RESERVATION_NON_HONOREE: CalendarOff,
  COMPTEUR_INITIALISE: Gauge,
  COMPTEUR_REMPLACE: RefreshCcw,
  RELEVE: Milestone,
  UTILISATION_REMISE: KeyRound,
  UTILISATION_RETOUR: Undo2,
  INCIDENT_DECLARE: TriangleAlert,
  INCIDENT_RESOLU: CircleCheck,
  INCIDENT_CLOTURE: Archive,
  IMMOBILISATION_DEBUT: OctagonPause,
  IMMOBILISATION_FIN: CirclePlay,
  PLAN_CREE: ClipboardList,
  PLAN_DESACTIVE: ClipboardX,
  INTERVENTION_CREEE: Wrench,
  INTERVENTION_TERMINEE: BadgeCheck,
  INTERVENTION_ROUVERTE: RotateCcw,
  INTERVENTION_ANNULEE: CircleX,
  DOCUMENT_ENREGISTRE: FilePlus,
  DOCUMENT_RENOUVELE: FileClock,
};

/** Mise en relief visuelle (doublée du titre texte : jamais la couleur seule, CDC 10.1). */
const EVENT_TONES: Partial<Record<TimelineEventType, string>> = {
  INCIDENT_DECLARE: 'border-destructive/40 bg-destructive/10 text-destructive',
  IMMOBILISATION_DEBUT: 'border-destructive/40 bg-destructive/10 text-destructive',
  INTERVENTION_TERMINEE: 'border-success/40 bg-success/15 text-success',
  INCIDENT_RESOLU: 'border-success/40 bg-success/15 text-success',
  IMMOBILISATION_FIN: 'border-success/40 bg-success/15 text-success',
  SOCIETE_TRANSFERT: 'border-primary/40 bg-primary/10 text-primary',
};

/** Libellé du lien vers la fiche de l'objet source. */
const OBJECT_LINK_LABELS: Record<string, string> = {
  VehicleUsage: 'Ouvrir l’utilisation',
  Intervention: 'Ouvrir l’intervention',
  Incident: 'Ouvrir l’incident',
  Immobilization: 'Ouvrir l’immobilisation',
  DocumentVersion: 'Ouvrir le document',
  Reservation: 'Ouvrir la réservation',
  VehicleMaintenancePlan: 'Ouvrir le plan d’entretien',
};

/**
 * Onglet Historique du dossier véhicule (CDC 3.1 ; D-109, D-275) : chronologie métier servie par
 * GET /vehicles/:id/timeline, déjà filtrée par le serveur selon les droits du lecteur (objets d'une autre
 * société en vue technique, aucun montant sans costs.read, conducteur limité à ses propres événements).
 * Pagination « Charger plus » ; aucune règle recalculée ici.
 */
export function VehicleHistoryPanel({ vehicleId }: { vehicleId: string }) {
  const session = useSession();
  const [category, setCategory] = useState<TimelineCategory | ''>('');
  const [order, setOrder] = useState<Order>('desc');

  const timeline = useInfiniteQuery({
    queryKey: ['vehicle', vehicleId, 'timeline', category, order],
    queryFn: ({ pageParam }) => api<Page<TimelineEvent>>(`/vehicles/${vehicleId}/timeline${toQuery({ category, order, page: pageParam, pageSize: PAGE_SIZE })}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });

  // Un événement survenu entre deux chargements décale les pages : chaque identifiant n'est affiché qu'une fois.
  const seen = new Set<string>();
  const events: TimelineEvent[] = [];
  for (const e of (timeline.data?.pages ?? []).flatMap((p) => p.items)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    events.push(e);
  }
  const total = timeline.data?.pages.at(-1)?.total ?? 0;
  const hasTechnical = events.some((e) => e.access === 'TECHNIQUE');

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1 sm:w-64">
          <Label htmlFor={`history-category-${vehicleId}`}>Catégorie</Label>
          <Select value={category || ALL} onValueChange={(v) => setCategory(v === ALL ? '' : (v as TimelineCategory))}>
            <SelectTrigger id={`history-category-${vehicleId}`} className="w-full">
              <SelectValue placeholder="Catégorie" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les catégories</SelectItem>
              {TIMELINE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {TIMELINE_CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div role="group" aria-label="Ordre chronologique" className="inline-flex flex-wrap self-start rounded-md border p-0.5 sm:self-auto">
          {(Object.keys(ORDERS) as Order[]).map((o) => (
            <Button key={o} type="button" size="sm" variant={order === o ? 'default' : 'ghost'} aria-pressed={order === o} onClick={() => setOrder(o)}>
              {ORDERS[o]}
            </Button>
          ))}
        </div>
      </div>

      {hasTechnical ? (
        <p className="text-sm text-muted-foreground">
          Les événements marqués « Vue technique » appartiennent à une autre société gestionnaire du véhicule : ils sont montrés sans auteur, texte libre, montant ni fournisseur.
        </p>
      ) : null}

      {timeline.isPending ? (
        <LoadingState label="Chargement de l’historique…" />
      ) : timeline.isError && events.length === 0 ? (
        <ErrorState error={timeline.error} retry={() => void timeline.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          title="Aucun événement"
          description={category ? `Aucun événement « ${TIMELINE_CATEGORY_LABELS[category]} » visible pour ce véhicule dans votre périmètre.` : 'Aucun événement visible pour ce véhicule dans votre périmètre.'}
        />
      ) : (
        <>
          <ol className="relative space-y-0" aria-label="Chronologie du véhicule">
            {events.map((event, index) => (
              <TimelineItem key={event.id} event={event} vehicleId={vehicleId} session={session} last={index === events.length - 1} />
            ))}
          </ol>

          {timeline.isFetchNextPageError ? <ErrorState error={timeline.error} retry={() => void timeline.fetchNextPage()} /> : null}

          <div className="flex flex-col items-center gap-2 py-2 text-sm sm:flex-row sm:justify-between">
            <span className="text-muted-foreground" aria-live="polite">
              {events.length} événement{events.length > 1 ? 's' : ''} affiché{events.length > 1 ? 's' : ''} sur {total}
            </span>
            {timeline.hasNextPage ? (
              <Button type="button" variant="outline" disabled={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>
                {timeline.isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function TimelineItem({ event, vehicleId, session, last }: { event: TimelineEvent; vehicleId: string; session: SessionInfo; last: boolean }) {
  const Icon = EVENT_ICONS[event.type] ?? Milestone;
  // Le dossier du véhicule courant n'a pas de lien : la page affichée est déjà la sienne.
  const href = event.objectAccessible && event.objectType !== 'Vehicle' ? objectHref(event.objectType, event.objectId, { vehicleId, isAdmin: session.isAdmin }) : null;
  const linkLabel = OBJECT_LINK_LABELS[event.objectType] ?? 'Ouvrir la fiche';

  return (
    <li className="relative flex gap-3 pb-6">
      {last ? null : <span aria-hidden="true" className="absolute top-9 bottom-0 left-4 w-px -translate-x-1/2 bg-border" />}
      <span aria-hidden="true" className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground', EVENT_TONES[event.type])}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="font-medium">{event.title}</p>
          <time dateTime={event.occurredAt} className="text-sm text-muted-foreground">
            {formatDateTime(event.occurredAt, session.timezone)}
          </time>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <StatusBadge label={event.categoryLabel} tone="neutral" />
          {event.companyCode ? <StatusBadge label={`Société ${event.companyCode}`} tone="neutral" /> : null}
          {event.access === 'TECHNIQUE' ? <StatusBadge label="Vue technique · autre société" tone="warning" /> : null}
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">Par </span>
          {event.actorName ?? <span className="text-muted-foreground italic">auteur non renseigné</span>}
        </p>
        {event.details.length > 0 ? (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            {event.details.map((d, i) => (
              <div key={`${d.label}-${i}`} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="min-w-0 break-words">{detailValue(d, session)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {href ? (
          <Link href={href} className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
            <ExternalLink className="size-3.5" aria-hidden="true" /> {linkLabel}
            <span className="sr-only"> ({event.title} du {formatDateTime(event.occurredAt, session.timezone)})</span>
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** Affichage d'une valeur brute selon sa nature (le serveur ne formate pas). */
function detailValue(detail: TimelineDetail, session: SessionInfo): string {
  switch (detail.kind) {
    case 'KM':
      return formatKm(detail.value);
    case 'MONTANT':
      return formatMoney(detail.value, session.currency, session.currencyDecimals);
    case 'DATE':
      return formatDate(detail.value, session.timezone);
    case 'DATE_HEURE':
      return formatDateTime(detail.value, session.timezone);
    default:
      return detail.value;
  }
}
