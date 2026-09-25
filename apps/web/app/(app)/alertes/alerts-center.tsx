'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ALERT_SEVERITY_LABELS, ALERT_TYPE_LABELS } from '@parc-auto/contracts';
import { ALL } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { appPathOrNull } from '@/lib/app-paths';
import {
  ALERT_SEVERITY_ORDER,
  ALERT_SNOOZE_FILTER_LABELS,
  ALERT_STATUS_LABELS,
  type AlertCounts,
  type AlertSeverity,
  type AlertSnoozeFilter,
  type AlertView,
} from '@/lib/alerts-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { objectHref } from '@/lib/object-links';
import { useListParams } from '@/lib/use-list-params';
import { cn } from '@/lib/utils';
import { SnoozeDialog } from './snooze-dialog';

const PAGE_SIZE = 25;
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const SEVERITY_TONES: Record<AlertSeverity, Tone> = { CRITIQUE: 'danger', URGENT: 'danger', ATTENTION: 'warning', INFO: 'info' };
const SEVERITY_COUNT_LABELS: Record<AlertSeverity, string> = { CRITIQUE: 'Critiques', URGENT: 'Urgentes', ATTENTION: 'Attention', INFO: 'Information' };
const SNOOZE_FILTERS = Object.keys(ALERT_SNOOZE_FILTER_LABELS) as AlertSnoozeFilter[];

/**
 * Centre d'alertes (CDC 9.1, 9.2, 10.2 : /alertes) : alertes du périmètre calculées par l'API (visibles
 * selon le rôle détenu sur chaque société), compteurs, filtres conservés dans l'URL, lecture et report
 * propres à l'utilisateur. Lire ou reporter ne résout jamais l'alerte : seule la disparition de la
 * condition la résout (T20).
 */
export function AlertsCenter() {
  const { session } = useAppScope();
  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Alertes" />
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Centre d’alertes réservé au personnel de gestion</p>
          <p className="max-w-md text-sm text-muted-foreground">Vos soumissions et leur état sont consultables dans « Mon véhicule ».</p>
        </div>
      </div>
    );
  }
  return <AlertsCenterContent />;
}

