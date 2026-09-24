'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { INTERVENTION_STATUS_LABELS, RESERVATION_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import type { StatusBadge } from '@/components/status-badge';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { IMMOBILIZATION_STATUS_LABELS } from '@/lib/interventions-types';
import { PLANNING_KIND_LABELS, type PlanningItem, type ReservationStatus } from '@/lib/reservations-types';
import { cn } from '@/lib/utils';
import { isoToCivil } from '@/lib/zoned-time';

export type Tone = NonNullable<Parameters<typeof StatusBadge>[0]['tone']>;

/** Rôles opérationnels de l'API (OPERATIONAL_ROLES) : administrateur de société, chef de parc, opérateur. */
const OPERATIONAL_ROLES = ['ADMIN', 'CHEF_PARC', 'OPERATEUR'];

/**
 * Droits d'écriture sur les réservations (création, modification, annulation, non-présentation) :
 * opérateur, chef de parc ou administrateur de la société (l'API reste seule juge et refuse sinon).
 */
export function useReservationRights() {
  const { session, companyId } = useAppScope();
  const canOperate = (targetCompanyId: string) => session.isAdmin || session.grants.some((g) => g.companyId === targetCompanyId && OPERATIONAL_ROLES.includes(g.role));
  const canCreate = !session.isDriverOnly && (companyId ? canOperate(companyId) : session.isAdmin || session.grants.some((g) => OPERATIONAL_ROLES.includes(g.role)));
  const canOverride = (targetCompanyId: string) => session.isAdmin || session.grants.some((g) => g.companyId === targetCompanyId && g.permissions.includes('exceptions.override'));
  return { canOperate, canCreate, canOverride };
}

/** Instant courant rafraîchi chaque minute (repère « maintenant », ouverture d'une action datée par l'API). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function reservationStatusLabel(status: string): string {
  return RESERVATION_STATUS_LABELS[status as ReservationStatus] ?? status;
}

export function toneForReservation(status: string): Tone {
  switch (status) {
    case 'CONFIRMEE':
      return 'info';
    case 'CONVERTIE':
      return 'success';
    case 'NON_HONOREE':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Libellé du statut d'un élément du planning selon son type. */
export function planningStatusLabel(item: Pick<PlanningItem, 'kind' | 'status'>): string {
  if (item.kind === 'RESERVATION') return reservationStatusLabel(item.status);
  if (item.kind === 'UTILISATION') return USAGE_STATUS_LABELS[item.status as keyof typeof USAGE_STATUS_LABELS] ?? item.status;
  if (item.kind === 'INTERVENTION') return INTERVENTION_STATUS_LABELS[item.status as keyof typeof INTERVENTION_STATUS_LABELS] ?? item.status;
  return IMMOBILIZATION_STATUS_LABELS[item.status as keyof typeof IMMOBILIZATION_STATUS_LABELS] ?? item.status;
}

export function planningTone(item: Pick<PlanningItem, 'kind' | 'status' | 'isLate'>): Tone {
  if (item.isLate) return 'danger';
  if (item.kind === 'RESERVATION') return toneForReservation(item.status);
  if (item.kind === 'UTILISATION') return item.status === 'EN_COURS' ? 'info' : 'neutral';
  if (item.kind === 'INTERVENTION') return 'warning';
  return item.status === 'ACTIVE' ? 'danger' : 'neutral';
}

/** Lien de l'élément : fiche d'utilisation ou d'intervention, fiche véhicule pour une immobilisation (réservation : dialogue). */
export function planningItemHref(item: Pick<PlanningItem, 'kind' | 'id' | 'vehicleId'>): string {
  if (item.kind === 'UTILISATION') return `/utilisations/${item.id}`;
  if (item.kind === 'INTERVENTION') return `/interventions/${item.id}`;
  return `/vehicules/${item.vehicleId}`;
}

/** Description textuelle complète d'un élément (lecteurs d'écran, infobulle). */
export function describePlanningItem(item: PlanningItem, timezone: string): string {
  const parts = [`${PLANNING_KIND_LABELS[item.kind]} ${planningStatusLabel(item).toLowerCase()}`];
  if (item.isLate) parts.push(item.kind === 'INTERVENTION' ? 'fin prévue dépassée' : 'en retard');
  parts.push(`véhicule ${item.vehicleCode}`);
  if (item.driverName) parts.push(item.driverName);
  if (item.label) parts.push(item.label);
  parts.push(`du ${formatDateTime(item.startAt, timezone)} ${item.endAt ? `au ${formatDateTime(item.endAt, timezone)}` : 'sans fin prévue'}`);
  return parts.join(', ');
}

function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: timezone }).format(new Date(iso));
}

/** Créneau [début, fin[ lisible ; l'heure seule pour une fin le même jour. */
export function formatSlot(startAt: string, endAt: string | null, timezone: string): string {
  if (!endAt) return `${formatDateTime(startAt, timezone)} → fin non prévue`;
  const sameDay = isoToCivil(startAt, timezone) === isoToCivil(endAt, timezone);
  return `${formatDateTime(startAt, timezone)} → ${sameDay ? formatTime(endAt, timezone) : formatDateTime(endAt, timezone)}`;
}

/** Navigation entre le planning et la liste des réservations. */
export function PlanningTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: '/planning', label: 'Planning' },
    { href: '/planning/reservations', label: 'Réservations' },
  ];
  return (
    <nav aria-label="Planning" className="mb-4 inline-flex rounded-lg bg-muted p-1">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Refus de l'API affiché tel quel (message métier), avec lien vers l'utilisation en cause le cas échéant. */
export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  const usageId = typeof apiError?.details?.usageId === 'string' ? apiError.details.usageId : null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="text-destructive">{apiError ? apiError.message : 'Une erreur est survenue : rien n’a été enregistré.'}</p>
      {apiError?.requestId && apiError.status >= 500 ? <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p> : null}
      {usageId ? (
        <Link href={`/utilisations/${usageId}`} className="mt-1 inline-block underline underline-offset-4">
          Ouvrir l’utilisation en cours
        </Link>
      ) : null}
    </div>
  );
}
