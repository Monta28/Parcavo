'use client';

import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { FUEL_MEASURE_KIND_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import {
  PROVIDER_STATUS_LABELS,
  SIMULATOR_LABEL,
  SYNC_RUN_STATUS_LABELS,
  SYNC_TRIGGER_LABELS,
  type FuelKind,
  type ProviderStatus,
  type ProviderView,
  type SyncRunStatus,
  type SyncRunView,
} from '@/lib/telemetry-types';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const ALL = '__all__';

/** Mention obligatoire du simulateur (D-303) : jamais une donnée réelle. */
export function SimulatorBadge({ className }: { className?: string }) {
  return <StatusBadge label={SIMULATOR_LABEL} tone="warning" className={className} />;
}

export function SimulatorNotice({ notice }: { notice?: string | null }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">{SIMULATOR_LABEL}.</span> {notice ?? 'Aucune donnée issue de ce fournisseur ne correspond à un véhicule réel. Impossible à activer en production.'}
      </p>
    </div>
  );
}

function toneForProvider(status: ProviderStatus): Tone {
  switch (status) {
    case 'ACTIF':
      return 'success';
    case 'SUSPENDU':
      return 'warning';
    case 'DESACTIVE':
      return 'neutral';
    default:
      return 'info';
  }
}

export function ProviderStatusBadge({ status }: { status: ProviderStatus }) {
  return <StatusBadge label={PROVIDER_STATUS_LABELS[status]} tone={toneForProvider(status)} />;
}

function toneForRun(status: SyncRunStatus): Tone {
  switch (status) {
    case 'SUCCES':
      return 'success';
    case 'PARTIEL':
      return 'warning';
    case 'ECHEC':
      return 'danger';
    case 'EN_COURS':
      return 'info';
    default:
      return 'neutral';
  }
}

export function SyncRunStatusBadge({ status }: { status: SyncRunStatus }) {
  return <StatusBadge label={SYNC_RUN_STATUS_LABELS[status]} tone={toneForRun(status)} />;
}

export function fuelKindsLabel(kinds: readonly FuelKind[]): string {
  return kinds.length === 0 ? 'Aucun carburant' : kinds.map((k) => FUEL_MEASURE_KIND_LABELS[k]).join(', ');
}

/** Codes des sociétés (session) pour l'affichage. */
export function useCompanyCodes(): (id: string | null | undefined) => string {
  const { session } = useAppScope();
  return (id) => (id ? (session.companies.find((c) => c.id === id)?.code ?? '—') : '—');
}

/**
 * Appels au fournisseur suspendus (coupe-circuit ouvert ou report de quota, D-297) : l'API fournit
 * l'échéance circuitOpenUntil, seule comparée ici à l'instant d'affichage (figé au montage, relu à
 * chaque rechargement des données).
 */
export function useCallsSuspended(until: string | null): boolean {
  const [now] = useState(() => Date.now());
  return until !== null && new Date(until).getTime() > now;
}

