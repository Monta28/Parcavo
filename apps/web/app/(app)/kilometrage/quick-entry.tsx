'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAppScope } from '@/components/layout/session-context';
import type { UploadedFile } from '@/components/odometer/attachment-field';
import { LinePhoto } from '@/components/odometer/line-photo';
import { FormErrorAlert, FreshnessBadge } from '@/components/odometer/reading-display';
import {
  BATCH_OUTCOME_LABELS,
  type FieldErrors,
  isKmFormat,
  normalizeKmInput,
  readingKmLabel,
  toneForBatchOutcome,
  useScopeChecks,
} from '@/components/odometer/reading-helpers';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { BatchResultItem, OdometerCurrentView } from '@/lib/odometer-types';
import { useListParams } from '@/lib/use-list-params';
import type { VehicleView } from '@/lib/vehicles-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';

/** Nombre maximal de lignes par envoi (BatchReadingsDto : 100). */
const MAX_LINES = 100;

interface DraftLine {
  vehicleCode: string;
  km: string;
  /** Date/heure propre à la ligne ; absente : date par défaut de la saisie. */
  observedAt?: string;
  note: string;
  /** Photo du compteur téléversée, rattachée au relevé par l'API (attachmentId). */
  photo?: UploadedFile | null;
}

interface BatchLine {
  vehicleId: string;
  physicalKm: string;
  observedAt: string;
  note?: string;
  attachmentId?: string;
}

type LineResult = BatchResultItem & { vehicleCode: string };

/**
 * État de la saisie rapide, conservé par l'écran parent pour survivre au changement d'onglet et de
 * page de la liste (aucune donnée n'est enregistrée tant que l'API n'a pas répondu). La clé
 * d'idempotence du lot (D-265, D-267) est réutilisée pour chaque nouvel essai du même envoi (coupure
 * réseau : les lignes déjà enregistrées sont rejouées sans doublon) et renouvelée après une réponse.
 */
export function useQuickEntryState(timezone: string) {
  const [defaultObservedAt, setDefaultObservedAt] = useState(() => nowLocalInput(timezone));
  const [drafts, setDrafts] = useState<Record<string, DraftLine>>({});
  const [results, setResults] = useState<LineResult[]>([]);
  const [batchKey, setBatchKey] = useState(() => newIdempotencyKey());
  return {
    defaultObservedAt,
    setDefaultObservedAt,
    drafts,
    setDrafts,
    results,
    setResults,
    batchKey,
    renewBatchKey: () => setBatchKey(newIdempotencyKey()),
  };
}

export type QuickEntryState = ReturnType<typeof useQuickEntryState>;

