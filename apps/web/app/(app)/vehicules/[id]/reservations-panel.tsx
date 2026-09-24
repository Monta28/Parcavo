'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { ReservationView } from '@/lib/reservations-types';
import { formatSlot, reservationStatusLabel, toneForReservation } from '../../planning/planning-shared';

type Period = 'a-venir' | 'toutes';

const PERIODS: Record<Period, { label: string; hint: string }> = {
  'a-venir': { label: 'À venir et en cours', hint: 'Créneaux en cours ou futurs, du plus proche au plus lointain' },
  toutes: { label: 'Historique complet', hint: 'Toutes les réservations, des plus récentes aux plus anciennes' },
};

/**
 * Réservations du véhicule en lecture (GET /reservations?vehicleId=) : créneaux à venir ou en cours
 * (fenêtre à partir de maintenant), ou historique complet. Créations et modifications : planning.
 */
export function ReservationsPanel({ vehicleId }: { vehicleId: string }) {
  const session = useSession();
  const [period, setPeriod] = useState<Period>('a-venir');
  const [page, setPage] = useState(1);
  // Instant de référence figé à l'ouverture de l'onglet : la clé de requête reste stable.
  const [now] = useState(() => new Date().toISOString());
  const query = toQuery({ vehicleId, from: period === 'a-venir' ? now : undefined, order: period === 'a-venir' ? 'asc' : 'desc', page, pageSize: 10 });
  const reservations = useQuery({ queryKey: ['reservations', 'vehicle', vehicleId, query], queryFn: () => api<Page<ReservationView>>(`/reservations${query}`) });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Période" className="inline-flex flex-wrap rounded-md border p-0.5">
          {(Object.keys(PERIODS) as Period[]).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'default' : 'ghost'}
              aria-pressed={period === p}
              onClick={() => {
                setPeriod(p);
                setPage(1);
              }}
            >
              {PERIODS[p].label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/planning?vehicule=${encodeURIComponent(vehicleId)}`}>
              <CalendarDays className="size-4" aria-hidden="true" /> Ouvrir le planning du véhicule
            </Link>
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {PERIODS[period].hint}. Consultation seule : les réservations se créent, se modifient et s’annulent depuis le planning. Créneaux [début, fin[ ; heures du fuseau de l’organisation.
      </p>

      {reservations.isPending ? (
        <LoadingState label="Chargement des réservations…" />
      ) : reservations.isError ? (
        <ErrorState error={reservations.error} retry={() => void reservations.refetch()} />
      ) : reservations.data.total === 0 ? (
        <EmptyState
          title={period === 'a-venir' ? 'Aucune réservation à venir' : 'Aucune réservation'}
          description={period === 'a-venir' ? 'Aucun créneau en cours ou futur n’est réservé pour ce véhicule.' : 'Aucune réservation n’a été enregistrée pour ce véhicule dans votre périmètre.'}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Créneau</TableHead>
                <TableHead>Conducteur</TableHead>
                <TableHead>Motif</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>
                  <span className="sr-only">Détail</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{formatSlot(r.startAt, r.endAt, session.timezone)}</TableCell>
                  <TableCell>
                    <Link href={`/conducteurs/${r.driverId}`} className="underline-offset-4 hover:underline">
                      {r.driverName}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    {r.purpose}
                    {r.destination ? <span className="block text-xs text-muted-foreground">{r.destination}</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <StatusBadge label={reservationStatusLabel(r.status)} tone={toneForReservation(r.status)} />
                    {r.cancelReason ? <span className="mt-1 block text-xs text-muted-foreground">Motif : {r.cancelReason}</span> : null}
                    {r.convertedUsageId ? (
                      <Link href={`/utilisations/${r.convertedUsageId}`} className="mt-1 block text-xs underline underline-offset-4">
                        Voir l’utilisation
                      </Link>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Link href={`/planning/reservations?vehicule=${encodeURIComponent(vehicleId)}&reservation=${encodeURIComponent(r.id)}`} className="underline-offset-4 hover:underline">
                      Ouvrir<span className="sr-only"> la réservation du {formatSlot(r.startAt, r.endAt, session.timezone)}</span>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={reservations.data.page} pageSize={reservations.data.pageSize} total={reservations.data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
