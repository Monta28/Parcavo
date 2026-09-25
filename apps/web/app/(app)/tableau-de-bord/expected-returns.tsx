'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { UsageView } from '@/lib/usages-types';
import type { DashboardIndicator } from './dashboard-types';
import { IndicatorDefinition, IndicatorMeasure, SubIndicatorList } from './indicator-tile';

const PAGE_SIZE = 10;

interface ExpectedReturnsProps {
  companyId: string | null;
  /** Véhicule filtré (11.1) : même filtre que l'indicateur. */
  vehicleId?: string | null;
  /** Indicateur usages.returnDue et ses sous-ensembles ; undefined pendant le chargement ou en cas d'erreur du tableau de bord. */
  indicator: DashboardIndicator | undefined;
  items: DashboardIndicator[];
  loading: boolean;
  timezone: string;
  currencyDecimals: number;
}

/**
 * Retours attendus (D-269) : la liste affichée est la liste justificative de l'indicateur
 * (GET /usages?returnDue=true, mêmes filtres que le calcul) ; retard (`isLate`) calculé par l'API.
 */
export function ExpectedReturns({ companyId, vehicleId = null, indicator, items, loading, timezone, currencyDecimals }: ExpectedReturnsProps) {
  const { session } = useAppScope();
  const [page, setPage] = useState(1);
  const query = toQuery({ companyId, vehicleId, returnDue: 'true', page, pageSize: PAGE_SIZE });
  const usages = useQuery({ queryKey: ['usages', query], queryFn: () => api<Page<UsageView>>(`/usages${query}`) });
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <Card className="gap-4" role="region" aria-labelledby="retours-attendus">
      <CardHeader>
        <CardTitle className="text-base">
          <h2 id="retours-attendus">Retours attendus</h2>
        </CardTitle>
        <CardDescription>{indicator ? indicator.definition : 'Utilisations en cours dont le retour est prévu aujourd’hui ou déjà dépassé.'}</CardDescription>
        {indicator ? (
          <div className="space-y-2">
            <IndicatorMeasure indicator={indicator} timezone={timezone} currencyDecimals={currencyDecimals} compact />
            <SubIndicatorList parent={indicator} items={items} timezone={timezone} currencyDecimals={currencyDecimals} />
            <IndicatorDefinition indicator={indicator} items={items} />
          </div>
        ) : loading ? (
          <Skeleton className="h-8 w-48" />
        ) : null}
      </CardHeader>
      <CardContent>
        {usages.isPending ? (
          <LoadingState label="Chargement des retours attendus…" />
        ) : usages.isError ? (
          <ErrorState error={usages.error} retry={() => void usages.refetch()} />
        ) : usages.data.total === 0 ? (
          <EmptyState title="Aucun retour attendu" description="Aucune utilisation en cours n’a un retour prévu aujourd’hui ou dépassé dans votre périmètre." />
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Véhicule</TableHead>
                    {companyId === null ? <TableHead>Société</TableHead> : null}
                    <TableHead>Conducteur</TableHead>
                    <TableHead>Remise</TableHead>
                    <TableHead>Retour prévu</TableHead>
                    <TableHead>
                      <span className="sr-only">Utilisation</span>
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
                      {companyId === null ? <TableCell>{companyCode(u.companyId)}</TableCell> : null}
                      <TableCell>
                        <Link href={`/conducteurs/${u.driverId}`} className="underline-offset-4 hover:underline">
                          {u.driverName}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateTime(u.checkedOutAt, timezone)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{formatDateTime(u.expectedReturnAt, timezone)}</span>
                          {u.isLate ? <StatusBadge label="Retour dépassé" tone="danger" /> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/utilisations/${u.id}`} className="text-sm font-medium underline-offset-4 hover:underline">
                          Ouvrir<span className="sr-only"> l’utilisation du véhicule {u.vehicleCode}</span>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PaginationControls page={usages.data.page} pageSize={usages.data.pageSize} total={usages.data.total} onPageChange={setPage} />
            </div>
            <div className="flex justify-end text-sm">
              <Link href="/utilisations?statut=EN_COURS" className="font-medium underline-offset-4 hover:underline">
                Voir toutes les utilisations en cours
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