/** Saisie rapide par parc (CDC 10.2, D-265) : chaque ligne est traitée indépendamment par POST /readings/batch. */
export function QuickEntry({ state }: { state: QuickEntryState }) {
  const { companyId, session } = useAppScope();
  const queryClient = useQueryClient();
  const { operational } = useScopeChecks();
  const { get, set: setParams, page } = useListParams();
  const set = (updates: Record<string, string | number>) =>
    setParams({ ...updates, onglet: 'saisie' });
  const q = get('q');
  const {
    defaultObservedAt,
    setDefaultObservedAt,
    drafts,
    setDrafts,
    results,
    setResults,
    batchKey,
    renewBatchKey,
  } = state;
  const [rowErrors, setRowErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  const query = toQuery({ companyId, q, page, pageSize: 25, sort: 'code' });
  const vehicles = useQuery({
    queryKey: ['vehicles', query],
    queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`),
  });
  const items = vehicles.data?.items ?? [];
  const odometers = useQueries({
    queries: items.map((v) => ({
      queryKey: ['vehicle', v.id, 'odometer'],
      queryFn: () => api<OdometerCurrentView>(`/vehicles/${v.id}/odometer`),
    })),
  });

  const filled = Object.entries(drafts).filter(([, d]) => d.km.trim() !== '');
  const resultByVehicle = new Map(results.map((r) => [r.vehicleId, r]));

  function updateDraft(vehicle: VehicleView, patch: Partial<DraftLine>) {
    setDrafts((prev) => {
      const current = prev[vehicle.id] ?? {
        vehicleCode: vehicle.code,
        km: '',
        note: '',
      };
      return { ...prev, [vehicle.id]: { ...current, ...patch } };
    });
  }

  const send = useMutation({
    mutationFn: (lines: BatchLine[]) =>
      api<BatchResultItem[]>('/readings/batch', {
        method: 'POST',
        body: { items: lines },
        idempotencyKey: batchKey,
      }),
    onSuccess: (lineResults, lines) => {
      // Envoi traité : un nouvel envoi (lignes corrigées ou nouvelles) utilise une nouvelle clé.
      renewBatchKey();
      setSubmitError(null);
      setRowErrors({});
      const withCodes = lineResults.map((r) => ({
        ...r,
        vehicleCode: drafts[r.vehicleId]?.vehicleCode ?? r.vehicleId,
      }));
      setResults(withCodes);
      // Seules les lignes refusées restent saisies, pour correction et nouvel envoi.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const r of lineResults) if (r.outcome !== 'REFUSE') delete next[r.vehicleId];
        return next;
      });
      for (const line of lines)
        void queryClient.invalidateQueries({ queryKey: ['vehicle', line.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      const count = (o: BatchResultItem['outcome']) =>
        lineResults.filter((r) => r.outcome === o).length;
      const summary = `${count('ACCEPTE')} accepté(s), ${count('EN_ATTENTE')} en attente, ${count('IDEMPOTENT')} déjà enregistré(s), ${count('REFUSE')} refusé(s).`;
      if (count('REFUSE') > 0) toast.warning(`Saisie traitée ligne par ligne : ${summary}`);
      else toast.success(`Saisie enregistrée : ${summary}`);
    },
    onError: (error, lines) => {
      setSubmitError(error);
      if (isApiError(error)) {
        // Erreurs de format par ligne (items.N.champ) rattachées au véhicule concerné.
        const mapped: FieldErrors = {};
        for (const [key, messages] of Object.entries(error.fieldErrors)) {
          const match = /^items\.(\d+)\.(\w+)$/.exec(key);
          const line = match ? lines[Number(match[1])] : undefined;
          if (match && line) mapped[`${line.vehicleId}.${match[2]}`] = messages;
        }
        setRowErrors(mapped);
        toast.error(error.message);
      } else toast.error('Saisie non enregistrée.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const errors: FieldErrors = {};
    const lines: BatchLine[] = [];
    for (const [vehicleId, d] of filled) {
      const km = normalizeKmInput(d.km);
      const iso = localInputToIso(d.observedAt ?? defaultObservedAt, session.timezone);
      if (!isKmFormat(km))
        errors[`${vehicleId}.physicalKm`] = [
          `${d.vehicleCode} : nombre attendu (chiffres, virgule décimale facultative).`,
        ];
      if (!iso)
        errors[`${vehicleId}.observedAt`] = [
          `${d.vehicleCode} : date et heure d’observation invalides.`,
        ];
      if (iso && isKmFormat(km))
        lines.push({
          vehicleId,
          physicalKm: km,
          observedAt: iso,
          note: d.note.trim() || undefined,
          attachmentId: d.photo?.id,
        });
    }
    setRowErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('Certaines lignes sont à corriger avant l’envoi.');
      return;
    }
    if (lines.length === 0) return;
    if (lines.length > MAX_LINES) {
      setSubmitError(new Error(`${MAX_LINES} lignes au maximum par envoi.`));
      return;
    }
    send.mutate(lines);
  }

  const localErrors = Object.entries(rowErrors);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={onSubmit}
      aria-label="Saisie rapide des relevés"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="quick-default-date">Date et heure d’observation par défaut</Label>
          <Input
            id="quick-default-date"
            type="datetime-local"
            value={defaultObservedAt}
            onChange={(e) => setDefaultObservedAt(e.target.value)}
            aria-describedby="quick-default-date-hint"
          />
          <p id="quick-default-date-hint" className="text-xs text-muted-foreground">
            Heure de {session.timezone}. S’applique aux lignes dont la date n’a pas été modifiée.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="quick-search">Rechercher un véhicule</Label>
          <Input
            id="quick-search"
            placeholder="Code, immatriculation, marque…"
            defaultValue={q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Saisissez la valeur affichée au tableau de bord. Les lignes vides sont ignorées ; chaque
        ligne est contrôlée indépendamment (acceptée, mise en attente avec motif ou refusée avec
        motif). Une photo du compteur peut être jointe à chaque ligne ; elle est rattachée au relevé
        enregistré.
      </p>

      {vehicles.isPending ? (
        <LoadingState label="Chargement des véhicules…" />
      ) : vehicles.isError ? (
        <ErrorState error={vehicles.error} retry={() => void vehicles.refetch()} />
      ) : vehicles.data.total === 0 ? (
        <EmptyState
          title="Aucun véhicule"
          description="Aucun véhicule actif ou hors service ne correspond à la recherche dans votre périmètre."
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <caption className="sr-only">Saisie rapide : un relevé par véhicule</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Véhicule</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Compteur courant</TableHead>
                <TableHead className="min-w-36">Nouveau relevé (km)</TableHead>
                <TableHead className="min-w-52">Observé le</TableHead>
                <TableHead className="min-w-40">Note</TableHead>
                <TableHead className="min-w-48">Résultat et photo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((v, index) => {
                const odometer = odometers[index];
                const draft = drafts[v.id];
                const result = resultByVehicle.get(v.id);
                const kmError = rowErrors[`${v.id}.physicalKm`];
                const dateError = rowErrors[`${v.id}.observedAt`];
                const noteError = rowErrors[`${v.id}.note`];
                const allowed = operational(v.companyId);
                const refused = result?.outcome === 'REFUSE';
                const kmDescribedBy =
                  [
                    kmError?.length ? `km-${v.id}-error` : undefined,
                    refused && result.message ? `result-${v.id}` : undefined,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined;
                if (!allowed) {
                  return (
                    <TableRow key={v.id}>
                      <TableCell>
                        <Link
                          href={`/vehicules/${v.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {v.code}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {v.registration} · {v.make} {v.model}
                        </span>
                      </TableCell>
                      {companyId === null ? <TableCell>{v.companyCode}</TableCell> : null}
                      <TableCell colSpan={5} className="text-sm text-muted-foreground">
                        Consultation seule : votre rôle sur cette société ne permet pas de saisir de
                        relevé.
                      </TableCell>
                    </TableRow>
                  );
                }
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      <Link
                        href={`/vehicules/${v.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {v.code}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {v.registration} · {v.make} {v.model}
                      </span>
                    </TableCell>
                    {companyId === null ? <TableCell>{v.companyCode}</TableCell> : null}
                    <TableCell className="text-sm">
                      {!odometer || odometer.isPending ? (
                        <span className="text-muted-foreground">Chargement…</span>
                      ) : odometer.isError ? (
                        <span className="text-destructive">
                          Indisponible{' '}
                          <button
                            type="button"
                            className="underline underline-offset-4"
                            onClick={() => void odometer.refetch()}
                          >
                            Réessayer<span className="sr-only"> le compteur de {v.code}</span>
                          </button>
                        </span>
                      ) : (
                        <div className="space-y-1">
                          {odometer.data.reading ? (
                            <p className="whitespace-nowrap">
                              <span className="font-medium">
                                {readingKmLabel(odometer.data.reading)}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                le{' '}
                                {formatDateTime(odometer.data.reading.observedAt, session.timezone)}
                              </span>
                            </p>
                          ) : (
                            <p className="text-muted-foreground">Aucun relevé accepté</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            <FreshnessBadge
                              freshness={odometer.data.freshness}
                              ageDays={odometer.data.ageDays}
                              prefix="Fraîcheur"
                            />
                            {odometer.data.pendingCount > 0 ? (
                              <StatusBadge
                                label={`${odometer.data.pendingCount} en attente`}
                                tone="warning"
                              />
                            ) : null}
                            {!odometer.data.cumulativeKnown ? (
                              <StatusBadge label="Cumul incomplet" tone="warning" />
                            ) : null}
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={`km-${v.id}`} className="sr-only">
                        Nouveau relevé de {v.code} en kilomètres
                      </Label>
                      <Input
                        id={`km-${v.id}`}
                        inputMode="decimal"
                        autoComplete="off"
                        value={draft?.km ?? ''}
                        onChange={(e) => updateDraft(v, { km: e.target.value })}
                        aria-invalid={Boolean(kmError?.length) || refused || undefined}
                        aria-describedby={kmDescribedBy}
                      />
                      {kmError?.length ? (
                        <p id={`km-${v.id}-error`} className="mt-1 text-xs text-destructive">
                          {kmError.join(' ')}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={`date-${v.id}`} className="sr-only">
                        Date et heure d’observation pour {v.code}
                      </Label>
                      <Input
                        id={`date-${v.id}`}
                        type="datetime-local"
                        value={draft?.observedAt ?? defaultObservedAt}
                        onChange={(e) => updateDraft(v, { observedAt: e.target.value })}
                        aria-invalid={Boolean(dateError?.length) || undefined}
                        aria-describedby={dateError?.length ? `date-${v.id}-error` : undefined}
                      />
                      {dateError?.length ? (
                        <p id={`date-${v.id}-error`} className="mt-1 text-xs text-destructive">
                          {dateError.join(' ')}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={`note-${v.id}`} className="sr-only">
                        Note pour {v.code}
                      </Label>
                      <Input
                        id={`note-${v.id}`}
                        maxLength={1000}
                        value={draft?.note ?? ''}
                        onChange={(e) => updateDraft(v, { note: e.target.value })}
                        aria-invalid={Boolean(noteError?.length) || undefined}
                        aria-describedby={noteError?.length ? `note-${v.id}-error` : undefined}
                      />
                      {noteError?.length ? (
                        <p id={`note-${v.id}-error`} className="mt-1 text-xs text-destructive">
                          {noteError.join(' ')}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      <div className="space-y-2">
                        {result ? (
                          <div className="space-y-1">
                            <StatusBadge
                              label={BATCH_OUTCOME_LABELS[result.outcome]}
                              tone={toneForBatchOutcome(result.outcome)}
                            />
                            {result.message ? <p id={`result-${v.id}`}>{result.message}</p> : null}
                          </div>
                        ) : null}
                        <LinePhoto
                          id={`photo-${v.id}`}
                          vehicleCode={v.code}
                          companyId={v.companyId}
                          value={draft?.photo ?? null}
                          onChange={(photo) => updateDraft(v, { photo })}
                          disabled={send.isPending}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls
            page={vehicles.data.page}
            pageSize={vehicles.data.pageSize}
            total={vehicles.data.total}
            onPageChange={(p) => set({ page: p })}
          />
        </div>
      )}

      {localErrors.length > 0 && !submitError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <p className="font-medium">Lignes à corriger avant l’envoi :</p>
          <ul className="list-disc pl-5">
            {localErrors.map(([key, messages]) => (
              <li key={key}>{messages.join(' ')}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <FormErrorAlert error={submitError} />

      <div className="sticky bottom-0 flex flex-col gap-2 border-t bg-background py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm" aria-live="polite">
          {filled.length === 0
            ? 'Aucune valeur saisie.'
            : `${filled.length} relevé(s) à envoyer${filled.length > MAX_LINES ? ` (maximum ${MAX_LINES} par envoi)` : ''}.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={send.isPending || (filled.length === 0 && results.length === 0)}
            onClick={() => {
              setDrafts({});
              setResults([]);
              setRowErrors({});
              setSubmitError(null);
              // Saisie abandonnée : un envoi ultérieur n'est pas un nouvel essai de l'envoi précédent.
              renewBatchKey();
            }}
          >
            Effacer la saisie
          </Button>
          <Button type="submit" disabled={send.isPending || filled.length === 0}>
            {send.isPending ? 'Envoi en cours…' : 'Enregistrer les relevés'}
          </Button>
        </div>
      </div>

      {results.length > 0 ? (
        <section aria-labelledby="quick-results-title" className="rounded-md border p-3">
          <h2 id="quick-results-title" className="mb-2 text-base font-semibold">
            Résultat du dernier envoi
          </h2>
          <ul className="space-y-2 text-sm" aria-live="polite">
            {results.map((r) => (
              <li key={r.vehicleId} className="flex flex-wrap items-start gap-2">
                <span className="font-medium">{r.vehicleCode}</span>
                <StatusBadge
                  label={BATCH_OUTCOME_LABELS[r.outcome]}
                  tone={toneForBatchOutcome(r.outcome)}
                />
                {r.message ? <span>{r.message}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </form>
  );
}
