'use client';

import { useQuery } from '@tanstack/react-query';
import { Eye, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { objectTypeLabel, type AuditActionFacet, type AuditActorFacet, type AuditEventView, type AuditObjectTypeFacet } from '@/lib/audit-types';
import { formatDateTime } from '@/lib/format';
import { objectHref } from '@/lib/object-links';
import { useListParams } from '@/lib/use-list-params';
import { isCivilDate } from '@/lib/zoned-time';
import { ALL } from '../labels';
import { AuditEventDialog } from './audit-event-dialog';

const PAGE_SIZE = 25;
/** Valeur du filtre « acteur » désignant les traitements système (sinon : identifiant d'utilisateur). */
const SYSTEM = 'SYSTEME';

/**
 * Journal d'audit (CDC 10.2, 16.1 ; D-109) : GET /audit paginé, du plus récent au plus ancien. Le périmètre
 * est appliqué par le serveur (administrateur : toute l'organisation ; chef de parc : ses sociétés de rôle
 * CHEF_PARC ; autres rôles : 403 affiché tel quel). Filtres persistants dans l'URL ; listes de valeurs
 * servies par GET /audit/actions, /audit/object-types et /audit/actors sur la même période et société.
 */
export function AuditJournal() {
  const { session, companyId } = useAppScope();
  const { get, set, page } = useListParams();
  const rawFrom = get('du');
  const rawTo = get('au');
  const from = isCivilDate(rawFrom) ? rawFrom : '';
  const to = isCivilDate(rawTo) ? rawTo : '';
  const action = get('action').trim();
  const objectType = get('type').trim();
  const objectId = get('objet').trim();
  const actor = get('acteur').trim();
  const [selected, setSelected] = useState<AuditEventView | null>(null);

  const scopeQuery = toQuery({ from, to, companyId });
  const listQuery = toQuery({
    from,
    to,
    companyId,
    action,
    objectType,
    objectId,
    actorType: actor === SYSTEM ? SYSTEM : undefined,
    actorUserId: actor && actor !== SYSTEM ? actor : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const events = useQuery({ queryKey: ['audit', 'events', listQuery], queryFn: () => api<Page<AuditEventView>>(`/audit${listQuery}`) });
  const denied = events.isError && isApiError(events.error) && events.error.status === 403;
  const facetsEnabled = !denied;
  const actions = useQuery({ queryKey: ['audit', 'actions', scopeQuery], queryFn: () => api<AuditActionFacet[]>(`/audit/actions${scopeQuery}`), enabled: facetsEnabled });
  const objectTypes = useQuery({ queryKey: ['audit', 'object-types', scopeQuery], queryFn: () => api<AuditObjectTypeFacet[]>(`/audit/object-types${scopeQuery}`), enabled: facetsEnabled });
  const actors = useQuery({ queryKey: ['audit', 'actors', scopeQuery], queryFn: () => api<AuditActorFacet[]>(`/audit/actors${scopeQuery}`), enabled: facetsEnabled });

  const filtered = Boolean(from || to || action || objectType || objectId || actor);
  const showCompany = companyId === null;
  const isFleetManager = !session.isDriverOnly && session.grants.some((g) => g.role === 'CHEF_PARC');
  const scopeLabel = session.isAdmin ? 'toute l’organisation' : 'les sociétés dont vous êtes chef de parc';
  const description =
    session.isAdmin || isFleetManager
      ? `Actions sensibles tracées (acteur, date, objet, motif, valeurs avant/après expurgées) pour ${scopeLabel}${companyId ? ', limitées à la société sélectionnée' : ''}. Dates et heures du fuseau ${session.timezone}.`
      : 'Consultation réservée à l’administrateur groupe et au chef de parc.';

  return (
    <div>
      <PageHeader title="Journal d’audit" description={description} />

      {denied ? null : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" role="search" aria-label="Filtres du journal d’audit">
          <div className="space-y-1">
            <Label htmlFor="audit-from">Du</Label>
            <Input id="audit-from" type="date" value={from} max={to || undefined} onChange={(e) => set({ du: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-to">Au</Label>
            <Input id="audit-to" type="date" value={to} min={from || undefined} onChange={(e) => set({ au: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-action">Action</Label>
            <ActionSelect id="audit-action" value={action} facets={actions.data} loading={actions.isPending} failed={actions.isError} onChange={(v) => set({ action: v })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-type">Type d’objet</Label>
            <Select value={objectType || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
              <SelectTrigger id="audit-type" className="w-full">
                <SelectValue placeholder="Type d’objet" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{objectTypes.isError ? 'Tous (liste indisponible)' : 'Tous les types'}</SelectItem>
                {objectType && !(objectTypes.data ?? []).some((f) => f.objectType === objectType) ? <SelectItem value={objectType}>{objectTypeLabel(objectType)} (aucun sur la période)</SelectItem> : null}
                {(objectTypes.data ?? []).map((f) => (
                  <SelectItem key={f.objectType} value={f.objectType}>
                    {objectTypeLabel(f.objectType)} ({f.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-actor">Acteur</Label>
            <ActorSelect id="audit-actor" value={actor} facets={actors.data} failed={actors.isError} onChange={(v) => set({ acteur: v })} />
          </div>
          <ObjectIdFilter key={objectId} value={objectId} onSubmit={(v) => set({ objet: v })} />
          {filtered ? (
            <div className="flex items-end sm:col-span-2 lg:col-span-3 xl:col-span-6">
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => set({ du: '', au: '', action: '', type: '', objet: '', acteur: '' })}>
                Réinitialiser les filtres
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {events.isPending ? (
        <LoadingState label="Chargement du journal d’audit…" />
      ) : events.isError ? (
        <>
          <ErrorState error={events.error} retry={denied ? undefined : () => void events.refetch()} />
          {denied && companyId && isFleetManager ? (
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Le journal est limité aux sociétés dont vous êtes chef de parc : choisissez l’une d’elles, ou « Toutes mes sociétés », dans le sélecteur de société.
            </p>
          ) : null}
        </>
      ) : events.data.total === 0 ? (
        <EmptyState
          title="Aucun événement"
          description={filtered ? 'Aucun événement d’audit ne correspond aux filtres dans votre périmètre.' : 'Aucun événement d’audit n’est encore enregistré dans votre périmètre.'}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Acteur</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Objet</TableHead>
                {showCompany ? <TableHead>Société</TableHead> : null}
                <TableHead>Motif</TableHead>
                <TableHead>
                  <span className="sr-only">Détail</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.data.items.map((e) => {
                const href = objectHref(e.objectType, e.objectId, { isAdmin: session.isAdmin });
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap align-top">{formatDateTime(e.createdAt, session.timezone)}</TableCell>
                    <TableCell className="align-top">
                      {e.actorType === SYSTEM ? <StatusBadge label={e.actorName} tone="neutral" /> : e.actorName}
                    </TableCell>
                    <TableCell className="align-top">
                      <code className="font-mono text-xs">{e.action}</code>
                    </TableCell>
                    <TableCell className="align-top">
                      {href ? (
                        <Link href={href} className="underline-offset-4 hover:underline">
                          {objectTypeLabel(e.objectType)}
                        </Link>
                      ) : (
                        <span>{objectTypeLabel(e.objectType)}</span>
                      )}
                      {e.objectId ? (
                        <span className="block max-w-[14rem] truncate font-mono text-xs text-muted-foreground" title={e.objectId}>
                          {e.objectId}
                        </span>
                      ) : null}
                    </TableCell>
                    {showCompany ? <TableCell className="align-top">{e.companyCode ?? (e.companyId ? '—' : <span className="text-muted-foreground">Organisation</span>)}</TableCell> : null}
                    <TableCell className="max-w-xs whitespace-normal align-top">
                      {e.reason ? <span className="line-clamp-2" title={e.reason}>{e.reason}</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="align-top">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(e)}>
                        <Eye className="size-4" aria-hidden="true" /> Détail
                        <span className="sr-only">
                          {' '}
                          de l’événement {e.action} du {formatDateTime(e.createdAt, session.timezone)}
                        </span>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      <AuditEventDialog
        event={selected}
        timezone={session.timezone}
        isAdmin={session.isAdmin}
        onClose={() => setSelected(null)}
        onFilterObject={(e) => {
          setSelected(null);
          set({ type: e.objectType, objet: e.objectId ?? '', action: '', acteur: '', du: '', au: '' });
        }}
      />
    </div>
  );
}

/** Actions regroupées par famille (préfixe avant le premier point) ; la famille entière est filtrable (préfixe). */
function ActionSelect({
  id,
  value,
  facets,
  loading,
  failed,
  onChange,
}: {
  id: string;
  value: string;
  facets: AuditActionFacet[] | undefined;
  loading: boolean;
  failed: boolean;
  onChange: (value: string) => void;
}) {
  const families = new Map<string, AuditActionFacet[]>();
  for (const f of facets ?? []) {
    const family = f.action.includes('.') ? f.action.slice(0, f.action.indexOf('.')) : f.action;
    families.set(family, [...(families.get(family) ?? []), f]);
  }
  const known = new Set<string>();
  for (const [family, list] of families) {
    if (list.length > 1) known.add(`${family}.`);
    for (const f of list) known.add(f.action);
  }
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={loading ? 'Chargement…' : 'Action'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{failed ? 'Toutes (liste indisponible)' : 'Toutes les actions'}</SelectItem>
        {value && !known.has(value) ? <SelectItem value={value}>{value} (aucune sur la période)</SelectItem> : null}
        {[...families].map(([family, list]) => (
          <SelectGroup key={family}>
            <SelectLabel>{family}</SelectLabel>
            {list.length > 1 ? <SelectItem value={`${family}.`}>Toutes les actions « {family}.* »</SelectItem> : null}
            {list.map((f) => (
              <SelectItem key={f.action} value={f.action}>
                <span className="font-mono text-xs">{f.action}</span> ({f.count})
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActorSelect({ id, value, facets, failed, onChange }: { id: string; value: string; facets: AuditActorFacet[] | undefined; failed: boolean; onChange: (value: string) => void }) {
  // Un acteur « Système » regroupe les traitements sans utilisateur ; un utilisateur est filtré par son identifiant.
  const options = new Map<string, string>();
  for (const f of facets ?? []) {
    const key = f.actorType === SYSTEM ? SYSTEM : f.actorUserId;
    if (key && !options.has(key)) options.set(key, `${f.actorName} (${f.count})`);
  }
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Acteur" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{failed ? 'Tous (liste indisponible)' : 'Tous les acteurs'}</SelectItem>
        {value && !options.has(value) ? <SelectItem value={value}>Acteur filtré (aucun événement sur la période)</SelectItem> : null}
        {[...options].map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Identifiant exact de l'objet : appliqué à la validation (Entrée ou bouton), pas à chaque frappe. */
function ObjectIdFilter({ value, onSubmit }: { value: string; onSubmit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft.trim());
      }}
    >
      <Label htmlFor="audit-object-id">Identifiant de l’objet</Label>
      <div className="flex gap-1">
        <Input id="audit-object-id" value={draft} maxLength={200} placeholder="Identifiant exact" className="font-mono text-xs" onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="outline" size="icon" aria-label="Filtrer sur cet identifiant">
          <Search className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