function AlertsCenterContent() {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const queryClient = useQueryClient();
  const { get, set, page } = useListParams();
  const rawCompany = get('societe');
  const companyFilter = scopeCompanyId === null && session.companies.some((c) => c.id === rawCompany) ? rawCompany : '';
  const companyId = scopeCompanyId ?? (companyFilter || null);
  const status = get('statut') === 'RESOLUE' ? 'RESOLUE' : 'ACTIVE';
  const type = get('type');
  const severity = get('gravite');
  const read = get('lecture');
  const snoozed = (SNOOZE_FILTERS as string[]).includes(get('reports')) ? (get('reports') as AlertSnoozeFilter) : 'include';
  const q = get('q');
  const [snoozing, setSnoozing] = useState<AlertView | null>(null);

  const countsQuery = toQuery({ companyId });
  const counts = useQuery({ queryKey: ['alerts', 'counts', countsQuery], queryFn: () => api<AlertCounts>(`/alerts/counts${countsQuery}`) });
  const listQuery = toQuery({
    companyId,
    status,
    type,
    severity,
    unread: read === 'non-lues' ? 'true' : read === 'lues' ? 'false' : undefined,
    snoozed: snoozed === 'include' ? undefined : snoozed,
    q,
    page,
    pageSize: PAGE_SIZE,
  });
  const alerts = useQuery({ queryKey: ['alerts', 'list', listQuery], queryFn: () => api<Page<AlertView>>(`/alerts${listQuery}`) });
  const filtered = Boolean(type || severity || read || snoozed !== 'include' || q || status !== 'ACTIVE' || companyFilter);

  const action = useMutation({
    mutationFn: ({ alert, kind }: { alert: AlertView; kind: 'read' | 'unread' | 'unsnooze' }) => api<AlertView>(`/alerts/${alert.id}/${kind}`, { method: 'POST' }),
    onSuccess: (_updated, { kind }) => {
      if (kind === 'unsnooze') toast.success('Votre report est annulé.');
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Action impossible.');
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  // Un compteur est calculé par l'API sur les alertes actives de la société, sans type ni recherche : le
  // choisir remplace les filtres (statut, gravité, lecture, reports, type, recherche) pour que la liste
  // affichée corresponde exactement au nombre cliqué. Le champ de recherche est vidé aussi.
  const [search, setSearch] = useState(q);
  const selectCounter = (filter: { gravite?: string; lecture?: string; reports?: string }) => {
    set({ statut: '', type: '', q: '', gravite: '', lecture: '', reports: '', ...filter });
    setSearch('');
  };
  const onlyCounterFilters = !type && !q;
  const tiles: Array<{ key: string; label: string; value: number | undefined; active: boolean; onClick: () => void; tone?: Tone }> = [
    { key: 'actives', label: 'Actives', value: counts.data?.total, active: onlyCounterFilters && status === 'ACTIVE' && !severity && !read && snoozed === 'include', onClick: () => selectCounter({}) },
    ...ALERT_SEVERITY_ORDER.map((s) => ({
      key: s.toLowerCase(),
      label: SEVERITY_COUNT_LABELS[s],
      value: counts.data?.bySeverity[s],
      active: onlyCounterFilters && status === 'ACTIVE' && severity === s && !read && snoozed === 'include',
      onClick: () => selectCounter({ gravite: s }),
      tone: SEVERITY_TONES[s],
    })),
    { key: 'non-lues', label: 'Non lues', value: counts.data?.unread, active: onlyCounterFilters && status === 'ACTIVE' && read === 'non-lues' && !severity && snoozed === 'include', onClick: () => selectCounter({ lecture: 'non-lues' }) },
    { key: 'reportees', label: 'Reportées par moi', value: counts.data?.snoozed, active: onlyCounterFilters && status === 'ACTIVE' && snoozed === 'only' && !severity && !read, onClick: () => selectCounter({ reports: 'only' }) },
  ];

  return (
    <div>
      <PageHeader
        title="Alertes"
        description="Alertes actives de votre périmètre, visibles selon votre rôle sur chaque société. « Lu » et le report vous sont propres : ils ne résolvent jamais l’alerte ni le retard, seule la disparition de la condition la résout."
      />

      <section aria-label="Compteurs des alertes actives" className="mb-6">
        {counts.isError ? (
          <ErrorState error={counts.error} retry={() => void counts.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            {tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                data-testid={`compteur-${t.key}`}
                aria-pressed={t.active}
                onClick={t.onClick}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  t.active && 'border-primary bg-primary/5',
                )}
              >
                <span className="block text-2xl font-semibold" aria-live="polite">
                  {t.value ?? '…'}
                </span>
                <span className={cn('block text-xs', t.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
            Recherche
          </Label>
          <Input
            id="filter-q"
            placeholder="Titre de l’alerte"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value });
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-statut" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={status} onValueChange={(v) => set({ statut: v === 'ACTIVE' ? '' : v })}>
            <SelectTrigger id="filter-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">{ALERT_STATUS_LABELS.ACTIVE}s</SelectItem>
              <SelectItem value="RESOLUE">{ALERT_STATUS_LABELS.RESOLUE}s</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-type" className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select value={type || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les types</SelectItem>
              {Object.entries(ALERT_TYPE_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-gravite" className="text-xs text-muted-foreground">
            Gravité
          </Label>
          <Select value={severity || ALL} onValueChange={(v) => set({ gravite: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-gravite" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les gravités</SelectItem>
              {ALERT_SEVERITY_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {ALERT_SEVERITY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {scopeCompanyId === null && session.companies.length > 1 ? (
          <div className="space-y-1">
            <Label htmlFor="filter-societe" className="text-xs text-muted-foreground">
              Société
            </Label>
            <Select value={companyFilter || ALL} onValueChange={(v) => set({ societe: v === ALL ? '' : v })}>
              <SelectTrigger id="filter-societe" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Toutes mes sociétés</SelectItem>
                {session.companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="filter-lecture" className="text-xs text-muted-foreground">
            Lecture
          </Label>
          <Select value={read || ALL} onValueChange={(v) => set({ lecture: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-lecture" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Lues et non lues</SelectItem>
              <SelectItem value="non-lues">Non lues</SelectItem>
              <SelectItem value="lues">Lues</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-reports" className="text-xs text-muted-foreground">
            Reports
          </Label>
          <Select value={snoozed} onValueChange={(v) => set({ reports: v === 'include' ? '' : v })}>
            <SelectTrigger id="filter-reports" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SNOOZE_FILTERS.map((key) => (
                <SelectItem key={key} value={key}>
                  {ALERT_SNOOZE_FILTER_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {alerts.isPending ? (
        <LoadingState label="Chargement des alertes…" />
      ) : alerts.isError ? (
        <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />
      ) : alerts.data.total === 0 ? (
        <EmptyState
          title={status === 'ACTIVE' ? 'Aucune alerte active' : 'Aucune alerte résolue'}
          description={filtered ? 'Aucune alerte ne correspond aux filtres dans votre périmètre.' : 'Aucune alerte ne vous concerne dans ce périmètre.'}
        />
      ) : (
        <div className="rounded-md border">
          <ul className="divide-y" aria-label="Liste des alertes">
            {alerts.data.items.map((a) => (
              <AlertItem
                key={a.id}
                alert={a}
                showCompany={companyId === null}
                pending={action.isPending && action.variables?.alert.id === a.id}
                onRead={() => action.mutate({ alert: a, kind: a.readAt ? 'unread' : 'read' })}
                onUnsnooze={() => action.mutate({ alert: a, kind: 'unsnooze' })}
                onSnooze={() => setSnoozing(a)}
              />
            ))}
          </ul>
          <PaginationControls page={alerts.data.page} pageSize={alerts.data.pageSize} total={alerts.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      {snoozing ? <SnoozeDialog alert={snoozing} onClose={() => setSnoozing(null)} /> : null}
    </div>
  );
}

function AlertItem({
  alert: a,
  showCompany,
  pending,
  onRead,
  onSnooze,
  onUnsnooze,
}: {
  alert: AlertView;
  showCompany: boolean;
  pending: boolean;
  onRead: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
}) {
  const { session } = useAppScope();
  const actionPath = appPathOrNull(a.actionPath);
  const objectPath = objectHref(a.objectType, a.objectId, { vehicleId: a.vehicleId ?? undefined, isAdmin: session.isAdmin });
  const others = a.snoozes.filter((s) => s.userId !== session.userId);
  return (
    <li className="space-y-2 px-4 py-3" aria-label={a.title}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={a.severityLabel} tone={SEVERITY_TONES[a.severity] ?? 'neutral'} />
        {a.status === 'RESOLUE' ? <StatusBadge label={ALERT_STATUS_LABELS.RESOLUE} tone="success" /> : <StatusBadge label={ALERT_STATUS_LABELS.ACTIVE} tone="neutral" />}
        <StatusBadge label={a.readAt ? 'Lue' : 'Non lue'} tone={a.readAt ? 'neutral' : 'info'} />
        {actionPath ? (
          <Link href={actionPath} className={cn('underline-offset-4 hover:underline', a.readAt ? 'font-medium' : 'font-semibold')}>
            {a.title}
          </Link>
        ) : (
          <span className={a.readAt ? 'font-medium' : 'font-semibold'}>{a.title}</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{a.message}</p>
      <p className="text-xs text-muted-foreground">
        {a.typeLabel}
        {showCompany ? ` · ${a.companyName}` : ''}
        {a.vehicleId && a.vehicleCode ? (
          <>
            {' · '}
            <Link href={`/vehicules/${a.vehicleId}`} className="underline underline-offset-4">
              {a.vehicleCode}
              {a.vehicleRegistration ? ` · ${a.vehicleRegistration}` : ''}
            </Link>
          </>
        ) : null}
        {' · '}déclenchée le {formatDateTime(a.triggeredAt, session.timezone)} · responsable : {a.responsibleName}
        {a.readAt ? ` · lue le ${formatDateTime(a.readAt, session.timezone)}` : ''}
      </p>
      {a.snoozedUntil ? (
        <p className="text-sm text-warning-foreground">
          Reportée par vous jusqu’au {formatDate(a.snoozedUntil)} inclus{a.snoozeReason ? ` — ${a.snoozeReason}` : ''}
        </p>
      ) : null}
      {others.map((s) => (
        <p key={s.userId} className="text-xs text-muted-foreground">
          Reportée par {s.userName} jusqu’au {formatDate(s.until)} — {s.reason}
        </p>
      ))}
      {a.status === 'RESOLUE' ? (
        <p className="text-xs text-muted-foreground">
          Résolue le {formatDateTime(a.resolvedAt, session.timezone)}
          {a.resolutionReason ? ` — ${a.resolutionReason}` : ''}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRead} aria-label={`${a.readAt ? 'Marquer comme non lue' : 'Marquer comme lue'} : ${a.title}`}>
          {a.readAt ? 'Marquer comme non lue' : 'Marquer comme lue'}
        </Button>
        {a.canSnooze ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onSnooze} aria-label={`${a.snoozedUntil ? 'Modifier le report' : 'Reporter'} : ${a.title}`}>
            {a.snoozedUntil ? 'Modifier le report' : 'Reporter'}
          </Button>
        ) : null}
        {a.snoozedUntil ? (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onUnsnooze} aria-label={`Annuler mon report : ${a.title}`}>
            Annuler mon report
          </Button>
        ) : null}
        {objectPath && objectPath !== actionPath ? (
          <Link href={objectPath} className="text-sm underline underline-offset-4">
            Voir l’objet concerné
          </Link>
        ) : null}
      </div>
    </li>
  );
}
