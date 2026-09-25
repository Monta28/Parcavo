'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { IMPORT_BATCH_STATUS_LABELS, type ImportBatchView, type ImportCounts, type ImportModel } from '@/lib/imports-types';
import { useListParams } from '@/lib/use-list-params';
import { AbandonImportDialog } from './abandon-dialog';
import { ColumnMappingForm, isSameMapping } from './column-mapping';
import { ImportGuaranteesReminder } from './import-help';
import { ImportRows } from './import-rows';
import { toneForBatch } from './import-tones';

/**
 * Un lot d'import (?lot=<id>) : association des colonnes, contrôle, confirmation et rapport (étapes 3 à 6).
 * La clé d'idempotence de la confirmation est tirée une seule fois pour le lot affiché et réutilisée à
 * chaque nouvel essai : un double clic ou une reprise après coupure n'importe le lot qu'une fois.
 */
export function BatchPanel({ batchId, models }: { batchId: string; models: ImportModel[] }) {
  const { set } = useListParams();
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [commitProblem, setCommitProblem] = useState<string | null>(null);
  const batch = useQuery({ queryKey: ['import', batchId], queryFn: () => api<ImportBatchView>(`/imports/${batchId}`) });
  const model = batch.data ? models.find((m) => m.kind === batch.data.kind) : undefined;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => set({ lot: '' })}>
        <ArrowLeft className="size-4" aria-hidden="true" /> Retour aux imports
      </Button>
      {batch.isPending ? (
        <LoadingState label="Chargement du lot…" />
      ) : batch.isError ? (
        <ErrorState error={batch.error} retry={() => void batch.refetch()} />
      ) : !model ? (
        <ErrorState error={new Error('Modèle d’import inconnu.')} />
      ) : (
        <BatchWorkspace
          // Nouvelle version du lot (contrôle, refus de confirmation, confirmation, abandon) : l'association
          // affichée repart de celle enregistrée par l'API.
          key={`${batch.data.id}:${batch.data.version}`}
          batch={batch.data}
          model={model}
          idempotencyKey={idempotencyKey}
          commitProblem={commitProblem}
          onCommitProblem={setCommitProblem}
        />
      )}
    </div>
  );
}

