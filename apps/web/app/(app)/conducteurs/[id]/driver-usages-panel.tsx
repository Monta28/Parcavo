'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { DISTANCE_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DriverUsageView } from '@/lib/drivers-types';
import { formatDateTime, formatKm } from '@/lib/format';

/** Historique des utilisations du conducteur (GET /usages?driverId=), selon les droits du lecteur. */
export function DriverUsagesPanel({ driverId }: { driverId: string }) {
  const session = useSession();
  const [page, setPage] = useState(1);
  const query = toQuery({ driverId, page, pageSize: 10 });
  const usages = useQuery({ queryKey: ['usages', 'driver', driverId, query], queryFn: () => api<Page<DriverUsageView>>(`/usages${query}`) });

  if (usages.isPending) return <LoadingState label="Chargement des utilisations…" />;
  if (usages.isError) return <ErrorState error={usages.error} retry={() => void usages.refetch()} />;
  if (usages.data.total === 0) return <EmptyState title="Aucune utilisation" description="Aucune utilisation n’est enregistrée pour ce conducteur dans votre périmètre." />;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Véhicule</TableHead>
            <TableHead>Statut</TableHead>
            <TableHead>Remise</TableHead>
            <TableHead>Retour prévu</TableHead>
            <TableHead>Retour effectif</TableHead>
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
                <Link href={`/vehicules/${u.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                  {u.vehicleCode}
                </Link>
                <span className="block text-xs text-muted-foreground">{u.vehicleRegistration}</span>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge label={USAGE_STATUS_LABELS[u.status] ?? u.status} tone={u.status === 'EN_COURS' ? 'info' : 'neutral'} />
                  {u.isLate ? <StatusBadge label="En retard" tone="danger" /> : null}
                </div>
              </TableCell>
              <TableCell>{formatDateTime(u.checkedOutAt, session.timezone)}</TableCell>
              <TableCell>{formatDateTime(u.expectedReturnAt, session.timezone)}</TableCell>
              <TableCell>{formatDateTime(u.returnedAt, session.timezone)}</TableCell>
              <TableCell>
                {formatKm(u.distanceKm)}
                <span className="block text-xs text-muted-foreground">{DISTANCE_STATUS_LABELS[u.distanceStatus] ?? u.distanceStatus}</span>
              </TableCell>
              <TableCell>
                <Link href={`/utilisations/${u.id}`} className="underline-offset-4 hover:underline">
                  Ouvrir<span className="sr-only"> l’utilisation {u.vehicleCode} du {formatDateTime(u.checkedOutAt, session.timezone)}</span>
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationControls page={usages.data.page} pageSize={usages.data.pageSize} total={usages.data.total} onPageChange={setPage} />
    </div>
  );
}
