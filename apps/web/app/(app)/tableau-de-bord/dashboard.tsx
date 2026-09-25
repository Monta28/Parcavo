'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, ClipboardList, Gauge, List, RefreshCw, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/use-list-params';
import type { DashboardIndicator, DashboardView, IndicatorGroup } from './dashboard-types';
import { ExpectedReturns } from './expected-returns';
import { IndicatorTile, IndicatorTileSkeleton } from './indicator-tile';
import { PeriodFilter } from './period-filter';
import { PriorityAlerts } from './priority-alerts';

/** Sections de tuiles, par groupe d'indicateurs renvoyé par l'API (ordre des tuiles : celui de l'API). */
const SECTIONS: ReadonlyArray<{ id: string; title: string; groups: readonly IndicatorGroup[]; skeletons: number }> = [
  { id: 'etat-parc', title: 'État du parc', groups: ['parc'], skeletons: 5 },
  { id: 'vigilance', title: 'Points de vigilance', groups: ['entretiens', 'documents', 'kilometrage'], skeletons: 5 },
  { id: 'activite', title: 'Activité de la période', groups: ['interventions', 'couts'], skeletons: 2 },
];
/** Groupes affichés dans leur propre carte (compteurs et liste). */
const CARD_GROUPS: readonly IndicatorGroup[] = ['alertes', 'utilisations'];
const RETURN_DUE_KEY = 'usages.returnDue';

export function Dashboard() {
  const { session } = useAppScope();
  const router = useRouter();
  const isDriverOnly = session.isDriverOnly;

  useEffect(() => {
    if (isDriverOnly) router.replace('/mon-vehicule');
  }, [isDriverOnly, router]);

  if (isDriverOnly) return <LoadingState label="Redirection vers Mon véhicule…" />;
  return <StaffDashboard />;
}

/**
 * Tableau de bord (CDC 10.2, 11.1 ; D-269) : tout vient de GET /dashboard (états instantanés horodatés,
 * flux sur la période du/au conservée dans l'URL, mois civil en cours par défaut) ; aucun calcul ici.
 * La société courante et le véhicule (paramètre « vehicule » de l'URL) sont de simples filtres : le
 * périmètre est recalculé par l'API, qui répond 404 pour un véhicule hors périmètre.
 */
