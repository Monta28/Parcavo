'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ReadingView } from '@/lib/odometer-types';
import type { UsageDetailView } from '@/lib/usages-types';
import { ApiErrorAlert, SinglePhotoField, type UploadedPhoto } from '../usage-form-parts';
import { isoToLocalInput, localInputToIso, normalizeKmInput } from '../usage-helpers';

type Mode = 'nouveau' | 'existant';
type FieldErrors = Record<string, string[]>;

/**
 * Régularisation de la distance non validée (CDC 4.4 ; POST /usages/:id/return-reading) : après un retour
 * constaté sans relevé ou avec un relevé rejeté, le chef rattache un relevé accepté — relevé saisi a posteriori
 * (par défaut à l'heure du retour) ou relevé accepté existant, observé depuis le retour. Motif obligatoire,
 * clé d'idempotence par ouverture, version attendue ; le serveur contrôle la chronologie et la période admise.
 */
export function RegularizeDialog({ usage, open, onOpenChange }: { usage: UsageDetailView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [mode, setMode] = useState<Mode>('nouveau');
  const [km, setKm] = useState('');
  const [observedAt, setObservedAt] = useState(() => isoToLocalInput(usage.returnedAt, session.timezone));
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const [readingId, setReadingId] = useState('');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);

  // Relevés acceptés observés depuis le retour (la borne « remise suivante » est contrôlée par le serveur).
  const candidates = useQuery({
    queryKey: ['readings', 'vehicle', usage.vehicleId, 'regularisation', usage.returnedAt],
    queryFn: () => api<Page<ReadingView>>(`/vehicles/${usage.vehicleId}/readings${toQuery({ status: 'ACCEPTE', observedFrom: usage.returnedAt ?? undefined, order: 'asc', pageSize: 20 })}`),
    enabled: open && mode === 'existant' && Boolean(usage.returnedAt),
  });

  const save = useMutation({
    mutationFn: () =>
      api<UsageDetailView>(`/usages/${usage.id}/return-reading`, {
        method: 'POST',
        idempotencyKey,
        body:
          mode === 'nouveau'
            ? { reading: { physicalKm: normalizeKmInput(km), observedAt: localInputToIso(observedAt, session.timezone), ...(photo ? { attachmentId: photo.id } : {}) }, reason: reason.trim(), expectedVersion: usage.version }
            : { readingId, reason: reason.trim(), expectedVersion: usage.version },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['usage', usage.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['usages'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', usage.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      toast.success(`Distance régularisée : ${formatKm(updated.distanceKm)}.`);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err);
      if (isApiError(err)) {
        setFieldErrors(err.fieldErrors);
        toast.error(err.message);
        // Version obsolète ou état changé : la fiche est rechargée avant un nouvel essai.
        if (err.status === 409) void queryClient.invalidateQueries({ queryKey: ['usage', usage.id] });
      } else toast.error('Régularisation impossible.');
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    if (mode === 'nouveau') {
      if (!km.trim()) local['reading.physicalKm'] = ['Saisissez la valeur lue sur le compteur.'];
      if (!localInputToIso(observedAt, session.timezone)) local['reading.observedAt'] = ['Indiquez l’instant de la lecture.'];
    } else if (!readingId) local.readingId = ['Choisissez le relevé à rattacher.'];
    if (reason.trim().length < 5) local.reason = ['Motif obligatoire (5 caractères minimum).'];
    setFieldErrors(local);
    setError(null);
    if (Object.keys(local).length > 0) return;
    save.mutate();
  }

  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Régulariser la distance</DialogTitle>
          <DialogDescription>
            Retour du {formatDateTime(usage.returnedAt, session.timezone)} {usage.returnWithoutReading ? 'constaté sans relevé' : 'avec un relevé rejeté'}. Rattachez un relevé accepté du compteur : la distance sera calculée par le serveur à partir des relevés de départ et de retour.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={submit}>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} aria-label="Relevé à rattacher" className="gap-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem id="regul-mode-nouveau" value="nouveau" />
              <Label htmlFor="regul-mode-nouveau">Saisir le relevé du retour (photo retrouvée, compteur relu)</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="regul-mode-existant" value="existant" />
              <Label htmlFor="regul-mode-existant">Rattacher un relevé accepté déjà enregistré</Label>
            </div>
          </RadioGroup>

          {mode === 'nouveau' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="regul-km">Compteur affiché (km) *</Label>
                <Input id="regul-km" inputMode="decimal" autoComplete="off" value={km} onChange={(e) => setKm(e.target.value)} aria-invalid={invalid('reading.physicalKm')} aria-describedby="regul-km-hint reading.physicalKm-error" />
                <p id="regul-km-hint" className="text-xs text-muted-foreground">
                  Valeur lue, jamais estimée ; un relevé qui demanderait une validation (anomalie) est refusé.
                </p>
                <FieldError errors={fieldErrors} name="reading.physicalKm" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="regul-observed">Lu le *</Label>
                <Input id="regul-observed" type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} aria-invalid={invalid('reading.observedAt')} aria-describedby="regul-observed-hint reading.observedAt-error" />
                <p id="regul-observed-hint" className="text-xs text-muted-foreground">
                  Entre le retour et la remise suivante du véhicule.
                </p>
                <FieldError errors={fieldErrors} name="reading.observedAt" />
              </div>
              <div className="sm:col-span-2">
                <SinglePhotoField id="regul-photo" label="Photo du compteur (facultative)" companyId={usage.companyId} photo={photo} onChange={setPhoto} errors={fieldErrors} errorName="reading.attachmentId" />
              </div>
            </div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Relevé accepté observé depuis le retour *</legend>
              {candidates.isPending ? (
                <p className="text-sm text-muted-foreground">Chargement des relevés…</p>
              ) : candidates.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  Relevés indisponibles : {isApiError(candidates.error) ? candidates.error.message : 'erreur inconnue'}
                </p>
              ) : candidates.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun relevé accepté n’a été observé depuis le retour : saisissez le relevé du retour.</p>
              ) : (
                <RadioGroup value={readingId} onValueChange={setReadingId} aria-label="Relevé accepté" aria-describedby="readingId-error" className="gap-2">
                  {candidates.data.items.map((r) => (
                    <div key={r.id} className="flex items-center gap-2">
                      <RadioGroupItem id={`regul-reading-${r.id}`} value={r.id} />
                      <Label htmlFor={`regul-reading-${r.id}`} className="font-normal">
                        {formatKm(r.physicalKm)} · lu le {formatDateTime(r.observedAt, session.timezone)}
                        {r.authorName ? ` · ${r.authorName}` : ''}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              )}
              <FieldError errors={fieldErrors} name="readingId" />
            </fieldset>
          )}

          <div className="space-y-2">
            <Label htmlFor="regul-reason">Motif * (5 caractères minimum)</Label>
            <Textarea id="regul-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid('reason')} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          {error && !Object.keys(fieldErrors).length ? <ApiErrorAlert error={error} idempotent /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Régulariser'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
