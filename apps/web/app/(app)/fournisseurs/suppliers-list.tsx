'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { ALL, rightsIn, useOpsRights } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page, SessionInfo } from '@/lib/api-types';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { SUPPLIER_STATUS_LABELS, type SupplierExpenseRow, type SupplierStatus, type SupplierView } from '@/lib/suppliers-types';
import { useListParams } from '@/lib/use-list-params';
import { SupplierDialog } from './supplier-dialog';

type Pending = { kind: 'create' } | { kind: 'edit'; supplier: SupplierView } | { kind: 'status'; supplier: SupplierView } | { kind: 'copy'; supplier: SupplierView } | { kind: 'view'; supplier: SupplierView } | null;

/**
 * Sociétés de destination possibles pour « Copier vers une autre société » (D-221) : sociétés actives,
 * autres que celle du fournisseur, où l'utilisateur est chef de parc (toutes pour l'administrateur).
 * Simple masquage de l'action : l'API revérifie les deux sociétés.
 */
function copyTargets(session: SessionInfo, supplier: SupplierView): Array<{ id: string; code: string; name: string }> {
  if (supplier.status !== 'ACTIF' || !rightsIn(session, supplier.companyId).manager) return [];
  const others = session.companies.filter((c) => c.status !== 'ARCHIVE' && c.id !== supplier.companyId);
  if (session.isAdmin) return others;
  const managed = new Set(session.grants.filter((g) => g.role === 'CHEF_PARC' || g.role === 'ADMIN').map((g) => g.companyId));
  return others.filter((c) => managed.has(c.id));
}

