'use client';

import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { PAGINATION } from '@parc-auto/contracts';
import { useAppScope, useCan } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { ReportMetaBlock } from '@/components/reports/report-meta';
import { ReportTable } from '@/components/reports/report-table';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { REPORT_FILTER_KEYS, type ReportCatalogue, type ReportFilterKey, type ReportPage, type ReportViewDefinition } from '@/lib/reports-types';
import { useListParams } from '@/lib/use-list-params';
import { ExportPanel } from './export-panel';
import { FILTER_FIELD_LABELS, ReportFilters } from './report-filters';

const PAGE_SIZES = [25, 50, 100].filter((n) => n <= PAGINATION.maxPageSize);

/** Paramètres envoyés à l'API : vue, société courante et filtres de l'URL que la vue accepte. */
function reportParams(view: ReportViewDefinition, value: (key: string) => string, companyId: string | null): Record<string, string> {
  const params: Record<string, string> = { vue: view.code };
  for (const key of view.filters) {
    if (key === 'companyId') {
      if (companyId) params.companyId = companyId;
      continue;
    }
    const v = value(key);
    if (v) params[key] = v;
  }
  return params;
}

/**
 * Rapports V1 (CDC 11.2, 10.2) : catalogue de l'API (GET /reports), filtres propres à chaque vue persistants
 * dans l'URL, lignes paginées (GET /reports/:code) affichées selon meta.columns sans aucun recalcul, bloc
 * « Filtres, fuseau et date de génération » repris des métadonnées, exports CSV/XLSX (reports.export).
 * Le périmètre est calculé par le serveur : la société courante n'est qu'un filtre.
 */
