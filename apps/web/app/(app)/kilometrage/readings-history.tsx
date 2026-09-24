'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { READING_SOURCE_LABELS, READING_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import {
  CorrectReadingDialog,
  ReadingDecisionDialog,
  type ReadingDecision,
} from '@/components/odometer/reading-dialogs';
import { ReadingsTable } from '@/components/odometer/readings-table';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { ReadingView } from '@/lib/odometer-types';
import { useListParams } from '@/lib/use-list-params';

const ALL = '__all__';

/** Historique des relevés du périmètre (tous statuts), filtres persistants dans l'URL. */
export function ReadingsHistory() {
  const { companyId } = useAppScope();
  const { get, set, page } = useListParams();
  const status = get('statut');
  const source = get('source');
  const vehicleId = get('vehicule');
  const [decision, setDecision] = useState<ReadingDecision>(null);
  const [correcting, setCorrecting] = useState<ReadingView | null>(null);
  // L'onglet est fixé explicitement : sans lui, le filtre « En attente » ferait basculer vers la file de validation.
  const setFilters = (updates: Record<string, string | number>) =>
    set({ ...updates, onglet: 'historique' });

  const query = toQuery({
    companyId,
    status,
    source,
    vehicleId,
    page,
    pageSize: 25,
    order: 'desc',
  });
  const readings = useQuery({
    queryKey: ['readings', query],
    queryFn: () => api<Page<ReadingView>>(`/readings${query}`),
  });
  const hasFilters = Boolean(status || source || vehicleId);

  return (
    <div className="space-y-4">
      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        role="search"
        aria-label="Filtres de l’historique des relevés"
      >
        <div className="space-y-1">
          <Label htmlFor="history-status">Statut</Label>
          <Select
            value={status || ALL}
            onValueChange={(v) => setFilters({ statut: v === ALL ? '' : v })}
          >
            <SelectTrigger id="history-status" className="w-full">
              <SelectValue placeholder="Statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les statuts</SelectItem>
              {Object.entries(READING_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-source">Source</Label>
          <Select
            value={source || ALL}
            onValueChange={(v) => setFilters({ source: v === ALL ? '' : v })}
          >
            <SelectTrigger id="history-source" className="w-full">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les sources</SelectItem>
              {Object.entries(READING_SOURCE_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-vehicle">Véhicule</Label>
          <VehicleFilter
            id="history-vehicle"
            vehicleId={vehicleId}
            onChange={(id) => setFilters({ vehicule: id })}
          />
        </div>
        {hasFilters ? (
          <div className="flex items-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setFilters({ statut: '', source: '', vehicule: '' })}
            >
              Réinitialiser les filtres
            </Button>
          </div>
        ) : null}
      </div>

      {readings.isPending ? (
        <LoadingState label="Chargement de l’historique…" />
      ) : readings.isError ? (
        <ErrorState error={readings.error} retry={() => void readings.refetch()} />
      ) : readings.data.total === 0 ? (
        <EmptyState
          title="Aucun relevé"
          description={
            hasFilters
              ? 'Aucun relevé ne correspond aux filtres.'
              : 'Aucun relevé enregistré dans votre périmètre.'
          }
        />
      ) : (
        <div className="rounded-md border">
          <ReadingsTable
            caption="Historique des relevés"
            items={readings.data.items}
            showVehicle
            onDecide={setDecision}
            onCorrect={setCorrecting}
          />
          <PaginationControls
            page={readings.data.page}
            pageSize={readings.data.pageSize}
            total={readings.data.total}
            onPageChange={(p) => setFilters({ page: p })}
          />
        </div>
      )}

      <ReadingDecisionDialog decision={decision} onClose={() => setDecision(null)} />
      <CorrectReadingDialog reading={correcting} onClose={() => setCorrecting(null)} />
    </div>
  );
}
