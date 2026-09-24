'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { ReadingDecisionDialog, type ReadingDecision } from '@/components/odometer/reading-dialogs';
import { useScopeChecks } from '@/components/odometer/reading-helpers';
import { ReadingsTable } from '@/components/odometer/readings-table';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Label } from '@/components/ui/label';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { ReadingView } from '@/lib/odometer-types';
import { useListParams } from '@/lib/use-list-params';

/** File de validation (CDC 5.1, 5.2) : relevés EN_ATTENTE avec leur motif, du plus ancien au plus récent. */
export function PendingReadings() {
  const { companyId } = useAppScope();
  const { can } = useScopeChecks();
  const { get, set, page } = useListParams();
  const vehicleId = get('vehicule');
  const [decision, setDecision] = useState<ReadingDecision>(null);

  const query = toQuery({
    companyId,
    status: 'EN_ATTENTE',
    vehicleId,
    page,
    pageSize: 25,
    order: 'asc',
  });
  const readings = useQuery({
    queryKey: ['readings', query],
    queryFn: () => api<Page<ReadingView>>(`/readings${query}`),
  });

  return (
    <div className="space-y-4">
      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        role="search"
        aria-label="Filtres de la file de validation"
      >
        <div className="space-y-1">
          <Label htmlFor="pending-vehicle">Véhicule</Label>
          <VehicleFilter
            id="pending-vehicle"
            vehicleId={vehicleId}
            onChange={(id) => set({ vehicule: id, onglet: 'a-valider' })}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Le seuil de plausibilité est un filtre administratif paramétré par l’administrateur, pas une limite
        physique : une hausse qui le dépasse est mise en attente pour vérification et peut être validée si elle
        est réelle.
      </p>
      {!can(companyId, 'readings.approve') ? (
        <p className="text-sm text-muted-foreground">
          Consultation seule : la validation et le rejet requièrent la permission « Valider les
          relevés ».
        </p>
      ) : null}

      {readings.isPending ? (
        <LoadingState label="Chargement des relevés en attente…" />
      ) : readings.isError ? (
        <ErrorState error={readings.error} retry={() => void readings.refetch()} />
      ) : readings.data.total === 0 ? (
        <EmptyState
          title="Aucun relevé à valider"
          description={
            vehicleId
              ? 'Aucun relevé en attente pour ce véhicule.'
              : 'Aucun relevé en attente de validation dans votre périmètre.'
          }
        />
      ) : (
        <div className="rounded-md border">
          <ReadingsTable
            caption="Relevés en attente de validation"
            items={readings.data.items}
            showVehicle
            onDecide={setDecision}
          />
          <PaginationControls
            page={readings.data.page}
            pageSize={readings.data.pageSize}
            total={readings.data.total}
            onPageChange={(p) => set({ page: p, onglet: 'a-valider' })}
          />
        </div>
      )}

      <ReadingDecisionDialog decision={decision} onClose={() => setDecision(null)} />
    </div>
  );
}
