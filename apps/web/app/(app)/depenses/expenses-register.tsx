'use client';

import { useQuery } from '@tanstack/react-query';
import { Lock, MoreHorizontal, Paperclip, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EXPENSE_CATEGORY_LABELS } from '@parc-auto/contracts';
import { ALL } from '@/components/incidents/ops-helpers';
import { useAppScope, useCan } from '@/components/layout/session-context';
import { VehicleFilter } from '@/components/odometer/vehicle-filter';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import {
  EXPENSE_KIND_LABELS,
  EXPENSE_SOURCE_LABELS,
  EXPENSE_STATUS_FILTER_LABELS,
  EXPENSE_STATUS_LABELS,
  type ExpenseSourceFilter,
  type ExpenseStatusFilter,
  type ExpenseView,
} from '@/lib/expenses-types';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useListParams } from '@/lib/use-list-params';
import { isCivilDate } from '@/lib/zoned-time';
import { CancelExpenseDialog, CorrectExpenseDialog, OperatingCostDialog } from './expense-action-dialogs';
import { ExpenseFormDialog } from './expense-form-dialog';
import { companiesWith, costRightsIn } from './expense-rights';
import { ExpenseSummaryPanel } from './expense-summary';

const PAGE_SIZE = 25;
const SORTS: Record<string, { label: string; sort?: string; order?: 'asc' | 'desc' }> = {
  'date-desc': { label: 'Date (plus récente d’abord)' },
  'date-asc': { label: 'Date (plus ancienne d’abord)', sort: 'occurredOn', order: 'asc' },
  'montant-desc': { label: 'Montant décroissant', sort: 'amount', order: 'desc' },
  'montant-asc': { label: 'Montant croissant', sort: 'amount', order: 'asc' },
  'saisie-desc': { label: 'Saisie la plus récente', sort: 'createdAt', order: 'desc' },
};
const STATUS_FILTERS = Object.keys(EXPENSE_STATUS_FILTER_LABELS) as ExpenseStatusFilter[];
const SOURCE_FILTERS = Object.keys(EXPENSE_SOURCE_LABELS) as ExpenseSourceFilter[];

type ActionKind = 'corriger' | 'annuler' | 'exploitation';

function toneForStatus(status: string): 'success' | 'neutral' | 'danger' {
  return status === 'VALIDEE' ? 'success' : status === 'ANNULEE' ? 'danger' : 'neutral';
}

/**
 * Registre unique des dépenses (CDC 8.4, 10.2 : /depenses) : liste filtrable (filtres conservés dans
 * l'URL), synthèse exacte calculée par l'API, saisie, correction, annulation et bascule du coût
 * d'exploitation. Consultation réservée à costs.read, saisie à costs.write ; l'API revérifie tout.
 */
