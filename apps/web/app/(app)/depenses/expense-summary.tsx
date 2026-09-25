'use client';

import { useQuery } from '@tanstack/react-query';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import type { ExpenseLabelledBucket, ExpenseSummary } from '@/lib/expenses-types';
import { formatMoney } from '@/lib/format';

/**
 * Synthèse exacte du registre (GET /expenses/summary) : totaux calculés par l'API sur les dépenses
 * validées (annulées et remplacées exclues), par catégorie, avec la ligne « Non ventilé » et les
 * dépenses hors coût d'exploitation présentées à part. Le web n'additionne rien.
 */
export function ExpenseSummaryPanel({ query }: { query: string }) {
  const { session } = useAppScope();
  const summary = useQuery({ queryKey: ['expenses', 'summary', query], queryFn: () => api<ExpenseSummary>(`/expenses/summary${query}`) });
  const money = (value: string, currency: string) => formatMoney(value, currency, session.currencyDecimals);

  return (
    <section aria-labelledby="synthese-depenses" className="mb-6 space-y-4">
      <h2 id="synthese-depenses" className="text-lg font-semibold">
        Synthèse
      </h2>
      {summary.isPending ? (
        <LoadingState label="Calcul de la synthèse…" />
      ) : summary.isError ? (
        <ErrorState error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <BucketCard testId="synthese-exploitation" bucket={summary.data.operating} currency={summary.data.currency} money={money} description="Dépenses − avoirs validés, dépenses sans véhicule comprises." />
            <BucketCard testId="synthese-non-ventile" bucket={summary.data.unallocated} currency={summary.data.currency} money={money} description="Part du coût d’exploitation sans véhicule, jamais répartie." />
            <BucketCard testId="synthese-hors-exploitation" bucket={summary.data.excludedFromOperatingCost} currency={summary.data.currency} money={money} description="Conservées à titre informatif (achats de véhicules par défaut)." />
          </div>
          {summary.data.byCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune dépense validée comptée dans le coût d’exploitation pour ces filtres.</p>
          ) : (
            <div className="rounded-md border">
              <Table aria-label="Coût d’exploitation par catégorie">
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
                  {summary.data.byCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell>{c.label}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{money(c.expenses, summary.data.currency)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{money(c.credits, summary.data.currency)}</TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap">{money(c.net, summary.data.currency)}</TableCell>
                      <TableCell className="text-right">{c.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Synthèse des seules dépenses validées correspondant aux filtres de la liste (société, véhicule ou « sans véhicule », catégorie, nature, source, période et recherche) ; l’état ne filtre que la liste. Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale.
          </p>
        </>
      )}
    </section>
  );
}

function BucketCard({ testId, bucket, currency, money, description }: { testId: string; bucket: ExpenseLabelledBucket; currency: string; money: (v: string, c: string) => string; description: string }) {
  return (
    <Card className="gap-2" data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{bucket.label}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold">{money(bucket.net, currency)}</p>
        <p className="text-xs text-muted-foreground">
          Dépenses {money(bucket.expenses, currency)} · avoirs {money(bucket.credits, currency)} · {bucket.count} écriture{bucket.count > 1 ? 's' : ''}
        </p>
      </CardContent>
    </Card>
  );
}
