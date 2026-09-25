'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { SyncDialog } from '@/components/telemetry/sync-dialog';
import { ProviderStatusBadge, ProviderSyncState, SimulatorBadge, SimulatorNotice, SyncRunsTable, useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { CompanyTelemetryView, DiscoveryResult, ProviderView } from '@/lib/telemetry-types';
import { useManagedCompanies } from './mapping-fields';

/**
 * État de synchronisation des sociétés du périmètre (CDC 14.4, 14.6 ; D-100, D-112, D-296, D-297) :
 * module par société, état de chaque fournisseur (dernière réussite, échecs, coupe-circuit, erreur
 * expurgée) et exécutions. Synchronisation manuelle et découverte pour le chef de parc des sociétés
 * couvertes ; aucune configuration ni secret n'est visible ici.
 */
export function SyncTab() {
  const { companyId } = useAppScope();
  const companyCode = useCompanyCodes();
  const { managedIds } = useManagedCompanies();
  const companies = useQuery({ queryKey: ['telemetry', 'companies'], queryFn: () => api<CompanyTelemetryView[]>('/telemetry/companies') });
  const providers = useQuery({ queryKey: ['telemetry', 'providers', 'scope', companyId], queryFn: () => api<Page<ProviderView>>(`/telemetry/providers${toQuery({ companyId, pageSize: 100 })}`) });
  const [syncing, setSyncing] = useState<ProviderView | null>(null);
  const visibleCompanies = (companies.data ?? []).filter((c) => !companyId || c.companyId === companyId);
  const enabledIds = new Set(visibleCompanies.filter((c) => c.telemetryEnabled).map((c) => c.companyId));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Module télématique par société</CardTitle>
          <CardDescription>L’activation est décidée par l’administrateur. Sans activation, aucune donnée n’est lue et le kilométrage reste entièrement manuel.</CardDescription>
        </CardHeader>
        <CardContent>
          {companies.isPending ? (
            <LoadingState />
          ) : companies.isError ? (
            <ErrorState error={companies.error} retry={() => void companies.refetch()} />
          ) : visibleCompanies.length === 0 ? (
            <EmptyState title="Aucune société" />
          ) : (
            <ul className="divide-y rounded-md border">
              {visibleCompanies.map((c) => (
                <li key={c.companyId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <span className="font-medium">{c.code}</span> — {c.legalName}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge label={c.telemetryEnabled ? 'Module activé' : 'Module désactivé'} tone={c.telemetryEnabled ? 'info' : 'neutral'} />
                    <span className="text-muted-foreground">{c.providers.length === 0 ? 'Aucun fournisseur' : c.providers.map((p) => p.name).join(', ')}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="providers-title" className="space-y-3">
        <h2 id="providers-title" className="text-base font-semibold">
          Fournisseurs
        </h2>
        {providers.isPending ? (
          <LoadingState />
        ) : providers.isError ? (
          <ErrorState error={providers.error} retry={() => void providers.refetch()} />
        ) : providers.data.total === 0 ? (
          <EmptyState title="Aucun fournisseur" description="Aucun fournisseur télématique ne couvre vos sociétés : le kilométrage reste saisi manuellement." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {providers.data.items.map((p) => {
              const syncable = p.companyIds.filter((c) => managedIds.includes(c) && enabledIds.has(c));
              return (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  coveredLabel={p.companyIds.map(companyCode).join(', ') || '—'}
                  canSync={p.status === 'ACTIF' && syncable.length > 0}
                  canDiscover={p.status === 'ACTIF' && syncable.length > 0}
                  onSync={() => setSyncing({ ...p, companyIds: syncable })}
                />
              );
            })}
          </div>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exécutions</CardTitle>
          <CardDescription>Synchronisations et découvertes des sociétés de votre périmètre ; les erreurs sont expurgées.</CardDescription>
        </CardHeader>
        <CardContent>
          <SyncRunsTable providers={providers.data?.items ?? []} companyId={companyId} />
        </CardContent>
      </Card>

      {syncing ? <SyncDialog provider={syncing} allowReprise={false} onClose={() => setSyncing(null)} /> : null}
    </div>
  );
}

function ProviderCard({ provider, coveredLabel, canSync, canDiscover, onSync }: { provider: ProviderView; coveredLabel: string; canSync: boolean; canDiscover: boolean; onSync: () => void }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const discover = useMutation({
    mutationFn: () => api<DiscoveryResult>(`/telemetry/providers/${provider.id}/discover`, { method: 'POST' }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Découverte terminée : ${r.proposalsCreated} proposition(s) créée(s), ${r.proposalsPending} à confirmer.`);
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Découverte impossible.');
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {provider.name} <ProviderStatusBadge status={provider.status} />
          {provider.isSimulator ? <SimulatorBadge /> : null}
        </CardTitle>
        <CardDescription>
          {provider.kindLabel} · sociétés couvertes : {coveredLabel}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {provider.isSimulator ? <SimulatorNotice notice={provider.notice} /> : null}
        <ProviderSyncState provider={provider} />
        {provider.channel === 'WEBHOOK' ? <p className="text-sm text-muted-foreground">Données poussées par le fournisseur (webhook signé) : chaque lot reçu est ingéré automatiquement, sans synchronisation manuelle.</p> : null}
        {canSync || canDiscover ? (
          <div className="flex flex-wrap gap-2">
            {canSync && provider.channel !== 'WEBHOOK' ? (
              <Button variant="outline" size="sm" onClick={onSync}>
                <RefreshCw className="size-4" /> Synchroniser maintenant
              </Button>
            ) : null}
            {canDiscover ? (
              <Button variant="outline" size="sm" disabled={discover.isPending} onClick={() => discover.mutate()}>
                <Search className="size-4" /> {discover.isPending ? 'Découverte…' : 'Découvrir les unités'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {result ? (
          <p role="status" className="rounded-md border p-2 text-sm">
            {result.unitsSeen} unité(s) vue(s) ; {result.proposalsCreated} proposition(s) créée(s), {result.proposalsPending} à confirmer, {result.unmapped} non associée(s){result.ignored > 0 ? `, ${result.ignored} ignorée(s)` : ''}. Aucun relevé avant confirmation.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
