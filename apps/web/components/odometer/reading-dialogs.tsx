'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { READING_CONTEXT_LABELS, READING_SOURCE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ReadingView } from '@/lib/odometer-types';
import { isoToLocalInput, localInputToIso } from '@/lib/zoned-time';
import { FormErrorAlert } from './reading-display';
import {
  describedBy,
  type FieldErrors,
  isKmFormat,
  normalizeKmInput,
  readingKmLabel,
} from './reading-helpers';

export type ReadingDecision = { reading: ReadingView; mode: 'approve' | 'reject' } | null;

/** Données touchées par une décision ou une correction de relevé (compteur, distances d'utilisation, files). */
function useInvalidateReadings() {
  const queryClient = useQueryClient();
  return (vehicleId: string) => {
    void queryClient.invalidateQueries({ queryKey: ['readings'] });
    void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
    void queryClient.invalidateQueries({ queryKey: ['usages'] });
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
  };
}

/** Rappel du relevé concerné dans les dialogues. */
function ReadingSummary({ reading }: { reading: ReadingView }) {
  const session = useSession();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <dt className="text-muted-foreground">Véhicule</dt>
      <dd>{reading.vehicleCode}</dd>
      <dt className="text-muted-foreground">Valeur</dt>
      <dd className="font-medium">{readingKmLabel(reading)}</dd>
      {!reading.isEstimate && reading.cumulativeKm ? (
        <>
          <dt className="text-muted-foreground">Cumul véhicule</dt>
          <dd>{formatKm(reading.cumulativeKm)}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Observé le</dt>
      <dd>{formatDateTime(reading.observedAt, session.timezone)}</dd>
      <dt className="text-muted-foreground">Source</dt>
      <dd>
        {READING_SOURCE_LABELS[reading.source] ?? reading.source} ·{' '}
        {READING_CONTEXT_LABELS[reading.context as keyof typeof READING_CONTEXT_LABELS] ??
          reading.context}
      </dd>
      <dt className="text-muted-foreground">Auteur</dt>
      <dd>{reading.authorName ?? '—'}</dd>
      {reading.statusReason ? (
        <>
          <dt className="text-muted-foreground">Motif d’attente</dt>
          <dd>{reading.statusReason}</dd>
        </>
      ) : null}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Validation et rejet (POST /readings/:id/approve | reject, permission readings.approve)
// ---------------------------------------------------------------------------

export function ReadingDecisionDialog({
  decision,
  onClose,
}: {
  decision: ReadingDecision;
  onClose: () => void;
}) {
  return (
    <Dialog open={decision !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {decision ? (
          <DecisionForm
            key={`${decision.reading.id}-${decision.mode}`}
            reading={decision.reading}
            mode={decision.mode}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DecisionForm({
  reading,
  mode,
  onClose,
}: {
  reading: ReadingView;
  mode: 'approve' | 'reject';
  onClose: () => void;
}) {
  const invalidate = useInvalidateReadings();
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const approve = mode === 'approve';

  const decide = useMutation({
    mutationFn: () =>
      api<ReadingView>(`/readings/${reading.id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: { expectedVersion: reading.version, reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      toast.success(
        approve
          ? `Relevé ${reading.vehicleCode} validé : il devient un relevé accepté.`
          : `Relevé ${reading.vehicleCode} rejeté.`,
      );
      invalidate(reading.vehicleId);
      onClose();
    },
    onError: (error) => {
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        if (error.status === 409) invalidate(reading.vehicleId);
        // Relevé modifié ou déjà traité entre-temps : on ferme pour repartir de l'état rechargé.
        if (error.code === 'VERSION_OBSOLETE' || error.code === 'ETAT_INVALIDE') onClose();
      } else toast.error(approve ? 'Validation impossible.' : 'Rejet impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!approve && reason.trim().length < 3) {
      setFieldErrors({ reason: ['Motif du rejet obligatoire (3 caractères au moins).'] });
      return;
    }
    setFieldErrors({});
    decide.mutate();
  }

  return (
    <form className="space-y-4" noValidate onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>{approve ? 'Valider le relevé' : 'Rejeter le relevé'}</DialogTitle>
        <DialogDescription>
          {approve
            ? 'Le relevé est réévalué au moment de la validation ; une rupture de chronologie reste refusée par le serveur.'
            : 'Le relevé rejeté est conservé dans l’historique et ne participe à aucun calcul.'}
        </DialogDescription>
      </DialogHeader>
      <ReadingSummary reading={reading} />
      <div className="space-y-2">
        <Label htmlFor="decision-reason">
          {approve ? 'Commentaire de validation (facultatif)' : 'Motif du rejet *'}
        </Label>
        <Textarea
          id="decision-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={Boolean(fieldErrors.reason?.length) || undefined}
          aria-describedby={describedBy(fieldErrors, 'reason')}
        />
        <FieldError errors={fieldErrors} name="reason" />
      </div>
      <FormErrorAlert error={submitError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button
          type="submit"
          variant={approve ? 'default' : 'destructive'}
          disabled={decide.isPending}
        >
          {decide.isPending
            ? 'Enregistrement…'
            : approve
              ? 'Valider le relevé'
              : 'Rejeter le relevé'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Correction motivée (POST /readings/:id/correct, permission readings.correct, Idempotency-Key)
// ---------------------------------------------------------------------------

export function CorrectReadingDialog({
  reading,
  onClose,
}: {
  reading: ReadingView | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={reading !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {reading ? <CorrectForm key={reading.id} reading={reading} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CorrectForm({ reading, onClose }: { reading: ReadingView; onClose: () => void }) {
  const session = useSession();
  const invalidate = useInvalidateReadings();
  // Une clé par ouverture du formulaire, réutilisée pour tout nouvel essai du même envoi.
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const originalLocal = isoToLocalInput(reading.observedAt, session.timezone);
  const [reason, setReason] = useState('');
  const [physicalKm, setPhysicalKm] = useState('');
  const [observedAt, setObservedAt] = useState(originalLocal);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  const correct = useMutation({
    mutationFn: (body: {
      reason: string;
      replacementReading: { physicalKm: string; observedAt?: string };
      expectedVersion: number;
    }) =>
      api<ReadingView>(`/readings/${reading.id}/correct`, { method: 'POST', idempotencyKey, body }),
    onSuccess: (replacement) => {
      toast.success(
        `Relevé corrigé : ${readingKmLabel(replacement)}. L’original est conservé avec le statut « Remplacé ».`,
      );
      invalidate(reading.vehicleId);
      onClose();
    },
    onError: (error) => {
      setSubmitError(error);
      if (isApiError(error)) {
        // Validation du DTO et contrôles métier de la valeur : mêmes clés (replacementReading.physicalKm/observedAt).
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        if (error.status === 409) invalidate(reading.vehicleId);
        // Relevé modifié ou déjà traité entre-temps : on ferme pour repartir de l'état rechargé.
        if (error.code === 'VERSION_OBSOLETE' || error.code === 'ETAT_INVALIDE') onClose();
      } else toast.error('Correction impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const local: FieldErrors = {};
    const km = normalizeKmInput(physicalKm);
    if (reason.trim().length < 3) local.reason = ['Motif obligatoire (3 caractères au moins).'];
    if (!km) local['replacementReading.physicalKm'] = ['Valeur de remplacement obligatoire.'];
    else if (!isKmFormat(km))
      local['replacementReading.physicalKm'] = [
        'Nombre attendu (chiffres, virgule décimale facultative).',
      ];
    // La date n'est transmise que si elle a été modifiée : sinon l'API conserve celle de l'original.
    const changedDate = observedAt !== originalLocal;
    const iso = changedDate ? localInputToIso(observedAt, session.timezone) : null;
    if (changedDate && !iso) local['replacementReading.observedAt'] = ['Date et heure invalides.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    correct.mutate({
      reason: reason.trim(),
      replacementReading: { physicalKm: km, ...(iso ? { observedAt: iso } : {}) },
      expectedVersion: reading.version,
    });
  }

  return (
    <form className="space-y-4" noValidate onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>Corriger le relevé</DialogTitle>
        <DialogDescription>
          Un relevé accepté n’est jamais écrasé : l’original est conservé avec le statut « Remplacé
          », un relevé de remplacement est créé et les données dépendantes sont recalculées. Une
          correction qui rompt la chronologie est refusée.
        </DialogDescription>
      </DialogHeader>
      <ReadingSummary reading={reading} />
      <div className="space-y-2">
        <Label htmlFor="correct-km">Valeur physique corrigée (km) *</Label>
        <Input
          id="correct-km"
          inputMode="decimal"
          autoComplete="off"
          value={physicalKm}
          onChange={(e) => setPhysicalKm(e.target.value)}
          aria-invalid={Boolean(fieldErrors['replacementReading.physicalKm']?.length) || undefined}
          aria-describedby={describedBy(
            fieldErrors,
            'replacementReading.physicalKm',
            'correct-km-hint',
          )}
        />
        <p id="correct-km-hint" className="text-xs text-muted-foreground">
          Valeur affichée au tableau de bord du compteur n° {reading.segmentSequence}.
        </p>
        <FieldError errors={fieldErrors} name="replacementReading.physicalKm" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="correct-observed">Date et heure d’observation</Label>
        <Input
          id="correct-observed"
          type="datetime-local"
          value={observedAt}
          onChange={(e) => setObservedAt(e.target.value)}
          aria-invalid={Boolean(fieldErrors['replacementReading.observedAt']?.length) || undefined}
          aria-describedby={describedBy(
            fieldErrors,
            'replacementReading.observedAt',
            'correct-observed-hint',
          )}
        />
        <p id="correct-observed-hint" className="text-xs text-muted-foreground">
          Heure de {session.timezone}. Laissez inchangée pour conserver la date de l’original.
        </p>
        <FieldError errors={fieldErrors} name="replacementReading.observedAt" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="correct-reason">Motif de la correction *</Label>
        <Textarea
          id="correct-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={Boolean(fieldErrors.reason?.length) || undefined}
          aria-describedby={describedBy(fieldErrors, 'reason')}
        />
        <FieldError errors={fieldErrors} name="reason" />
      </div>
      <FormErrorAlert error={submitError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={correct.isPending}>
          {correct.isPending ? 'Enregistrement…' : 'Enregistrer la correction'}
        </Button>
      </DialogFooter>
    </form>
  );
}
