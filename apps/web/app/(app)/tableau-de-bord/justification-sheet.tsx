'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge, toneForOperational } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';
import type { VehicleView } from '@/lib/vehicles-types';
import type { AlertSummaryView, DashboardIndicator, ExpenseSummaryView, IndicatorLink } from './dashboard-types';
import { AlertListItem } from './alert-list-item';

const PAGE_SIZE = 20;

/** Routes justificatives de l'API affichables ici lorsqu'aucun écran ne propose le même filtre. */
const SHEET_PATHS = new Set(['/vehicles', '/alerts', '/expenses/summary']);

/** Lien vers un écran (ou une route) avec ses paramètres, tels que fournis par l'API. */
export function linkHref(link: IndicatorLink): string {
  return `${link.path}${toQuery(link.query)}`;
}

interface JustificationLinkProps {
  indicator: DashboardIndicator;
  timezone: string;
  currencyDecimals: number;
  /** Libellé visible du lien (« Voir la liste » ou « Voir »). */
  label?: string;
  className?: string;
}

/**
 * Ouverture de la liste justificative (CDC 11.1, D-269) : l'écran qui propose le même filtre lorsqu'il
 * existe (justification.screen), sinon la route de l'API elle-même (justification.path + query, requête
 * identique au calcul) affichée dans un panneau, sans aucun recalcul.
 */
export function JustificationLink({ indicator, timezone, currencyDecimals, label = 'Voir la liste', className }: JustificationLinkProps) {
  const [open, setOpen] = useState(false);
  const screen = indicator.justification.screen;
  if (screen) {
    return (
      <Link href={linkHref(screen)} className={className ?? 'font-medium underline-offset-4 hover:underline'}>
        {label}
        <span className="sr-only"> : {indicator.label}</span>
      </Link>
    );
  }
  if (!SHEET_PATHS.has(indicator.justification.path)) {
    return <span className="text-xs text-muted-foreground">Liste justificative indiquée dans la source.</span>;
  }
  return (
    <>
      <Button type="button" variant="link" className={className ?? 'h-auto p-0 font-medium'} onClick={() => setOpen(true)}>
        {label}
        <span className="sr-only"> : {indicator.label}</span>
      </Button>
      {open ? <JustificationSheet indicator={indicator} timezone={timezone} currencyDecimals={currencyDecimals} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function JustificationSheet({ indicator, timezone, currencyDecimals, onClose }: { indicator: DashboardIndicator; timezone: string; currencyDecimals: number; onClose: () => void }) {
  const { path, query } = indicator.justification;
  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{indicator.label}</SheetTitle>
          <SheetDescription>
            {indicator.definition} Liste justificative : <code className="break-all">GET {linkHref(indicator.justification)}</code>
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {path === '/vehicles' ? <VehiclesJustification query={query} /> : null}
          {path === '/alerts' ? <AlertsJustification query={query} timezone={timezone} /> : null}
          {path === '/expenses/summary' ? <CostsJustification query={query} currencyDecimals={currencyDecimals} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function VehiclesJustification({ query }: { query: Record<string, string> }) {
  const [page, setPage] = useState(1);
  const qs = toQuery({ ...query, page, pageSize: PAGE_SIZE, sort: 'code' });
  const vehicles = useQuery({ queryKey: ['vehicles', 'justification', qs], queryFn: () => api<Page<VehicleView>>(`/vehicles${qs}`) });
  if (vehicles.isPending) return <LoadingState label="Chargement des véhicules…" />;
  if (vehicles.isError) return <ErrorState error={vehicles.error} retry={() => void vehicles.refetch()} />;
  if (vehicles.data.total === 0) return <EmptyState title="Aucun véhicule" description="Aucun véhicule ne correspond à cet indicateur dans votre périmètre." />;
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Véhicule</TableHead>
            <TableHead>Société</TableHead>
            <TableHead>Statut</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vehicles.data.items.map((v) => (
            <TableRow key={v.id}>
              <TableCell>
                <Link href={`/vehicules/${v.id}`} className="font-medium underline-offset-4 hover:underline">
                  {v.code}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {v.registration} · {v.make} {v.model}
                </span>
              </TableCell>
              <TableCell>{v.companyCode}</TableCell>
              <TableCell>
                {v.operationalStatus ? (
                  <StatusBadge label={VEHICLE_OPERATIONAL_STATUS_LABELS[v.operationalStatus]} tone={toneForOperational(v.operationalStatus)} />
                ) : (
                  <StatusBadge label={VEHICLE_LIFECYCLE_LABELS[v.lifecycleStatus]} tone="neutral" />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationControls page={vehicles.data.page} pageSize={vehicles.data.pageSize} total={vehicles.data.total} onPageChange={setPage} />
    </div>
  );
}

function AlertsJustification({ query, timezone }: { query: Record<string, string>; timezone: string }) {
  const [page, setPage] = useState(1);
  const qs = toQuery({ ...query, page, pageSize: PAGE_SIZE });
  const alerts = useQuery({ queryKey: ['alerts', 'justification', qs], queryFn: () => api<Page<AlertSummaryView>>(`/alerts${qs}`) });
  if (alerts.isPending) return <LoadingState label="Chargement des alertes…" />;
  if (alerts.isError) return <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />;
  if (alerts.data.total === 0) return <EmptyState title="Aucune alerte" description="Aucune alerte active de cette gravité ne vous concerne dans ce périmètre." />;
  return (
    <div className="rounded-md border">
      <ul className="divide-y">
        {alerts.data.items.map((a) => (
          <AlertListItem key={a.id} alert={a} timezone={timezone} showCompany={!query.companyId} />
        ))}
      </ul>
      <PaginationControls page={alerts.data.page} pageSize={alerts.data.pageSize} total={alerts.data.total} onPageChange={setPage} />
    </div>
  );
}

function CostsJustification({ query, currencyDecimals }: { query: Record<string, string>; currencyDecimals: number }) {
  const qs = toQuery(query);
  const summary = useQuery({ queryKey: ['expenses', 'summary', 'justification', qs], queryFn: () => api<ExpenseSummaryView>(`/expenses/summary${qs}`) });
  if (summary.isPending) return <LoadingState label="Chargement du registre des dépenses…" />;
  if (summary.isError) return <ErrorState error={summary.error} retry={() => void summary.refetch()} />;
  const s = summary.data;
  const money = (value: string) => formatMoney(value, s.currency, currencyDecimals);
  return (
    <div className="space-y-4">
      {s.byCategory.length === 0 ? (
        <EmptyState title="Aucune dépense validée" description="Aucune dépense validée ni aucun avoir dans la période pour ce périmètre." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Catégorie</TableHead>
                <TableHead className="text-right">Dépenses</TableHead>
                <TableHead className="text-right">Avoirs</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Écritures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.byCategory.map((c) => (
                <TableRow key={c.category}>
                  <TableCell>{c.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.expenses)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.credits)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.net)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.count}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>{s.operating.label}</TableCell>
                <TableCell className="text-right tabular-nums">{money(s.operating.expenses)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(s.operating.credits)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(s.operating.net)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.operating.count}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
      <dl className="space-y-1 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">{s.unallocated.label} (compris dans le coût d’exploitation)</dt>
          <dd className="tabular-nums">{money(s.unallocated.net)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">{s.excludedFromOperatingCost.label}</dt>
          <dd className="tabular-nums">{money(s.excludedFromOperatingCost.net)}</dd>
        </div>
      </dl>
    </div>
  );
}
