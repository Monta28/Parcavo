'use client';

import { useQuery } from '@tanstack/react-query';
import { Satellite } from 'lucide-react';
import Link from 'next/link';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { FuelEventView } from '@/lib/telemetry-types';
import { cn } from '@/lib/utils';

/** Valeur « tous les statuts » de l'onglet Événements carburant de /telematique. */
const ALL_STATUSES = '__all__';

/** Onglet Événements carburant de /telematique, filtré sur un véhicule (tous statuts) ou sur le périmètre. */
export function vehicleFuelEventsPath(vehicleId: string | null): string {
  return `/telematique${toQuery({ onglet: 'carburant', ...(vehicleId ? { vehicule: vehicleId, statut: ALL_STATUSES } : {}) })}`;
}

/**
 * Renvoi des pages carburant vers les événements carburant télématiques (CDC 8.5 ; R-8.5-X01) : nombre
 * d'événements du véhicule (ou du périmètre) et de ceux restant à qualifier, lus dans l'API ; rien n'est
 * affiché sans événement (module F11 désactivé ou aucune détection), l'écran carburant restant complet.
 */
export function TelematicFuelEventsLink({ vehicleId, companyId = null, className }: { vehicleId: string | null; companyId?: string | null; className?: string }) {
  const scope = { vehicleId: vehicleId ?? undefined, companyId: vehicleId ? undefined : (companyId ?? undefined) };
  const allQuery = toQuery({ ...scope, pageSize: 1 });
  const pendingQuery = toQuery({ ...scope, status: 'A_QUALIFIER', pageSize: 1 });
  const all = useQuery({ queryKey: ['telemetry', 'fuel-events', allQuery], queryFn: () => api<Page<FuelEventView>>(`/telemetry/fuel-events${allQuery}`), retry: false });
  const pending = useQuery({ queryKey: ['telemetry', 'fuel-events', pendingQuery], queryFn: () => api<Page<FuelEventView>>(`/telemetry/fuel-events${pendingQuery}`), retry: false });
  const total = all.data?.total ?? 0;
  if (total === 0) return null;
  const toQualify = pending.data?.total ?? 0;
  return (
    <div role="note" className={cn('flex flex-col gap-1 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between', className)}>
      <p className="flex items-center gap-2">
        <Satellite className="size-4 shrink-0" aria-hidden="true" />
        <span>
          {vehicleId ? 'Événements carburant télématiques de ce véhicule' : 'Événements carburant télématiques du périmètre'} : {total}
          {toQualify > 0 ? `, dont ${toQualify} à qualifier` : ''}. Anomalies à qualifier, jamais des dépenses.
        </span>
      </p>
      <Link href={vehicleFuelEventsPath(vehicleId)} className="font-medium underline underline-offset-4">
        Voir les événements carburant
      </Link>
    </div>
  );
}