export function ReportsView() {
  const { session, companyId } = useAppScope();
  const canReadCosts = useCan('costs.read');
  const canExportHere = useCan('reports.export');
  const { get, set, page } = useListParams();
  const [resetCount, setResetCount] = useState(0);
  const catalogue = useQuery({ queryKey: ['reports', 'catalogue'], queryFn: () => api<ReportCatalogue>('/reports') });

  const reports = (catalogue.data?.reports ?? []).filter((r) => r.available && (!r.costsRequired || canReadCosts));
  const requested = get('rapport');
  const report = reports.find((r) => r.code === requested) ?? reports[0] ?? null;
  const view = report ? (report.views.find((v) => v.code === get('vue')) ?? report.views[0] ?? null) : null;
  const sizeParam = Number(get('taille'));
  const pageSize = PAGE_SIZES.includes(sizeParam) ? sizeParam : PAGINATION.defaultPageSize;
  const params = view ? reportParams(view, get, companyId) : {};
  const query = toQuery({ ...params, page, pageSize });

  const data = useQuery({
    queryKey: ['reports', 'page', report?.code ?? '', view?.code ?? '', query],
    queryFn: () => api<ReportPage>(`/reports/${encodeURIComponent(report?.code ?? '')}${query}`),
    enabled: report !== null && view !== null,
    // Pagination et filtres d'une même vue : l'ancienne page reste affichée pendant le chargement.
    placeholderData: (previous, previousQuery) => (previousQuery && previousQuery.queryKey[2] === report?.code && previousQuery.queryKey[3] === view?.code ? previous : undefined),
  });

  const currentCompany = companyId ? session.companies.find((c) => c.id === companyId) : undefined;
  const companyLabel = companyId ? (currentCompany ? `${currentCompany.code} — ${currentCompany.name}` : 'Société courante') : 'Toutes mes sociétés';
  const exportAllowed = catalogue.data?.canExport === true && canExportHere;

  function selectReport(code: string) {
    const cleared = Object.fromEntries(REPORT_FILTER_KEYS.filter((k) => k !== 'from' && k !== 'to').map((k) => [k, '']));
    setResetCount((n) => n + 1);
    set({ ...cleared, rapport: code });
  }

  function selectView(code: string) {
    const next = report?.views.find((v) => v.code === code);
    if (!next) return;
    const cleared = Object.fromEntries(REPORT_FILTER_KEYS.filter((k) => k === 'status' || !next.filters.includes(k)).map((k) => [k, '']));
    setResetCount((n) => n + 1);
    set({ ...cleared, vue: code });
  }

  function resetFilters() {
    const cleared = Object.fromEntries(REPORT_FILTER_KEYS.filter((k) => k !== 'vue').map((k) => [k, '']));
    setResetCount((n) => n + 1);
    set(cleared);
  }

  const header = <PageHeader title="Rapports" description="Rapports V1 sur les sociétés de votre périmètre : filtres, métadonnées de génération et exports des seules données autorisées." />;

  if (catalogue.isPending) {
    return (
      <div>
        {header}
        <LoadingState label="Chargement des rapports…" />
      </div>
    );
  }
  if (catalogue.isError) {
    return (
      <div>
        {header}
        <ErrorState error={catalogue.error} retry={() => void catalogue.refetch()} />
      </div>
    );
  }
  if (!report || !view) {
    return (
      <div>
        {header}
        <EmptyState title="Aucun rapport disponible" description="Aucun rapport n’est consultable avec vos permissions sur la société courante." />
      </div>
    );
  }

  const meta = data.data?.meta;
  const hasFilters = REPORT_FILTER_KEYS.some((k) => k !== 'vue' && k !== 'companyId' && get(k) !== '');

  return (
    <div className="space-y-4">
      {header}

      <section aria-labelledby="rapport-selection" className="no-print space-y-4 rounded-md border p-4">
        <h2 id="rapport-selection" className="sr-only">
          Choix du rapport et filtres
        </h2>
        {requested && requested !== report.code ? (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Le rapport demandé n’est pas accessible avec vos permissions sur la société courante : « {report.label} » est affiché à la place.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="rapport-choix">Rapport</Label>
            <Select value={report.code} onValueChange={selectReport}>
              <SelectTrigger id="rapport-choix" className="w-full" aria-describedby="rapport-description">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reports.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="rapport-description" className="text-xs text-muted-foreground">
              {report.description}
            </p>
          </div>
          {report.views.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="rapport-vue">Vue</Label>
              <Select value={view.code} onValueChange={selectView}>
                <SelectTrigger id="rapport-vue" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {report.views.map((v) => (
                    <SelectItem key={v.code} value={v.code}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {view.filters.includes('companyId') ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Société</p>
              <p className="text-sm">{companyLabel}</p>
              <p className="text-xs text-muted-foreground">Société courante choisie dans l’en-tête ; le serveur recoupe toujours avec votre périmètre.</p>
            </div>
          ) : null}
        </div>
        <ReportFilters key={`${report.code}-${view.code}-${resetCount}`} view={view} value={(k: ReportFilterKey) => get(k)} onChange={(updates) => set(updates)} companyId={companyId} period={meta?.period ?? null} options={catalogue.data.filterOptions} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{view.period ? 'Période en dates civiles locales, bornes incluses ; sans date choisie, la période par défaut du serveur s’applique.' : 'Vue instantanée, sans période.'}</p>
          <Button type="button" variant="ghost" size="sm" onClick={resetFilters} disabled={!hasFilters}>
            <RotateCcw className="size-4" aria-hidden="true" /> Réinitialiser les filtres
          </Button>
        </div>
      </section>

      {exportAllowed && catalogue.data ? (
        <ExportPanel code={report.code} reportLabel={`${report.label} — ${view.label}`} params={params} syncMaxRows={catalogue.data.syncMaxRows} maxRows={catalogue.data.maxRows} timezone={session.timezone} />
      ) : null}

      {data.isPending ? (
        <LoadingState label="Génération du rapport…" />
      ) : data.isError ? (
        <ReportError error={data.error} retry={() => void data.refetch()} />
      ) : (
        <>
          <ReportMetaBlock meta={data.data.meta} total={data.data.total} />
          {data.data.total === 0 ? (
            <EmptyState title="Aucune ligne" description={hasFilters ? 'Aucune donnée ne correspond aux filtres dans votre périmètre.' : 'Aucune donnée pour ce rapport dans votre périmètre.'} />
          ) : (
            <div className="rounded-md border" aria-busy={data.isFetching}>
              <ReportTable columns={data.data.meta.columns} items={data.data.items} timezone={data.data.meta.timezone} caption={`${data.data.meta.label} — ${data.data.meta.view.label}`} />
              <div className="no-print flex flex-col gap-2 border-t px-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 pt-3 text-sm sm:pt-0">
                  <Label htmlFor="rapport-taille" className="font-normal text-muted-foreground">
                    Lignes par page
                  </Label>
                  <Select value={String(pageSize)} onValueChange={(v) => set({ taille: v })}>
                    <SelectTrigger id="rapport-taille" size="sm" className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZES.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <PaginationControls page={data.data.page} pageSize={data.data.pageSize} total={data.data.total} onPageChange={(p) => set({ page: p })} />
              </div>
            </div>
          )}
          {data.data.meta.columns.some((c) => c.missing !== null || c.cost) ? (
            <p className="text-xs text-muted-foreground">
              Une valeur absente est affichée avec le libellé fourni par le serveur (N/D, Inconnu…), jamais comme 0 ; son motif figure dans la colonne « Motif » correspondante quand elle existe. Les
              estimations (GPS) sont signalées par un badge. « Masqué » : montant non visible sans la permission costs.read sur la société de la ligne.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Erreur de l'API (403 droits, 404 hors périmètre, 422 filtre refusé) avec les messages par champ. */
function ReportError({ error, retry }: { error: unknown; retry: () => void }) {
  const fieldErrors = isApiError(error) ? Object.entries(error.fieldErrors) : [];
  return (
    <div className="space-y-2">
      <ErrorState error={error} retry={retry} />
      {fieldErrors.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
          {fieldErrors.map(([key, messages]) => (
            <li key={key}>
              {FILTER_FIELD_LABELS[key as ReportFilterKey] ?? key} : {messages.join(' ')}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
