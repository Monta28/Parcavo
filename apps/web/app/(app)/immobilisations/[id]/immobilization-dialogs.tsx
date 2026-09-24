'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { PlaceFields, type PlaceValue, placeFrom, placeLocalErrors, placeUpdateBody } from '@/components/incidents/place-fields';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { ImmobilizationCauseView, ImmobilizationView } from '@/lib/immobilizations-types';
import { isoToLocalInput, localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { EMPTY_SOURCE, SourceFields, type SourceValue, sourceBody, sourceLocalErrors } from '../source-fields';

/** Mise à jour du cache après une action ; rechargement de la fiche sur conflit (409). */
function useImmobilizationCache(immobilizationId: string) {
  const queryClient = useQueryClient();
  return {
    saved(updated: ImmobilizationView, message: string) {
      toast.success(message);
      queryClient.setQueryData(['immobilization', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['immobilizations'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', updated.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['incident'] });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['intervention'] });
    },
    /** Vrai si la fenêtre doit être fermée (version obsolète : la fiche est rechargée). */
    failed(error: unknown, fallback: string): boolean {
      toast.error(isApiError(error) ? error.message : fallback);
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['immobilization', immobilizationId] });
        if (error.code === 'VERSION_OBSOLETE') {
          toast.info('La fiche a été rechargée avec la version courante : vérifiez puis relancez l’action.');
          return true;
        }
      }
      return false;
    },
  };
}

// Terminer une cause / l'immobilisation --------------------------------------------------------

/**
 * Fin d'une cause (POST :id/causes/:causeId/end) ou de toute l'immobilisation (POST :id/end) : motif
 * obligatoire, fin réelle entre le début et maintenant (maintenant par défaut).
 */
export function EndDialog({ immobilization, cause, onOpenChange }: { immobilization: ImmobilizationView; cause: ImmobilizationCauseView | null; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const cache = useImmobilizationCache(immobilization.id);
  const [endedAt, setEndedAt] = useState(() => nowLocalInput(session.timezone));
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const openCauses = immobilization.causes.filter((c) => !c.endedAt);
  const end = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ImmobilizationView>(cause ? `/immobilizations/${immobilization.id}/causes/${cause.id}/end` : `/immobilizations/${immobilization.id}/end`, { method: 'POST', body }),
    onSuccess: (updated) => {
      cache.saved(updated, updated.status === 'TERMINEE' ? `Immobilisation terminée : ${updated.vehicleCode} est remis en disponibilité.` : 'Cause terminée. L’immobilisation reste active tant qu’une cause est ouverte.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Enregistrement impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(end.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !end.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cause ? 'Terminer la cause' : 'Fin d’immobilisation'}</DialogTitle>
          <DialogDescription>
            {cause
              ? `Causes ouvertes sur cette immobilisation : ${openCauses.length}, dont celle-ci. La disponibilité est rétablie seulement après la fin de toutes les causes.`
              : `Toutes les causes ouvertes (${openCauses.length}) sont terminées avec la même date et le même motif. La disponibilité est rétablie seulement après la fin de toutes les causes.`}
          </DialogDescription>
        </DialogHeader>
        {cause ? (
          <p className="rounded-md border p-3 text-sm">
            <span className="font-medium">{cause.reason}</span>
            <span className="block text-xs text-muted-foreground">Depuis le {formatDateTime(cause.startedAt, session.timezone)}</span>
          </p>
        ) : null}
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            const endIso = localInputToIso(endedAt, session.timezone);
            if (!endIso) next.endedAt = ['Indiquez la date et l’heure de fin.'];
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            end.mutate({ endedAt: endIso ?? undefined, reason: reason.trim(), expectedVersion: immobilization.version });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="end-at">Fin réelle *</Label>
            <Input id="end-at" type="datetime-local" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} aria-invalid={invalid(errors, 'endedAt')} aria-describedby={describedBy(errors, 'endedAt', 'end-at-hint')} />
            <p id="end-at-hint" className="text-xs text-muted-foreground">
              Entre le début de la cause et maintenant (fuseau {session.timezone}).
            </p>
            <FieldError errors={errors} name="endedAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-reason">Motif *</Label>
            <Textarea id="end-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. réparation terminée, véhicule récupéré" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          {end.error ? <ApiErrorAlert error={end.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={end.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={end.isPending}>
              {end.isPending ? 'Enregistrement…' : cause ? 'Terminer la cause' : 'Terminer l’immobilisation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Ajouter une cause ----------------------------------------------------------------------------

/** « Ajouter une cause » (POST :id/causes) à une immobilisation active : motif, source facultative, début jamais futur. */
export function AddCauseDialog({ immobilization, onOpenChange }: { immobilization: ImmobilizationView; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const cache = useImmobilizationCache(immobilization.id);
  const [reason, setReason] = useState('');
  const [startedAt, setStartedAt] = useState(() => nowLocalInput(session.timezone));
  const [source, setSource] = useState<SourceValue>(EMPTY_SOURCE);
  const [local, setLocal] = useState<FieldErrors>({});
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ImmobilizationView>(`/immobilizations/${immobilization.id}/causes`, { method: 'POST', body }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Cause ajoutée à l’immobilisation.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Ajout de la cause impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(add.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !add.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajouter une cause</DialogTitle>
          <DialogDescription>Plusieurs causes simultanées sont regroupées dans cette immobilisation ; une même source ne peut avoir qu’une cause ouverte.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = { ...sourceLocalErrors(source) };
            const startIso = localInputToIso(startedAt, session.timezone);
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            if (!startIso) next.startedAt = ['Indiquez la date et l’heure de début.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            add.mutate({ reason: reason.trim(), startedAt: startIso ?? undefined, ...sourceBody(source), expectedVersion: immobilization.version });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="cause-reason">Motif *</Label>
            <Textarea id="cause-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <SourceFields idPrefix="cause" vehicleId={immobilization.vehicleId} value={source} onChange={setSource} errors={errors} />
          <div className="space-y-2">
            <Label htmlFor="cause-start">Début *</Label>
            <Input id="cause-start" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} aria-invalid={invalid(errors, 'startedAt')} aria-describedby={describedBy(errors, 'startedAt', 'cause-start-hint')} />
            <p id="cause-start-hint" className="text-xs text-muted-foreground">
              Jamais dans le futur (fuseau {session.timezone}). Un début antérieur à l’immobilisation l’étend, sans chevauchement avec une autre période.
            </p>
            <FieldError errors={errors} name="startedAt" />
          </div>
          {add.error ? <ApiErrorAlert error={add.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Enregistrement…' : 'Ajouter la cause'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Modifier fin prévue / lieu -------------------------------------------------------------------

/** Modification de la fin prévue et du lieu (PATCH /immobilizations/:id, expectedVersion). */
export function EditImmobilizationDialog({ immobilization, onOpenChange }: { immobilization: ImmobilizationView; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const cache = useImmobilizationCache(immobilization.id);
  const [expectedEndAt, setExpectedEndAt] = useState(() => isoToLocalInput(immobilization.expectedEndAt, session.timezone));
  const [initialEnd] = useState(expectedEndAt);
  const [initialPlace] = useState<PlaceValue>(() => placeFrom(immobilization));
  const [place, setPlace] = useState<PlaceValue>(initialPlace);
  const [local, setLocal] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ImmobilizationView>(`/immobilizations/${immobilization.id}`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Immobilisation mise à jour.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Enregistrement impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(save.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Modifier l’immobilisation</DialogTitle>
          <DialogDescription>Fin prévue et lieu (garage, site ou lieu libre). Une version obsolète est refusée : la fiche est alors rechargée.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = { ...placeLocalErrors(place) };
            const endIso = expectedEndAt ? localInputToIso(expectedEndAt, session.timezone) : null;
            if (expectedEndAt && !endIso) next.expectedEndAt = ['Date et heure invalides.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            const body: Record<string, unknown> = {};
            if (expectedEndAt !== initialEnd) body.expectedEndAt = endIso;
            // Le lieu n'est envoyé que s'il change : l'API revalide alors le site ou le garage choisi.
            const placeChanged = JSON.stringify(placeUpdateBody(place)) !== JSON.stringify(placeUpdateBody(initialPlace));
            if (placeChanged) Object.assign(body, placeUpdateBody(place));
            if (Object.keys(body).length === 0) {
              toast.info('Aucune modification à enregistrer.');
              onOpenChange(false);
              return;
            }
            save.mutate({ ...body, expectedVersion: immobilization.version });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-expected-end">Fin prévue</Label>
            <Input id="edit-expected-end" type="datetime-local" value={expectedEndAt} onChange={(e) => setExpectedEndAt(e.target.value)} aria-invalid={invalid(errors, 'expectedEndAt')} aria-describedby={describedBy(errors, 'expectedEndAt', 'edit-expected-end-hint')} />
            <p id="edit-expected-end-hint" className="text-xs text-muted-foreground">
              Laissez vide pour retirer la fin prévue (fuseau {session.timezone}).
            </p>
            <FieldError errors={errors} name="expectedEndAt" />
          </div>
          <PlaceFields idPrefix="edit-immobilization" companyId={immobilization.companyId} value={place} onChange={setPlace} errors={errors} current={immobilization} />
          {save.error ? <ApiErrorAlert error={save.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
