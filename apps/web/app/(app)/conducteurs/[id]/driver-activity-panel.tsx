'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS, READING_CONTEXT_LABELS, READING_STATUS_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { IncidentView } from '@/lib/incidents-types';
import type { ReadingView } from '@/lib/odometer-types';

type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

const READING_TONES: Record<string, Tone> = { ACCEPTE: 'success', EN_ATTENTE: 'warning', REJETE: 'danger', REMPLACE: 'neutral' };
const INCIDENT_TONES: Record<string, Tone> = { OUVERT: 'danger', EN_TRAITEMENT: 'warning', RESOLU: 'info', CLOTURE: 'neutral' };

/**
 * Incidents du conducteur (GET /incidents?driverId=) et relevés qu'il a soumis depuis son compte
 * (GET /readings?driverId=) — CDC 3.3 « afficher ses utilisations, incidents et soumissions, selon les droits » :
 * les deux listes sont filtrées par le serveur sur le périmètre de l'utilisateur.
 */
export function DriverActivityPanel({ driverId, hasAccount }: { driverId: string; hasAccount: boolean }) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="driver-incidents-title" className="space-y-2">
        <h2 id="driver-incidents-title" className="text-base font-semibold">
          Incidents
        </h2>
        <DriverIncidents driverId={driverId} />
      </section>
      <section aria-labelledby="driver-submissions-title" className="space-y-2">
        <h2 id="driver-submissions-title" className="text-base font-semibold">
          Relevés kilométriques soumis
        </h2>
        {hasAccount ? (
          <DriverReadings driverId={driverId} />
        ) : (
          <p className="text-sm text-muted-foreground">Ce conducteur n’a pas de compte utilisateur : il ne soumet aucun relevé lui-même.</p>
        )}
      </section>
    </div>
  );
}

function DriverIncidents({ driverId }: { driverId: string }) {
  const session = useSession();
  const [page, setPage] = useState(1);
  const query = toQuery({ driverId, page, pageSize: 10 });
  const incidents = useQuery({ queryKey: ['incidents', 'driver', driverId, query], queryFn: () => api<Page<IncidentView>>(`/incidents${query}`) });

  if (incidents.isPending) return <LoadingState label="Chargement des incidents…" />;
  if (incidents.isError) return <ErrorState error={incidents.error} retry={() => void incidents.refetch()} />;
  if (incidents.data.total === 0) return <EmptyState title="Aucun incident" description="Aucun incident n’est rattaché à ce conducteur dans votre périmètre." />;
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Référence</TableHead>
            <TableHead>Véhicule</TableHead>
            <TableHead>Type et gravité</TableHead>
            <TableHead>Survenu le</TableHead>
            <TableHead>Statut</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {incidents.data.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>
                <Link href={`/incidents/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                  {i.reference}
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/vehicules/${i.vehicleId}`} className="underline-offset-4 hover:underline">
                  {i.vehicleCode}
                </Link>
                <span className="block text-xs text-muted-foreground">{i.vehicleRegistration}</span>
              </TableCell>
              <TableCell>
                {INCIDENT_TYPE_LABELS[i.type] ?? i.type}
                <span className="block text-xs text-muted-foreground">Gravité : {INCIDENT_SEVERITY_LABELS[i.severity] ?? i.severity}</span>
              </TableCell>
              <TableCell>{formatDateTime(i.occurredAt, session.timezone)}</TableCell>
              <TableCell>
                <StatusBadge label={INCIDENT_STATUS_LABELS[i.status] ?? i.status} tone={INCIDENT_TONES[i.status] ?? 'neutral'} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationControls page={incidents.data.page} pageSize={incidents.data.pageSize} total={incidents.data.total} onPageChange={setPage} />
    </div>
  );
}

function DriverReadings({ driverId }: { driverId: string }) {
  const session = useSession();
  const [page, setPage] = useState(1);
  const query = toQuery({ driverId, page, pageSize: 10 });
  const readings = useQuery({ queryKey: ['readings', 'driver', driverId, query], queryFn: () => api<Page<ReadingView>>(`/readings${query}`) });

  if (readings.isPending) return <LoadingState label="Chargement des relevés soumis…" />;
  if (readings.isError) return <ErrorState error={readings.error} retry={() => void readings.refetch()} />;
  if (readings.data.total === 0) return <EmptyState title="Aucun relevé soumis" description="Aucun relevé saisi depuis le compte de ce conducteur dans votre périmètre." />;
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Véhicule</TableHead>
            <TableHead>Compteur</TableHead>
            <TableHead>Observé le</TableHead>
            <TableHead>Contexte</TableHead>
            <TableHead>Statut</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readings.data.items.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/vehicules/${r.vehicleId}?onglet=kilometrage`} className="font-medium underline-offset-4 hover:underline">
                  {r.vehicleCode}
                </Link>
              </TableCell>
              <TableCell>{formatKm(r.physicalKm)}</TableCell>
              <TableCell>{formatDateTime(r.observedAt, session.timezone)}</TableCell>
              <TableCell>{READING_CONTEXT_LABELS[r.context as keyof typeof READING_CONTEXT_LABELS] ?? r.context}</TableCell>
              <TableCell>
                <StatusBadge label={READING_STATUS_LABELS[r.status] ?? r.status} tone={READING_TONES[r.status] ?? 'neutral'} />
                {r.statusReason && r.status !== 'ACCEPTE' ? <span className="block text-xs text-muted-foreground">{r.statusReason}</span> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationControls page={readings.data.page} pageSize={readings.data.pageSize} total={readings.data.total} onPageChange={setPage} />
    </div>
  );
}