/** Répertoire des fournisseurs par société (CDC 8.1, D-221) : filtres dans l'URL, création, modification, archivage. */
export function SuppliersList() {
  const { companyId, session } = useAppScope();
  const rights = useOpsRights(companyId);
  const { get, set, page } = useListParams();
  const q = get('q');
  const categorie = get('categorie');
  // Actifs par défaut (comme l'API) ; « ARCHIVE » affiche les fournisseurs archivés.
  const statut = (get('statut') || 'ACTIF') as SupplierStatus;
  const [pending, setPending] = useState<Pending>(null);
  const query = toQuery({ companyId, q, category: categorie, status: statut, page, pageSize: 25 });
  const suppliers = useQuery({ queryKey: ['suppliers', query], queryFn: () => api<Page<SupplierView>>(`/suppliers${query}`) });
  const filtered = Boolean(q || categorie);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <div>
      <PageHeader
        title="Fournisseurs"
        description="Garages, stations, assureurs et loueurs de chaque société. Un fournisseur archivé n’est plus proposé dans les nouvelles saisies mais reste visible dans l’historique."
        actions={
          rights.operational ? (
            <Button onClick={() => setPending({ kind: 'create' })}>
              <Plus className="size-4" aria-hidden="true" /> Nouveau fournisseur
            </Button>
          ) : null
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
            Recherche
          </Label>
          <Input id="filter-q" placeholder="Nom ou contact" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-categorie" className="text-xs text-muted-foreground">
            Catégorie
          </Label>
          <Select value={categorie || ALL} onValueChange={(v) => set({ categorie: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-categorie" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les catégories</SelectItem>
              {Object.entries(SUPPLIER_CATEGORY_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-statut" className="text-xs text-muted-foreground">
            Statut
          </Label>
          <Select value={statut} onValueChange={(v) => set({ statut: v === 'ACTIF' ? '' : v })}>
            <SelectTrigger id="filter-statut" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SUPPLIER_STATUS_LABELS) as SupplierStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {k === 'ACTIF' ? 'Actifs' : 'Archivés'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {suppliers.isPending ? (
        <LoadingState label="Chargement des fournisseurs…" />
      ) : suppliers.isError ? (
        <ErrorState error={suppliers.error} retry={() => void suppliers.refetch()} />
      ) : suppliers.data.total === 0 ? (
        <EmptyState
          title={statut === 'ARCHIVE' ? 'Aucun fournisseur archivé' : 'Aucun fournisseur'}
          description={filtered ? 'Aucun fournisseur ne correspond aux filtres dans votre périmètre.' : statut === 'ARCHIVE' ? 'Aucun fournisseur n’a été archivé dans votre périmètre.' : 'Le répertoire de votre périmètre est vide.'}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Catégorie</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Contact</TableHead>
                <TableHead>Téléphone</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.data.items.map((s) => {
                const r = rightsIn(session, s.companyId);
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <button type="button" className="text-left font-medium underline-offset-4 hover:underline" onClick={() => setPending({ kind: 'view', supplier: s })}>
                        {s.name}
                      </button>
                    </TableCell>
                    <TableCell>{SUPPLIER_CATEGORY_LABELS[s.category] ?? s.category}</TableCell>
                    {companyId === null ? <TableCell>{companyCode(s.companyId)}</TableCell> : null}
                    <TableCell>{s.contactName ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{s.phone ? <a href={`tel:${s.phone}`} className="underline-offset-4 hover:underline">{s.phone}</a> : '—'}</TableCell>
                    <TableCell>{s.email ? <a href={`mailto:${s.email}`} className="underline-offset-4 hover:underline">{s.email}</a> : '—'}</TableCell>
                    <TableCell>
                      <StatusBadge label={SUPPLIER_STATUS_LABELS[s.status] ?? s.status} tone={s.status === 'ACTIF' ? 'success' : 'neutral'} />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions pour ${s.name}`}>
                            <MoreHorizontal className="size-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setPending({ kind: 'view', supplier: s })}>Voir la fiche</DropdownMenuItem>
                          {r.operational ? <DropdownMenuItem onSelect={() => setPending({ kind: 'edit', supplier: s })}>Modifier</DropdownMenuItem> : null}
                          {copyTargets(session, s).length > 0 ? <DropdownMenuItem onSelect={() => setPending({ kind: 'copy', supplier: s })}>Copier vers une autre société</DropdownMenuItem> : null}
                          {r.manager ? <DropdownMenuItem onSelect={() => setPending({ kind: 'status', supplier: s })}>{s.status === 'ACTIF' ? 'Archiver' : 'Réactiver'}</DropdownMenuItem> : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={suppliers.data.page} pageSize={suppliers.data.pageSize} total={suppliers.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}

      {pending?.kind === 'create' ? <SupplierDialog onOpenChange={(o) => !o && setPending(null)} /> : null}
      {pending?.kind === 'edit' ? <SupplierDialog supplier={pending.supplier} onOpenChange={(o) => !o && setPending(null)} /> : null}
      {pending?.kind === 'status' ? <StatusDialog supplier={pending.supplier} onOpenChange={(o) => !o && setPending(null)} /> : null}
      {pending?.kind === 'copy' ? <CopyDialog supplier={pending.supplier} onOpenChange={(o) => !o && setPending(null)} /> : null}
      {pending?.kind === 'view' ? (
        <SupplierSheet
          supplier={pending.supplier}
          onOpenChange={(o) => !o && setPending(null)}
          onEdit={() => setPending({ kind: 'edit', supplier: pending.supplier })}
          onStatus={() => setPending({ kind: 'status', supplier: pending.supplier })}
          onCopy={() => setPending({ kind: 'copy', supplier: pending.supplier })}
        />
      ) : null}
    </div>
  );
}

/** Fiche d'un fournisseur : contact, adresse, notes et actions autorisées. */
function SupplierSheet({ supplier: s, onOpenChange, onEdit, onStatus, onCopy }: { supplier: SupplierView; onOpenChange: (open: boolean) => void; onEdit: () => void; onStatus: () => void; onCopy: () => void }) {
  const { session } = useAppScope();
  const r = rightsIn(session, s.companyId);
  const company = session.companies.find((c) => c.id === s.companyId);
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{s.name}</SheetTitle>
          <SheetDescription>
            {SUPPLIER_CATEGORY_LABELS[s.category] ?? s.category}
            {company ? ` · Société ${company.code}` : ''}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4 text-sm">
          <StatusBadge label={SUPPLIER_STATUS_LABELS[s.status] ?? s.status} tone={s.status === 'ACTIF' ? 'success' : 'neutral'} />
          <dl className="grid gap-3">
            <div>
              <dt className="text-muted-foreground">Contact</dt>
              <dd>{s.contactName ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Téléphone</dt>
              <dd>{s.phone ? <a href={`tel:${s.phone}`} className="underline underline-offset-4">{s.phone}</a> : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">E-mail</dt>
              <dd className="break-words">{s.email ? <a href={`mailto:${s.email}`} className="underline underline-offset-4">{s.email}</a> : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Adresse</dt>
              <dd className="whitespace-pre-wrap">{s.address ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap">{s.notes ?? '—'}</dd>
            </div>
            {s.archivedAt ? (
              <div>
                <dt className="text-muted-foreground">Archivé le</dt>
                <dd>{formatDateTime(s.archivedAt, session.timezone)}</dd>
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-2">
            {r.operational ? (
              <Button type="button" variant="outline" onClick={onEdit}>
                Modifier
              </Button>
            ) : null}
            {r.manager ? (
              <Button type="button" variant="outline" onClick={onStatus}>
                {s.status === 'ACTIF' ? 'Archiver' : 'Réactiver'}
              </Button>
            ) : null}
            {copyTargets(session, s).length > 0 ? (
              <Button type="button" variant="outline" onClick={onCopy}>
                Copier vers une autre société
              </Button>
            ) : null}
          </div>
          <SupplierExpenses supplier={s} canReadCosts={r.can('costs.read')} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Historique autorisé du fournisseur (CDC 10.2) : dépenses validées du registre qui le référencent
 * (GET /expenses?companyId=&supplierId=), visibles avec la permission costs.read seulement.
 */
function SupplierExpenses({ supplier, canReadCosts }: { supplier: SupplierView; canReadCosts: boolean }) {
  const { session } = useAppScope();
  const [page, setPage] = useState(1);
  const query = toQuery({ companyId: supplier.companyId, supplierId: supplier.id, page, pageSize: 10 });
  const expenses = useQuery({
    queryKey: ['expenses', 'fournisseur', supplier.id, query],
    queryFn: () => api<Page<SupplierExpenseRow>>(`/expenses${query}`),
    enabled: canReadCosts,
  });

  return (
    <section aria-labelledby="supplier-history-title" className="space-y-2 border-t pt-4">
      <h3 id="supplier-history-title" className="font-medium">
        Historique des dépenses
      </h3>
      {!canReadCosts ? (
        <p className="text-muted-foreground">Coûts non visibles avec vos habilitations : l’historique des dépenses de ce fournisseur n’est pas affiché.</p>
      ) : expenses.isPending ? (
        <LoadingState label="Chargement de l’historique…" />
      ) : expenses.isError ? (
        <ErrorState error={expenses.error} retry={() => void expenses.refetch()} />
      ) : expenses.data.total === 0 ? (
        <EmptyState title="Aucune dépense" description="Aucune dépense validée ne référence ce fournisseur." />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Dépenses validées du registre, de la plus récente à la plus ancienne. Montants fournis par le serveur.</p>
          <ul className="space-y-2">
            {expenses.data.items.map((e) => (
              <li key={e.id} className="rounded-md border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/depenses/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                      {e.categoryLabel}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(e.occurredOn, session.timezone)} · {e.allocationLabel}
                      {e.reference ? ` · Réf. ${e.reference}` : ''}
                    </p>
                    {e.sourceType === 'INTERVENTION' && e.sourceId ? (
                      <Link href={`/interventions/${e.sourceId}`} className="text-xs underline underline-offset-4">
                        Voir l’intervention
                      </Link>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-medium tabular-nums">{formatMoney(e.signedAmount, e.currency, session.currencyDecimals)}</p>
                    {e.kind === 'AVOIR' ? <StatusBadge label="Avoir" tone="info" /> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <PaginationControls page={expenses.data.page} pageSize={expenses.data.pageSize} total={expenses.data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}

/** Archivage ou réactivation (POST /suppliers/:id/archive|restore, expectedVersion), après confirmation. */
function StatusDialog({ supplier, onOpenChange }: { supplier: SupplierView; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const archive = supplier.status === 'ACTIF';
  const mutation = useMutation({
    mutationFn: () => api<SupplierView>(`/suppliers/${supplier.id}/${archive ? 'archive' : 'restore'}`, { method: 'POST', body: { expectedVersion: supplier.version } }),
    onSuccess: (saved) => {
      toast.success(archive ? `Fournisseur « ${saved.name} » archivé.` : `Fournisseur « ${saved.name} » réactivé.`);
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Action impossible.');
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
        if (error.code === 'VERSION_OBSOLETE') onOpenChange(false);
      }
    },
  });
  return (
    <AlertDialog open onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archive ? `Archiver « ${supplier.name} » ?` : `Réactiver « ${supplier.name} » ?`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {archive ? (
                <p>Le fournisseur ne sera plus proposé dans les nouvelles saisies (interventions, pleins, dépenses, immobilisations). Son historique est conservé et il pourra être réactivé.</p>
              ) : (
                <p>Le fournisseur sera de nouveau proposé dans les saisies de sa société.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.error ? <ApiErrorAlert error={mutation.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Annuler</AlertDialogCancel>
          <Button type="button" variant={archive ? 'destructive' : 'default'} disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Traitement…' : archive ? 'Archiver' : 'Réactiver'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * « Copier vers une autre société » (POST /suppliers/:id/copy, D-221) : nouvelle fiche active dans la
 * société choisie, sans historique ni montants. Un homonyme actif dans la destination est refusé (409).
 */
function CopyDialog({ supplier, onOpenChange }: { supplier: SupplierView; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const targets = copyTargets(session, supplier);
  const [companyId, setCompanyId] = useState(targets.length === 1 ? (targets[0]?.id ?? '') : '');
  const [local, setLocal] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api<SupplierView>(`/suppliers/${supplier.id}/copy`, { method: 'POST', body: { companyId } }),
    onSuccess: (copy) => {
      const code = session.companies.find((c) => c.id === copy.companyId)?.code ?? '';
      toast.success(`Fournisseur « ${copy.name} » copié vers la société ${code}.`);
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onOpenChange(false);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Copie impossible.'),
  });
  const fieldError = local ?? (isApiError(mutation.error) ? (mutation.error.fieldErrors.companyId?.[0] ?? null) : null);
  return (
    <AlertDialog open onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Copier « {supplier.name} » vers une autre société</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Une nouvelle fiche active est créée dans la société choisie avec le nom, la catégorie, le contact, les coordonnées et les notes.</p>
              <p>L’historique (dépenses, interventions, pleins) et les montants ne sont pas copiés ; les deux fiches restent indépendantes.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="copy-company">Société de destination *</Label>
          <Select
            value={companyId}
            onValueChange={(v) => {
              setCompanyId(v);
              setLocal(null);
            }}
          >
            <SelectTrigger id="copy-company" className="w-full" aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? 'copy-company-error' : undefined}>
              <SelectValue placeholder="Choisir une société" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldError ? (
            <p id="copy-company-error" className="text-sm text-destructive">
              {fieldError}
            </p>
          ) : null}
        </div>
        {mutation.error ? <ApiErrorAlert error={mutation.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Annuler</AlertDialogCancel>
          <Button
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              if (!companyId) {
                setLocal('Choisissez la société de destination.');
                return;
              }
              mutation.mutate();
            }}
          >
            {mutation.isPending ? 'Copie…' : 'Copier'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
