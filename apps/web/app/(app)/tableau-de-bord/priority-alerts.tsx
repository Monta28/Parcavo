'use client';

import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { AlertListItem } from './alert-list-item';
import type { AlertSummaryView, DashboardIndicator } from './dashboard-types';
import { IndicatorTile, IndicatorTileSkeleton } from './indicator-tile';

const SHOWN = 5;

interface PriorityAlertsProps {
  companyId: string | null;
  /** Véhicule filtré (11.1) : même filtre que les compteurs du tableau de bord. */
  vehicleId?: string | null;
  /** Compteurs par gravité du tableau de bord (groupe « alertes ») ; vide pendant le chargement ou en cas d'erreur. */
  indicators: DashboardIndicator[];
  loading: boolean;
  timezone: string;
  currencyDecimals: number;
}

/**
 * Alertes prioritaires (CDC 10.2) : compteurs par gravité calculés par GET /dashboard, puis les alertes
 * actives les plus graves et les plus récentes (GET /alerts, mêmes filtres : actives, visibles pour le
 * rôle, hors reports de l'utilisateur ; tri gravité puis date fait par l'API).
 */
export function PriorityAlerts({ companyId, vehicleId = null, indicators, loading, timezone, currencyDecimals }: PriorityAlertsProps) {
  const query = toQuery({ companyId, vehicleId, status: 'ACTIVE', snoozed: 'exclude', page: 1, pageSize: SHOWN });
  const alerts = useQuery({ queryKey: ['alerts', query], queryFn: () => api<Page<AlertSummaryView>>(`/alerts${query}`) });

  return (
    <Card className="gap-4" role="region" aria-labelledby="alertes-prioritaires">
      <CardHeader>
        <CardTitle className="text-base">
          <h2 id="alertes-prioritaires">Alertes prioritaires</h2>
        </CardTitle>
        <CardDescription>Alertes actives visibles pour votre rôle, hors celles que vous avez reportées, de la plus grave à la plus récente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <IndicatorTileSkeleton key={i} />
            ))}
          </div>
        ) : indicators.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {indicators.map((indicator) => (
              <IndicatorTile key={indicator.key} indicator={indicator} timezone={timezone} currencyDecimals={currencyDecimals} compact />
            ))}
          </div>
        ) : null}

        {alerts.isPending ? (
          <LoadingState label="Chargement des alertes…" />
        ) : alerts.isError ? (
          <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />
        ) : alerts.data.total === 0 ? (
          <EmptyState title="Aucune alerte active" description="Aucune alerte active ne vous concerne dans ce périmètre." />
        ) : (
          <div className="space-y-2">
            <ul className="divide-y rounded-md border">
              {alerts.data.items.map((a) => (
                <AlertListItem key={a.id} alert={a} timezone={timezone} showCompany={companyId === null} />
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              {alerts.data.items.length} {alerts.data.items.length <= 1 ? 'affichée' : 'affichées'} sur {alerts.data.total} {alerts.data.total <= 1 ? 'alerte active' : 'alertes actives'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
