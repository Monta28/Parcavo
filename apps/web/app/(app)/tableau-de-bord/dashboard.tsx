'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, List, RefreshCw, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge, toneForOperational } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { VehicleView } from '@/lib/vehicles-types';

type Tone = Parameters<typeof StatusBadge>[0]['tone'];

interface CountFilter {
  operationalStatus?: NonNullable<VehicleView['operationalStatus']>;
  lifecycleStatus?: VehicleView['lifecycleStatus'];
}

/** Accord en nombre (0 et 1 au singulier, usage français). */
function plural(n: number, singular: string, pluralForm: string): string {
  return n <= 1 ? singular : pluralForm;
}

/** Total renvoyé par l'API pour un filtre de la liste des véhicules (sans includeInactive : cédés et archivés exclus). */
function useVehicleCount(companyId: string | null, filter: CountFilter) {
  const query = toQuery({ companyId, ...filter, pageSize: 1 });
  return useQuery({
    queryKey: ['vehicles', query],
    queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`),
    select: (page) => page.total,
  });
}

export function Dashboard() {
  const { session } = useAppScope();
  const router = useRouter();
  const isDriverOnly = session.isDriverOnly;

  const driverId = session.driverId;
  useEffect(() => {
    if (isDriverOnly && driverId) router.replace(`/conducteurs/${driverId}`);
  }, [isDriverOnly, driverId, router]);

  if (isDriverOnly) return <LoadingState label="Redirection vers votre fiche conducteur…" />;
  return <StaffDashboard />;
}

function StaffDashboard() {
  const { session, companyId } = useAppScope();
  const queryClient = useQueryClient();
  const company = companyId ? session.companies.find((c) => c.id === companyId) : undefined;
  const scopeLabel = company ? `Société ${company.code} · ${company.name}` : 'Toutes les sociétés de votre périmètre';

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={scopeLabel}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Actualiser
          </Button>
        }
      />
      <div className="space-y-8">
        <FleetIndicators companyId={companyId} />
        <div className="grid gap-4 lg:grid-cols-3">
          <QuickActions companyId={companyId} />
        </div>
      </div>
    </div>
  );
}

function FleetIndicators({ companyId }: { companyId: string | null }) {
  const fleet = useVehicleCount(companyId, {});
  const active = useVehicleCount(companyId, { lifecycleStatus: 'ACTIF' });
  const available = useVehicleCount(companyId, { operationalStatus: 'DISPONIBLE' });
  const inUse = useVehicleCount(companyId, { operationalStatus: 'EN_UTILISATION' });
  const immobilized = useVehicleCount(companyId, { operationalStatus: 'IMMOBILISE' });
  const outOfService = useVehicleCount(companyId, { lifecycleStatus: 'HORS_SERVICE' });
  const queries = [fleet, active, available, inUse, immobilized, outOfService];
  const failed = queries.find((q) => q.isError);
  const loading = queries.some((q) => q.isPending);

  const actifs = (n: number) => `${n} ${plural(n, 'véhicule actif', 'véhicules actifs')}`;
  const auParc = (n: number) => `${n} ${plural(n, 'véhicule', 'véhicules')} au parc`;

  return (
    <section aria-labelledby="indicateurs-parc">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="indicateurs-parc" className="text-lg font-semibold">
            Indicateurs du parc
          </h2>
          <p className="text-sm text-muted-foreground">Parc : véhicules actifs et hors service. Les véhicules cédés ou archivés ne sont pas comptés.</p>
        </div>
        <Link href="/vehicules" className="text-sm font-medium underline-offset-4 hover:underline">
          Voir tout le parc
        </Link>
      </div>
      {failed ? (
        <ErrorState
          error={failed.error}
          retry={() => {
            for (const q of queries) if (q.isError) void q.refetch();
          }}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-busy={loading}>
          <IndicatorTile
            label={VEHICLE_LIFECYCLE_LABELS.ACTIF}
            tone="success"
            value={active.data}
            total={fleet.data}
            describe={(n, total) => `${plural(n, 'actif', 'actifs')} sur ${auParc(total)}`}
            href="/vehicules?lifecycle=ACTIF"
            linkLabel="Voir les véhicules actifs"
          />
          <IndicatorTile
            label={VEHICLE_OPERATIONAL_STATUS_LABELS.DISPONIBLE}
            tone={toneForOperational('DISPONIBLE')}
            value={available.data}
            total={active.data}
            describe={(n, total) => `${plural(n, 'disponible', 'disponibles')} sur ${actifs(total)}`}
            href="/vehicules?statut=DISPONIBLE"
            linkLabel="Voir les véhicules disponibles"
          />
          <IndicatorTile
            label={VEHICLE_OPERATIONAL_STATUS_LABELS.EN_UTILISATION}
            tone={toneForOperational('EN_UTILISATION')}
            value={inUse.data}
            total={active.data}
            describe={(_n, total) => `en utilisation sur ${actifs(total)}`}
            href="/vehicules?statut=EN_UTILISATION"
            linkLabel="Voir les véhicules en utilisation"
          />
          <IndicatorTile
            label={VEHICLE_OPERATIONAL_STATUS_LABELS.IMMOBILISE}
            tone={toneForOperational('IMMOBILISE')}
            value={immobilized.data}
            total={active.data}
            describe={(n, total) => `${plural(n, 'immobilisé', 'immobilisés')} sur ${actifs(total)}`}
            href="/vehicules?statut=IMMOBILISE"
            linkLabel="Voir les véhicules immobilisés"
          />
          <IndicatorTile
            label={VEHICLE_LIFECYCLE_LABELS.HORS_SERVICE}
            tone="neutral"
            value={outOfService.data}
            total={fleet.data}
            describe={(_n, total) => `hors service sur ${auParc(total)}`}
            href="/vehicules?lifecycle=HORS_SERVICE"
            linkLabel="Voir les véhicules hors service"
          />
        </div>
      )}
    </section>
  );
}

function IndicatorTile({
  label,
  tone,
  value,
  total,
  describe,
  href,
  linkLabel,
}: {
  label: string;
  tone: Tone;
  value: number | undefined;
  total: number | undefined;
  describe: (value: number, total: number) => string;
  href: string;
  linkLabel: string;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          <StatusBadge label={label} tone={tone} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        {value === undefined || total === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-4 w-full" />
            <span className="sr-only">Chargement…</span>
          </div>
        ) : (
          <p>
            <span className="block text-3xl font-semibold tabular-nums">{value}</span>{' '}
            <span className="text-sm text-muted-foreground">{describe(value, total)}</span>
          </p>
        )}
        <Link href={href} className="mt-auto text-sm font-medium underline-offset-4 hover:underline">
          {linkLabel}
        </Link>
      </CardContent>
    </Card>
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
