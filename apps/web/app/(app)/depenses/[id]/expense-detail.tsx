'use client';

import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { EXPENSE_KIND_LABELS, EXPENSE_STATUS_LABELS, type ExpenseView } from '@/lib/expenses-types';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { CancelExpenseDialog, CorrectExpenseDialog, OperatingCostDialog } from '../expense-action-dialogs';
import { costRightsIn } from '../expense-rights';

type ActionKind = 'corriger' | 'annuler' | 'exploitation';

function toneForStatus(status: string): 'success' | 'neutral' | 'danger' {
  return status === 'VALIDEE' ? 'success' : status === 'ANNULEE' ? 'danger' : 'neutral';
}

/**
 * Détail d'une dépense (GET /expenses/:id, costs.read ; hors périmètre : introuvable) : montant, source,
 * justificatif, et navigation dans la chaîne des corrections (version remplacée ↔ version corrigée). Les
 * actions ne sont qu'un confort d'affichage : l'API revérifie droits, état et version.
 */
export function ExpenseDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const expense = useQuery({ queryKey: ['expenses', 'detail', id], queryFn: () => api<ExpenseView>(`/expenses/${id}`) });
  const [action, setAction] = useState<ActionKind | null>(null);

  if (expense.isPending) return <LoadingState label="Chargement de la dépense…" />;
  if (expense.isError) return <ErrorState error={expense.error} retry={() => void expense.refetch()} />;
  const e = expense.data;
  const rights = costRightsIn(session, e.companyId);
  const editable = e.status === 'VALIDEE' && rights.read && rights.write;
  const canCorrect = editable && rights.manager && e.sourceType === null;
  const companyCode = session.companies.find((c) => c.id === e.companyId)?.code ?? '—';
  const money = (value: string) => formatMoney(value, e.currency, session.currencyDecimals);

  return (
    <div>
      <PageHeader
        title={`${e.kind === 'AVOIR' ? 'Avoir' : e.categoryLabel} du ${formatDate(e.occurredOn)}`}
        description={`${e.allocationLabel} · Société ${companyCode}`}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/depenses">Registre des dépenses</Link>
            </Button>
            {canCorrect ? <Button onClick={() => setAction('corriger')}>Corriger</Button> : null}
            {canCorrect ? (
              <Button variant="outline" onClick={() => setAction('annuler')}>
                Annuler la dépense
              </Button>
            ) : null}
            {editable ? (
              <Button variant="outline" onClick={() => setAction('exploitation')}>
                {e.excludedFromOperatingCost ? 'Inclure dans le coût d’exploitation' : 'Exclure du coût d’exploitation'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={EXPENSE_STATUS_LABELS[e.status] ?? e.status} tone={toneForStatus(e.status)} />
        {e.kind === 'AVOIR' ? <StatusBadge label={EXPENSE_KIND_LABELS.AVOIR} tone="info" /> : null}
        {e.excludedFromOperatingCost ? <StatusBadge label="Hors coût d’exploitation" tone="warning" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Écriture</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Item label="Montant TTC">
                <span className="font-medium">{money(e.signedAmount)}</span>
                {e.kind === 'AVOIR' ? <span className="block text-xs text-muted-foreground">Avoir de {money(e.amount)} : réduit le coût, ce n’est pas un paiement.</span> : null}
              </Item>
              <Item label="Date">{formatDate(e.occurredOn)}</Item>
              <Item label="Catégorie">{e.categoryLabel}</Item>
              <Item label="Affectation">
                {e.vehicleId ? (
                  <Link href={`/vehicules/${e.vehicleId}`} className="underline underline-offset-4">
                    {e.allocationLabel}
                  </Link>
                ) : (
                  e.allocationLabel
                )}
              </Item>
              <Item label="Fournisseur">{e.supplierName ?? '—'}</Item>
              <Item label="Référence">{e.reference ?? '—'}</Item>
              <Item label="Source">
                {e.sourceType === 'PLEIN' && e.sourceId ? (
                  <Link href={`/carburant/${e.sourceId}`} className="underline underline-offset-4">
                    Synthèse d’un plein
                  </Link>
                ) : e.sourceType === 'INTERVENTION' && e.sourceId ? (
                  <Link href={`/interventions/${e.sourceId}`} className="underline underline-offset-4">
                    Synthèse d’une intervention
                  </Link>
                ) : (
                  'Saisie manuelle'
                )}
              </Item>
              <Item label="Justificatif">
                {e.attachmentId ? (
                  <a href={`/api/v1/attachments/${e.attachmentId}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
                    <Paperclip className="size-3.5" aria-hidden="true" /> Ouvrir le justificatif
                  </a>
                ) : (
                  'Aucun'
                )}
              </Item>
              {e.relatedIncidentId && e.relatedIncidentReference ? (
                <Item label="Incident">
                  <Link href={`/incidents/${e.relatedIncidentId}`} className="underline underline-offset-4">
                    Incident {e.relatedIncidentReference}
                  </Link>
                </Item>
              ) : null}
              {e.relatedExpenseId ? (
                <Item label="Dépense d’origine">
                  <Link href={`/depenses/${e.relatedExpenseId}`} className="underline underline-offset-4">
                    Voir la dépense d’origine
                  </Link>
                </Item>
              ) : null}
              {e.notes ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="whitespace-pre-wrap">{e.notes}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Versions et suivi</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm" aria-label="Chaîne des corrections">
              {e.replacesExpenseId ? (
                <li>
                  <span className="text-muted-foreground">Corrige </span>
                  <Link href={`/depenses/${e.replacesExpenseId}`} className="underline underline-offset-4">
                    la version précédente
                  </Link>
                </li>
              ) : (
                <li className="text-muted-foreground">Version d’origine</li>
              )}
              <li>
                <span className="text-muted-foreground">Saisie le </span>
                {formatDateTime(e.createdAt, session.timezone)}
              </li>
              {e.replacedByExpenseId ? (
                <li>
                  <span className="text-muted-foreground">Remplacée par </span>
                  <Link href={`/depenses/${e.replacedByExpenseId}`} className="underline underline-offset-4">
                    la version corrigée
                  </Link>
                </li>
              ) : null}
              {e.status === 'ANNULEE' ? (
                <li>
                  <span className="text-muted-foreground">Annulée le </span>
                  {formatDateTime(e.cancelledAt, session.timezone)}
                  {e.cancelReason ? <span className="block">Motif : {e.cancelReason}</span> : null}
                </li>
              ) : null}
            </ol>
            <p className="mt-4 text-xs text-muted-foreground">Une dépense validée n’est jamais modifiée : une correction crée une nouvelle version, une annulation la retire des totaux de sa période d’origine.</p>
          </CardContent>
        </Card>
      </div>

      {action === 'corriger' ? <CorrectExpenseDialog expense={e} onClose={() => setAction(null)} /> : null}
      {action === 'annuler' ? <CancelExpenseDialog expense={e} onClose={() => setAction(null)} /> : null}
      {action === 'exploitation' ? <OperatingCostDialog expense={e} onClose={() => setAction(null)} /> : null}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