function StaffDashboard() {
  const { session, companyId } = useAppScope();
  const queryClient = useQueryClient();
  const { get, set } = useListParams();
  const from = get('du');
  const to = get('au');
  const vehicleId = get('vehicule');
  const query = toQuery({ companyId, vehicleId, from, to });
  const dashboard = useQuery({ queryKey: ['dashboard', query], queryFn: () => api<DashboardView>(`/dashboard${query}`) });
  const data = dashboard.data;
  const company = companyId ? session.companies.find((c) => c.id === companyId) : undefined;
  const companyLabel = company ? `Société ${company.code} · ${company.name}` : 'Toutes les sociétés de votre périmètre';
  const scopeLabel = vehicleId ? `${companyLabel} · un seul véhicule` : companyLabel;
  const timezone = data?.timezone ?? session.timezone;
  const fieldErrors = isApiError(dashboard.error) ? dashboard.error.fieldErrors : undefined;
  const indicators = data?.indicators ?? [];
  const topLevel = indicators.filter((i) => i.parentKey === null);
  const childrenOf = (key: string) => indicators.filter((i) => i.parentKey === key);
  const returnDue = topLevel.find((i) => i.key === RETURN_DUE_KEY);
  const known = new Set<IndicatorGroup>([...SECTIONS.flatMap((s) => s.groups), ...CARD_GROUPS]);
  const others = topLevel.filter((i) => !known.has(i.group) || (i.group === 'utilisations' && i.key !== RETURN_DUE_KEY));
  const tileProps = { timezone, currencyDecimals: session.currencyDecimals };
  const renderTile = (indicator: DashboardIndicator) => <IndicatorTile key={indicator.key} indicator={indicator} items={childrenOf(indicator.key)} {...tileProps} />;

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={scopeLabel}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              for (const key of ['dashboard', 'usages', 'alerts', 'vehicles', 'expenses']) void queryClient.invalidateQueries({ queryKey: [key] });
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Actualiser
          </Button>
        }
      />

      <section aria-labelledby="filtre-vehicule-titre" className="mb-4 flex flex-col gap-2 rounded-lg border p-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h2 id="filtre-vehicule-titre" className="text-sm font-semibold">
            Véhicule
          </h2>
          <p className="text-sm text-muted-foreground">
            {vehicleId ? 'Tous les indicateurs, compteurs et listes justificatives portent sur ce seul véhicule.' : 'Tous les véhicules du périmètre ; choisissez-en un pour ses seuls indicateurs.'}
          </p>
        </div>
        <div className="w-full space-y-1.5 lg:w-80">
          <Label htmlFor="filtre-vehicule">Filtrer sur un véhicule</Label>
          <VehicleFilter id="filtre-vehicule" vehicleId={vehicleId} onChange={(id) => set({ vehicule: id })} />
        </div>
      </section>

      <section aria-labelledby="periode-flux" className="mb-8 flex flex-col gap-4 rounded-lg border p-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h2 id="periode-flux" className="text-sm font-semibold">
            Période des flux
          </h2>
          {data ? (
            <p className="text-sm text-muted-foreground">
              Du {formatDate(data.period.from)} au {formatDate(data.period.to)}
              {data.periodIsDefault ? ' (mois civil en cours)' : ''}, dates incluses. États instantanés au {formatDateTime(data.asOf, timezone)} (fuseau {data.timezone}).
            </p>
          ) : dashboard.isPending ? (
            <Skeleton className="h-5 w-72" />
          ) : (
            <p className="text-sm text-muted-foreground">Indiquez les deux bornes de la période, ou revenez au mois civil en cours.</p>
          )}
        </div>
        <PeriodFilter
          key={`${from}|${to}|${data?.period.from ?? ''}|${data?.period.to ?? ''}`}
          initialFrom={from || data?.period.from || ''}
          initialTo={to || data?.period.to || ''}
          custom={Boolean(from || to)}
          errors={fieldErrors}
          onApply={(du, au) => set({ du, au })}
          onReset={() => set({ du: '', au: '' })}
        />
      </section>

      <div className="space-y-8">
        {dashboard.isPending ? (
          SECTIONS.map((section) => (
            <section key={section.id} aria-labelledby={section.id} aria-busy="true">
              <h2 id={section.id} className="mb-3 text-lg font-semibold">
                {section.title}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {Array.from({ length: section.skeletons }, (_, i) => (
                  <IndicatorTileSkeleton key={i} />
                ))}
              </div>
              <span className="sr-only">Chargement des indicateurs…</span>
            </section>
          ))
        ) : dashboard.isError ? (
          <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
        ) : indicators.length === 0 && data?.omitted.length === 0 ? (
          <EmptyState title="Aucun indicateur" description="L’API ne renvoie aucun indicateur pour ce périmètre." />
        ) : (
          <>
            {SECTIONS.map((section) => {
              const tiles = topLevel.filter((i) => section.groups.includes(i.group));
              const omitted = section.id === 'activite' ? (data?.omitted ?? []) : [];
              if (tiles.length === 0 && omitted.length === 0) return null;
              return (
                <section key={section.id} aria-labelledby={section.id}>
                  <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                    <h2 id={section.id} className="text-lg font-semibold">
                      {section.title}
                    </h2>
                    {section.id === 'etat-parc' ? (
                      <Link href="/vehicules" className="text-sm font-medium underline-offset-4 hover:underline">
                        Voir tout le parc
                      </Link>
                    ) : null}
                  </div>
                  {tiles.length > 0 ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{tiles.map(renderTile)}</div> : null}
                  {omitted.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                      {omitted.map((o) => (
                        <li key={o.key}>
                          <span className="font-medium text-foreground">{o.label} non affichés</span> : {o.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            })}
            {others.length > 0 ? (
              <section aria-labelledby="autres-indicateurs">
                <h2 id="autres-indicateurs" className="mb-3 text-lg font-semibold">
                  Autres indicateurs
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{others.map(renderTile)}</div>
              </section>
            ) : null}
          </>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <PriorityAlerts companyId={companyId} vehicleId={vehicleId || null} indicators={topLevel.filter((i) => i.group === 'alertes')} loading={dashboard.isPending} {...tileProps} />
            <ExpectedReturns
              key={`${companyId ?? 'toutes'}|${vehicleId}`}
              companyId={companyId}
              vehicleId={vehicleId || null}
              indicator={returnDue}
              items={returnDue ? childrenOf(returnDue.key) : []}
              loading={dashboard.isPending}
              {...tileProps}
            />
          </div>
          <QuickActions companyId={companyId} />
        </div>
      </div>
    </div>
  );
}

function QuickActions({ companyId }: { companyId: string | null }) {
  const { session } = useAppScope();
  const role = useRoleIn(companyId);
  const canCreate = session.isAdmin || role === 'CHEF_PARC' || role === 'OPERATEUR' || (companyId === null && session.grants.some((g) => g.role === 'CHEF_PARC' || g.role === 'OPERATEUR'));

  return (
    <Card className="gap-4 self-start">
      <CardHeader>
        <CardTitle className="text-base">
          <h2>Actions rapides</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {canCreate ? (
            <>
              <li>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link href="/utilisations/nouvelle">
                    <ClipboardList className="size-4" aria-hidden="true" /> Nouvelle remise
                  </Link>
                </Button>
              </li>
              <li>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link href="/kilometrage">
                    <Gauge className="size-4" aria-hidden="true" /> Saisir des relevés
                  </Link>
                </Button>
              </li>
              <li>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link href="/vehicules/nouveau">
                    <Car className="size-4" aria-hidden="true" /> Nouveau véhicule
                  </Link>
                </Button>
              </li>
              <li>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link href="/conducteurs/nouveau">
                    <UserPlus className="size-4" aria-hidden="true" /> Nouveau conducteur
                  </Link>
                </Button>
              </li>
            </>
          ) : null}
          <li>
            <Button variant="outline" className="w-full justify-start" asChild>
              <Link href="/vehicules">
                <List className="size-4" aria-hidden="true" /> Rechercher un véhicule
              </Link>
            </Button>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