export function ExpensesRegister() {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const canRead = useCan('costs.read');
  const canWrite = useCan('costs.write');
  const [creating, setCreating] = useState(false);

  const createButton = canWrite ? (
    <Button onClick={() => setCreating(true)}>
      <Plus className="size-4" aria-hidden="true" /> Saisir une dépense
    </Button>
  ) : null;

  if (!canRead) {
    return (
      <div>
        <PageHeader title="Dépenses" description="Registre unique des dépenses et avoirs du parc." actions={createButton} />
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Consultation des coûts non autorisée</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {session.isDriverOnly
              ? 'Le registre des dépenses est réservé au personnel de gestion du parc. Vos tickets carburant se déclarent depuis « Mon véhicule ».'
              : canWrite
                ? 'Vous pouvez saisir une dépense, mais la consultation du registre et de la synthèse est réservée aux comptes disposant de la permission « Consulter les coûts » sur la société sélectionnée.'
                : 'Le registre des dépenses est réservé aux comptes disposant de la permission « Consulter les coûts » sur la société sélectionnée. Changez de société ou demandez cette permission à l’administrateur.'}
          </p>
        </div>
        {creating ? <ExpenseFormDialog defaultCompanyId={scopeCompanyId} onClose={() => setCreating(false)} /> : null}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Dépenses"
        description={`Registre unique des dépenses et avoirs : chaque coût reste imputé à la société qui gérait le véhicule à sa date. Montants TTC en ${session.currency}.`}
        actions={createButton}
      />
      <ExpensesContent />
      {creating ? <ExpenseFormDialog defaultCompanyId={scopeCompanyId} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function ExpensesContent() {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const { get, set, page } = useListParams();
  const readable = companiesWith(session, 'costs.read');
  const rawCompany = get('societe');
  const companyFilter = scopeCompanyId === null && readable.some((c) => c.id === rawCompany) ? rawCompany : '';
  const companyId = scopeCompanyId ?? (companyFilter || null);
  const vehicleId = get('vehicule');
  const unallocated = get('sansVehicule') === '1';
  const category = get('categorie');
  const kind = get('nature');
  const source = get('source');
  const status = (STATUS_FILTERS as string[]).includes(get('etat')) ? get('etat') : 'VALIDEE';
  const from = isCivilDate(get('du')) ? get('du') : '';
  const to = isCivilDate(get('au')) ? get('au') : '';
  const q = get('q');
  const sortKey = SORTS[get('tri')] ? get('tri') : 'date-desc';
  const sort = SORTS[sortKey];
  const [action, setAction] = useState<{ kind: ActionKind; expense: ExpenseView } | null>(null);

  // Mêmes filtres pour la liste et la synthèse (l'état ne s'applique qu'à la liste : la synthèse ne compte que les validées).
  const common = {
    companyId,
    vehicleId: unallocated ? undefined : vehicleId,
    unallocated: unallocated ? 'true' : undefined,
    category,
    kind,
    sourceType: source,
    from,
    to,
    q,
  };
  const summaryQuery = toQuery(common);
  const listQuery = toQuery({ ...common, status, sort: sort?.sort, order: sort?.order, page, pageSize: PAGE_SIZE });
  const expenses = useQuery({ queryKey: ['expenses', 'list', listQuery], queryFn: () => api<Page<ExpenseView>>(`/expenses${listQuery}`) });
  const filtered = Boolean(vehicleId || unallocated || category || kind || source || from || to || q || status !== 'VALIDEE' || companyFilter);
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';
  const money = (value: string, currency: string) => formatMoney(value, currency, session.currencyDecimals);

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {scopeCompanyId === null && readable.length > 1 ? (
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
                {readable.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="filter-vehicule" className="text-xs text-muted-foreground">
            Véhicule
          </Label>
          {unallocated ? (
            <p id="filter-vehicule" className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
              Dépenses sans véhicule
            </p>
          ) : (
            <VehicleFilter id="filter-vehicule" vehicleId={vehicleId} onChange={(v) => set({ vehicule: v })} />
          )}
          <div className="flex items-center gap-2 pt-1">
            <Switch id="filter-sans-vehicule" checked={unallocated} onCheckedChange={(checked) => set({ sansVehicule: checked ? '1' : '', vehicule: '' })} />
            <Label htmlFor="filter-sans-vehicule" className="text-xs font-normal">
              Sans véhicule uniquement (« Non ventilé »)
            </Label>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-categorie" className="text-xs text-muted-foreground">
            Catégorie
          </Label>
          <Select value={category || ALL} onValueChange={(v) => set({ categorie: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-categorie" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les catégories</SelectItem>
              {Object.entries(EXPENSE_CATEGORY_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-nature" className="text-xs text-muted-foreground">
            Nature
          </Label>
          <Select value={kind || ALL} onValueChange={(v) => set({ nature: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-nature" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Dépenses et avoirs</SelectItem>
              {Object.entries(EXPENSE_KIND_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-etat" className="text-xs text-muted-foreground">
            État
          </Label>
          <Select value={status} onValueChange={(v) => set({ etat: v === 'VALIDEE' ? '' : v })}>
            <SelectTrigger id="filter-etat" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((key) => (
                <SelectItem key={key} value={key}>
                  {EXPENSE_STATUS_FILTER_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-source" className="text-xs text-muted-foreground">
            Source
          </Label>
          <Select value={source || ALL} onValueChange={(v) => set({ source: v === ALL ? '' : v })}>
            <SelectTrigger id="filter-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Toutes les sources</SelectItem>
              {SOURCE_FILTERS.map((key) => (
                <SelectItem key={key} value={key}>
                  {EXPENSE_SOURCE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="filter-du" className="text-xs text-muted-foreground">
              Du
            </Label>
            <Input id="filter-du" type="date" value={from} onChange={(e) => set({ du: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-au" className="text-xs text-muted-foreground">
              Au
            </Label>
            <Input id="filter-au" type="date" value={to} onChange={(e) => set({ au: e.target.value })} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-q" className="text-xs text-muted-foreground">
            Recherche
          </Label>
          <Input id="filter-q" placeholder="Référence, fournisseur, notes" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-tri" className="text-xs text-muted-foreground">
            Tri
          </Label>
          <Select value={sortKey} onValueChange={(v) => set({ tri: v === 'date-desc' ? '' : v })}>
            <SelectTrigger id="filter-tri" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORTS).map(([key, s]) => (
                <SelectItem key={key} value={key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ExpenseSummaryPanel query={summaryQuery} />

      <section aria-labelledby="liste-depenses" className="space-y-3">
        <h2 id="liste-depenses" className="text-lg font-semibold">
          Écritures
        </h2>
        {expenses.isPending ? (
          <LoadingState label="Chargement des dépenses…" />
        ) : expenses.isError ? (
          <ErrorState error={expenses.error} retry={() => void expenses.refetch()} />
        ) : expenses.data.total === 0 ? (
          <EmptyState title="Aucune dépense" description={filtered ? 'Aucune écriture ne correspond aux filtres dans votre périmètre.' : 'Aucune dépense validée n’est enregistrée dans votre périmètre.'} />
        ) : (
          <div className="rounded-md border">
            <Table aria-label="Registre des dépenses">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Affectation</TableHead>
                  {companyId === null ? <TableHead>Société</TableHead> : null}
                  <TableHead>Catégorie</TableHead>
                  <TableHead>Fournisseur · référence</TableHead>
                  <TableHead className="text-right">Montant TTC</TableHead>
                  <TableHead>État</TableHead>
                  <TableHead>Justificatif</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenses.data.items.map((e) => {
                  const rights = costRightsIn(session, e.companyId);
                  const editable = e.status === 'VALIDEE' && rights.read && rights.write;
                  const manual = e.sourceType === null;
                  const canCorrect = editable && rights.manager && manual;
                  const name = `${e.categoryLabel} du ${formatDate(e.occurredOn)} (${money(e.signedAmount, e.currency)})`;
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/depenses/${e.id}`} className="underline-offset-4 hover:underline">
                          {formatDate(e.occurredOn)}
                          <span className="sr-only"> : détail de la dépense {name}</span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {e.vehicleId ? (
                          <Link href={`/vehicules/${e.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                            {e.allocationLabel}
                          </Link>
                        ) : (
                          <span className="font-medium">{e.allocationLabel}</span>
                        )}
                        {e.relatedIncidentId && e.relatedIncidentReference ? (
                          <Link href={`/incidents/${e.relatedIncidentId}`} className="block text-xs underline-offset-4 hover:underline">
                            Incident {e.relatedIncidentReference}
                          </Link>
                        ) : null}
                        {e.sourceType === 'INTERVENTION' && e.sourceId ? (
                          <Link href={`/interventions/${e.sourceId}`} className="block text-xs underline-offset-4 hover:underline">
                            Synthèse d’une intervention
                          </Link>
                        ) : e.sourceType === 'PLEIN' && e.sourceId ? (
                          <Link href={`/carburant/${e.sourceId}`} className="block text-xs underline-offset-4 hover:underline">
                            Synthèse d’un plein
                          </Link>
                        ) : null}
                      </TableCell>
                      {companyId === null ? <TableCell>{companyCode(e.companyId)}</TableCell> : null}
                      <TableCell>
                        {e.categoryLabel}
                        {e.kind === 'AVOIR' ? <StatusBadge label={EXPENSE_KIND_LABELS.AVOIR} tone="info" className="ml-2" /> : null}
                      </TableCell>
                      <TableCell className="max-w-56">
                        <span className="block truncate">{e.supplierName ?? '—'}</span>
                        {e.reference ? <span className="block truncate text-xs text-muted-foreground">Réf. {e.reference}</span> : null}
                        {e.notes ? (
                          <span className="block truncate text-xs text-muted-foreground" title={e.notes}>
                            {e.notes}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap">{money(e.signedAmount, e.currency)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge label={EXPENSE_STATUS_LABELS[e.status] ?? e.status} tone={toneForStatus(e.status)} />
                          {e.excludedFromOperatingCost ? <StatusBadge label="Hors coût d’exploitation" tone="warning" /> : null}
                        </div>
                        {e.status === 'ANNULEE' ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            le {formatDateTime(e.cancelledAt, session.timezone)}
                            {e.cancelReason ? ` — ${e.cancelReason}` : ''}
                          </span>
                        ) : null}
                        {e.replacesExpenseId ? <span className="mt-1 block text-xs text-muted-foreground">Version corrigée</span> : null}
                      </TableCell>
                      <TableCell>
                        {e.attachmentId ? (
                          <a href={`/api/v1/attachments/${e.attachmentId}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
                            <Paperclip className="size-3.5" aria-hidden="true" /> Ouvrir<span className="sr-only"> le justificatif de la dépense {name}</span>
                          </a>
                        ) : (
                          <span className="text-sm text-muted-foreground">Aucun</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {editable ? (
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions sur la dépense ${name}`}>
                                <MoreHorizontal aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {canCorrect ? (
                                <>
                                  <DropdownMenuItem onSelect={() => setAction({ kind: 'corriger', expense: e })}>Corriger</DropdownMenuItem>
                                  <DropdownMenuItem variant="destructive" onSelect={() => setAction({ kind: 'annuler', expense: e })}>
                                    Annuler la dépense
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              ) : null}
                              <DropdownMenuItem onSelect={() => setAction({ kind: 'exploitation', expense: e })}>
                                {e.excludedFromOperatingCost ? 'Inclure dans le coût d’exploitation' : 'Exclure du coût d’exploitation'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationControls page={expenses.data.page} pageSize={expenses.data.pageSize} total={expenses.data.total} onPageChange={(p) => set({ page: p })} />
          </div>
        )}
      </section>

      {action?.kind === 'corriger' ? <CorrectExpenseDialog expense={action.expense} onClose={() => setAction(null)} /> : null}
      {action?.kind === 'annuler' ? <CancelExpenseDialog expense={action.expense} onClose={() => setAction(null)} /> : null}
      {action?.kind === 'exploitation' ? <OperatingCostDialog expense={action.expense} onClose={() => setAction(null)} /> : null}
    </>
  );
}