function BatchWorkspace({
  batch,
  model,
  idempotencyKey,
  commitProblem,
  onCommitProblem,
}: {
  batch: ImportBatchView;
  model: ImportModel;
  idempotencyKey: string;
  commitProblem: string | null;
  onCommitProblem: (message: string | null) => void;
}) {
  const { session } = useAppScope();
  const { set } = useListParams();
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>(() => ({ ...(batch.columnMapping ?? {}) }));
  const [abandonOpen, setAbandonOpen] = useState(false);
  const open = batch.status === 'TELEVERSE' || batch.status === 'CONTROLE';
  const confirmed = batch.status === 'CONFIRME';

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['import', batch.id] });
    void queryClient.invalidateQueries({ queryKey: ['import-rows', batch.id] });
    void queryClient.invalidateQueries({ queryKey: ['imports'] });
  };

  const commit = useMutation({
    mutationFn: () => api<ImportBatchView>(`/imports/${batch.id}/commit`, { method: 'POST', idempotencyKey }),
    onSuccess: (updated) => {
      onCommitProblem(null);
      toast.success(`Import confirmé : ${updated.counts?.valid ?? 0} ligne(s) importée(s).`);
      queryClient.setQueryData(['import', updated.id], updated);
      // Véhicules, conducteurs, relevés, plans et alertes ont pu changer : tous les écrans se rechargent.
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      // Coupure réseau (0) ou relais/passerelle indisponible (502 à 504) : l'issue est incertaine, mais
      // la même clé d'idempotence garantit qu'un nouvel essai n'importe le lot qu'une fois.
      if (isApiError(error) && (error.status === 0 || (error.status >= 502 && error.status <= 504))) {
        onCommitProblem('La confirmation n’a pas pu aboutir ou sa réponse n’a pas été reçue. Vous pouvez réessayer sans risque : le lot ne sera importé qu’une seule fois.');
      } else if (isApiError(error) && error.code === 'LOT_INVALIDE') {
        onCommitProblem(`${error.message} Le résultat ci-dessous a été rechargé : aucune ligne n’a été importée.`);
      } else {
        onCommitProblem(isApiError(error) ? error.message : 'Confirmation impossible.');
      }
      refresh();
    },
  });

  // Un contrôle en cours (étape 3) bloque la confirmation et l'abandon jusqu'à son résultat.
  const validating = useIsMutating({ mutationKey: ['import-validate', batch.id] }) > 0;
  const dirty = batch.status === 'CONTROLE' && !isSameMapping(mapping, batch.columnMapping);
  const canCommit = batch.status === 'CONTROLE' && batch.errorCount === 0 && batch.counts !== null && !dirty && !validating;

  return (
    <div className="space-y-6">
      <section aria-labelledby="import-batch-title" className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="import-batch-title" className="text-lg font-semibold break-all">
              {batch.fileName}
            </h2>
            <p className="text-sm text-muted-foreground">
              {model.label} · {batch.rowCount} ligne{batch.rowCount > 1 ? 's' : ''} de données · téléversé le {formatDateTime(batch.createdAt, session.timezone)}
              {batch.createdByName ? ` par ${batch.createdByName}` : ''}
            </p>
            {batch.validatedAt ? <p className="text-sm text-muted-foreground">Dernier contrôle le {formatDateTime(batch.validatedAt, session.timezone)}</p> : null}
            {batch.committedAt ? <p className="text-sm text-muted-foreground">Confirmé le {formatDateTime(batch.committedAt, session.timezone)}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={IMPORT_BATCH_STATUS_LABELS[batch.status]} tone={toneForBatch(batch.status)} />
            {batch.counts ? (
              <Button asChild variant="outline" size="sm">
                <a href={`/api/v1/imports/${batch.id}/report`} download>
                  <Download className="size-4" aria-hidden="true" /> Rapport CSV
                </a>
              </Button>
            ) : null}
            {open ? (
              <Button variant="outline" size="sm" onClick={() => setAbandonOpen(true)} disabled={commit.isPending || validating}>
                Abandonner
              </Button>
            ) : null}
          </div>
        </div>
        {batch.warnings.length > 0 ? (
          <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" aria-hidden="true" /> Avertissement
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {batch.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {batch.status === 'ABANDONNE' ? <p className="text-sm text-muted-foreground">Ce lot a été abandonné : aucune ligne n’a été importée. Pour réessayer, téléversez à nouveau le fichier.</p> : null}
      </section>

      {open ? (
        <ColumnMappingForm
          batch={batch}
          model={model}
          mapping={mapping}
          onChange={setMapping}
          disabled={commit.isPending}
          onValidated={() => onCommitProblem(null)}
        />
      ) : null}

      {batch.counts ? (
        <section aria-labelledby="import-result-title" className="space-y-4 rounded-lg border p-4">
          <div>
            <h2 id="import-result-title" className="text-lg font-semibold">
              {confirmed ? 'Rapport d’import' : '4. Aperçu et résultat du contrôle'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {confirmed
                ? 'Lignes importées, lignes ignorées et avertissements. Le rapport CSV reprend chaque message par ligne et par colonne.'
                : 'Aperçu des valeurs lues dans le fichier pour chaque colonne associée, avec le résultat du contrôle. Aucune ligne n’a encore été écrite ; chaque erreur indique la ligne du fichier et la colonne concernée.'}
            </p>
          </div>
          <CountsSummary counts={batch.counts} confirmed={confirmed} />
          <ImportRows batch={batch} model={model} />
        </section>
      ) : null}

      {batch.status === 'CONTROLE' ? (
        <section aria-labelledby="import-commit-title" className="space-y-4 rounded-lg border p-4">
          <div>
            <h2 id="import-commit-title" className="text-lg font-semibold">
              5. Confirmer l’import
            </h2>
          </div>
          <ImportGuaranteesReminder />
          {batch.errorCount > 0 ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {batch.errorCount} ligne{batch.errorCount > 1 ? 's' : ''} en erreur : la confirmation est impossible. Corrigez le fichier puis téléversez-le à nouveau, ou corrigez les données de référence (société, catégorie, site, véhicule…) et relancez le contrôle.
            </p>
          ) : null}
          {dirty ? (
            <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              L’association des colonnes a été modifiée depuis le contrôle : relancez le contrôle avant de confirmer.
            </p>
          ) : null}
          {commitProblem ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {commitProblem}
            </p>
          ) : null}
          <Button type="button" disabled={!canCommit || commit.isPending} onClick={() => commit.mutate()}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {commit.isPending
              ? 'Import en cours… (toutes les lignes sont revérifiées)'
              : canCommit && batch.counts
                ? `Confirmer l’import de ${batch.counts.valid} ligne${batch.counts.valid > 1 ? 's' : ''}`
                : 'Confirmer l’import'}
          </Button>
        </section>
      ) : null}

      {confirmed ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => set({ lot: '' })}>
            <Plus className="size-4" aria-hidden="true" /> Nouvel import
          </Button>
        </div>
      ) : null}

      {abandonOpen ? <AbandonImportDialog batch={batch} onOpenChange={setAbandonOpen} /> : null}
    </div>
  );
}

function CountsSummary({ counts, confirmed }: { counts: ImportCounts; confirmed: boolean }) {
  const tiles: Array<{ label: string; value: number; tone?: 'danger' | 'success' | 'warning' }> = [
    { label: 'Lignes du fichier', value: counts.total },
    { label: confirmed ? 'Importées' : 'Valides', value: counts.valid, tone: 'success' },
    { label: 'En erreur', value: counts.errors, tone: counts.errors > 0 ? 'danger' : undefined },
    { label: 'Ignorées (déjà présentes)', value: counts.ignored },
    { label: 'Avec avertissement', value: counts.withNotes, tone: counts.withNotes > 0 ? 'warning' : undefined },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={
            t.tone === 'danger'
              ? 'rounded-md border border-destructive/30 bg-destructive/5 p-3'
              : t.tone === 'warning'
                ? 'rounded-md border border-warning/40 bg-warning/10 p-3'
                : t.tone === 'success'
                  ? 'rounded-md border border-success/30 bg-success/5 p-3'
                  : 'rounded-md border p-3'
          }
        >
          <dt className="text-xs text-muted-foreground">{t.label}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}