/** Pourcentage fourni par l'API (décimal exact en texte), affiché à une décimale au plus. */
export function formatPercentValue(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n)} %` : null;
}

/**
 * État de synchronisation d'un fournisseur tel que tenu par l'API (D-100, D-297) : dernière exécution,
 * dernière réussite, échecs consécutifs, coupe-circuit et dernière erreur expurgée.
 */
export function ProviderSyncState({ provider }: { provider: ProviderView }) {
  const { session } = useAppScope();
  const tz = session.timezone;
  const circuitOpen = useCallsSuspended(provider.circuitOpenUntil);
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Dernière synchronisation</dt>
        <dd>{formatDateTime(provider.lastSyncAt, tz)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Dernière réussite</dt>
        <dd>{provider.lastSuccessAt ? formatDateTime(provider.lastSuccessAt, tz) : 'Aucune'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Échecs consécutifs</dt>
        <dd>{provider.consecutiveFailures > 0 ? <StatusBadge label={String(provider.consecutiveFailures)} tone="warning" /> : '0'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Coupe-circuit ou report de quota</dt>
        <dd>{circuitOpen ? <StatusBadge label={`Appels suspendus jusqu’au ${formatDateTime(provider.circuitOpenUntil, tz)}`} tone="danger" /> : 'Aucune suspension'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Intervalle de synchronisation</dt>
        <dd>{provider.syncIntervalMinutes} min</dd>
      </div>
      {provider.lastErrorSummary ? (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Dernière erreur (expurgée)</dt>
          <dd className="break-words text-destructive">{provider.lastErrorSummary}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * Exécutions de synchronisation et de découverte (GET /telemetry/sync-runs, périmètre du lecteur).
 * Rafraîchies tant qu'une exécution est en cours (état des runs, jamais un suivi des véhicules).
 */
export function SyncRunsTable({
  providers,
  companyId,
  fixedProviderId,
  pageSize = 10,
}: {
  providers: readonly Pick<ProviderView, 'id' | 'name'>[];
  companyId: string | null;
  /** Table limitée à un fournisseur (fiche du fournisseur) : pas de filtre de fournisseur. */
  fixedProviderId?: string;
  pageSize?: number;
}) {
  const { session } = useAppScope();
  const companyCode = useCompanyCodes();
  const [filters, setFilters] = useFilters();
  const query = toQuery({ companyId, providerId: fixedProviderId ?? filters.providerId, status: filters.status, page: filters.page, pageSize });
  const runs = useQuery({
    queryKey: ['telemetry', 'sync-runs', query],
    queryFn: () => api<Page<SyncRunView>>(`/telemetry/sync-runs${query}`),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'EN_COURS') ? 5000 : false),
  });

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fixedProviderId ? null : (
          <Select value={filters.providerId || ALL} onValueChange={(v) => setFilters({ providerId: v === ALL ? '' : v, page: 1 })}>
            <SelectTrigger aria-label="Fournisseur">
              <SelectValue placeholder="Fournisseur" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les fournisseurs</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={filters.status || ALL} onValueChange={(v) => setFilters({ status: v === ALL ? '' : v, page: 1 })}>
          <SelectTrigger aria-label="Résultat">
            <SelectValue placeholder="Résultat" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les résultats</SelectItem>
            {Object.entries(SYNC_RUN_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {runs.isPending ? (
        <LoadingState />
      ) : runs.isError ? (
        <ErrorState error={runs.error} retry={() => void runs.refetch()} />
      ) : runs.data.total === 0 ? (
        <EmptyState title="Aucune exécution" description="Aucune synchronisation ni découverte n’a encore été tracée pour ces critères." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Début</TableHead>
                <TableHead>Fournisseur</TableHead>
                <TableHead>Société</TableHead>
                <TableHead>Déclencheur</TableHead>
                <TableHead>Résultat</TableHead>
                <TableHead className="hidden md:table-cell">Durée</TableHead>
                <TableHead className="hidden lg:table-cell">Volumes</TableHead>
                <TableHead>Erreurs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.startedAt, session.timezone)}</TableCell>
                  <TableCell className="whitespace-normal">{r.providerName}</TableCell>
                  <TableCell>{r.companyId ? companyCode(r.companyId) : <span className="text-muted-foreground">Découverte</span>}</TableCell>
                  <TableCell>{SYNC_TRIGGER_LABELS[r.trigger] ?? r.trigger}</TableCell>
                  <TableCell>
                    <SyncRunStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{r.durationMs !== null ? `${(r.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : '—'}</TableCell>
                  <TableCell className="hidden whitespace-normal text-xs lg:table-cell">
                    {r.companyId ? (
                      <>
                        {r.odometerSamples} échantillon(s) km, {r.readingsCreated} relevé(s), {r.readingsPending} en attente, {r.duplicatesIgnored} doublon(s) ; {r.fuelSamples} échantillon(s) carburant, {r.fuelEventsCreated} événement(s)
                      </>
                    ) : (
                      <>{r.unitsSeen} unité(s) vue(s)</>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-xs">
                    {r.errorCount > 0 || r.errorSummary ? (
                      <>
                        <span className="font-medium">{r.errorCount}</span>
                        {r.errorSummary ? <span className="block break-words text-muted-foreground">{r.errorSummary}</span> : null}
                      </>
                    ) : (
                      '0'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={runs.data.page} pageSize={runs.data.pageSize} total={runs.data.total} onPageChange={(p) => setFilters({ page: p })} />
        </div>
      )}
    </div>
  );
}

interface RunFilters {
  providerId: string;
  status: string;
  page: number;
}

/** Filtres locaux de la table des exécutions (la page hôte garde ses propres paramètres d'URL). */
function useFilters(): [RunFilters, (patch: Partial<RunFilters>) => void] {
  const [filters, set] = useState<RunFilters>({ providerId: '', status: '', page: 1 });
  return [filters, (patch) => set((f) => ({ ...f, ...patch }))];
}
