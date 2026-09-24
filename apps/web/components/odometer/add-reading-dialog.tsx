'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { READING_CONTEXT_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { AttachmentField, type UploadedFile } from '@/components/odometer/attachment-field';
import { FormErrorAlert } from '@/components/odometer/reading-display';
import {
  describedBy,
  type FieldErrors,
  isKmFormat,
  normalizeKmInput,
  readingKmLabel,
} from '@/components/odometer/reading-helpers';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  type IngestResult,
  MANUAL_READING_CONTEXTS,
  type ManualReadingContext,
  type OdometerCurrentView,
  type SegmentView,
} from '@/lib/odometer-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';

const COVERING_SEGMENT = '__segment_couvrant__';

/** Relevé libre (POST /vehicles/:id/readings) : accepté directement si cohérent, sinon mis en attente avec motif. */
export function AddReadingDialog({
  open,
  onOpenChange,
  vehicleId,
  companyId,
  current,
  segments,
  vehicleLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: string;
  companyId: string;
  current: OdometerCurrentView | undefined;
  segments: SegmentView[];
  /** Code du véhicule rappelé dans le titre quand le dialogue est ouvert hors du dossier véhicule. */
  vehicleLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {open ? (
          <AddReadingForm
            vehicleId={vehicleId}
            companyId={companyId}
            current={current}
            segments={segments}
            vehicleLabel={vehicleLabel}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AddReadingForm({
  vehicleId,
  companyId,
  current,
  segments,
  vehicleLabel,
  onClose,
}: {
  vehicleId: string;
  companyId: string;
  current: OdometerCurrentView | undefined;
  segments: SegmentView[];
  vehicleLabel?: string;
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  // Une clé par ouverture du formulaire, réutilisée pour tout nouvel essai du même envoi (D-267).
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [physicalKm, setPhysicalKm] = useState('');
  const [observedAt, setObservedAt] = useState(() => nowLocalInput(session.timezone));
  const [context, setContext] = useState<ManualReadingContext>('RELEVE_LIBRE');
  const [segmentId, setSegmentId] = useState(COVERING_SEGMENT);
  const [photo, setPhoto] = useState<UploadedFile | null>(null);
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: (body: {
      physicalKm: string;
      observedAt: string;
      context: ManualReadingContext;
      odometerSegmentId?: string;
      attachmentId?: string;
      note?: string;
    }) =>
      api<IngestResult>(`/vehicles/${vehicleId}/readings`, {
        method: 'POST',
        idempotencyKey,
        body,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      if (result.outcome === 'ACCEPTE')
        toast.success(`Relevé accepté : ${readingKmLabel(result.reading)}.`);
      else if (result.outcome === 'EN_ATTENTE')
        toast.warning(
          `Relevé enregistré en attente de validation${result.anomaly ? ` : ${result.anomaly.reason}` : '.'}`,
        );
      else toast.info('Relevé identique déjà enregistré : aucun doublon créé.');
      onClose();
    },
    onError: (error) => {
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Relevé non enregistré.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const local: FieldErrors = {};
    const km = normalizeKmInput(physicalKm);
    const iso = localInputToIso(observedAt, session.timezone);
    if (!km) local.physicalKm = ['Valeur du compteur obligatoire.'];
    else if (!isKmFormat(km))
      local.physicalKm = ['Nombre attendu (chiffres, virgule décimale facultative).'];
    if (!iso) local.observedAt = ['Date et heure d’observation obligatoires.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0 || !iso) return;
    save.mutate({
      physicalKm: km,
      observedAt: iso,
      context,
      odometerSegmentId: segmentId === COVERING_SEGMENT ? undefined : segmentId,
      attachmentId: photo?.id,
      note: note.trim() || undefined,
    });
  }

  const reading = current?.reading ?? null;

  return (
    <form className="space-y-4" noValidate onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>
          {vehicleLabel ? `Ajouter un relevé : ${vehicleLabel}` : 'Ajouter un relevé'}
        </DialogTitle>
        <DialogDescription>
          Saisissez la valeur affichée au tableau de bord. Un relevé cohérent est accepté
          directement ; une hausse jugée implausible est mise en attente de validation ; une
          diminution ou une rupture de chronologie est refusée.
        </DialogDescription>
      </DialogHeader>
      {current ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm">
          {reading ? (
            <>
              Compteur courant : <span className="font-medium">{readingKmLabel(reading)}</span>,
              observé le {formatDateTime(reading.observedAt, session.timezone)}.
            </>
          ) : (
            'Kilométrage inconnu : aucun relevé accepté. Le premier relevé accepté initialise le compteur (cumul égal à la valeur affichée) ; pour déclarer une autre base, utilisez « Initialiser le compteur » dans l’onglet Kilométrage du véhicule.'
          )}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="reading-km">Valeur affichée (km) *</Label>
          <Input
            id="reading-km"
            inputMode="decimal"
            autoComplete="off"
            value={physicalKm}
            onChange={(e) => setPhysicalKm(e.target.value)}
            aria-invalid={Boolean(fieldErrors.physicalKm?.length) || undefined}
            aria-describedby={describedBy(fieldErrors, 'physicalKm')}
          />
          <FieldError errors={fieldErrors} name="physicalKm" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reading-observed">Date et heure d’observation *</Label>
          <Input
            id="reading-observed"
            type="datetime-local"
            value={observedAt}
            onChange={(e) => setObservedAt(e.target.value)}
            aria-invalid={Boolean(fieldErrors.observedAt?.length) || undefined}
            aria-describedby={describedBy(fieldErrors, 'observedAt', 'reading-observed-hint')}
          />
          <p id="reading-observed-hint" className="text-xs text-muted-foreground">
            Heure de {session.timezone}.
          </p>
          <FieldError errors={fieldErrors} name="observedAt" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="reading-context">Contexte</Label>
          <Select value={context} onValueChange={(v) => setContext(v as ManualReadingContext)}>
            <SelectTrigger
              id="reading-context"
              className="w-full"
              aria-describedby={describedBy(fieldErrors, 'context')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MANUAL_READING_CONTEXTS.map((c) => (
                <SelectItem key={c} value={c}>
                  {READING_CONTEXT_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError errors={fieldErrors} name="context" />
        </div>
        {segments.length > 1 ? (
          <div className="space-y-2">
            <Label htmlFor="reading-segment">Compteur concerné</Label>
            <Select value={segmentId} onValueChange={setSegmentId}>
              <SelectTrigger
                id="reading-segment"
                className="w-full"
                aria-describedby={describedBy(
                  fieldErrors,
                  'odometerSegmentId',
                  'reading-segment-hint',
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={COVERING_SEGMENT}>
                  Compteur en service à la date d’observation
                </SelectItem>
                {segments.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    Compteur n° {s.sequence} (depuis le {formatDate(s.startedAt, session.timezone)}
                    {s.endedAt ? ` jusqu’au ${formatDate(s.endedAt, session.timezone)}` : ''})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="reading-segment-hint" className="text-xs text-muted-foreground">
              À préciser seulement pour un relevé rétroactif sur un compteur remplacé.
            </p>
            <FieldError errors={fieldErrors} name="odometerSegmentId" />
          </div>
        ) : null}
      </div>
      <AttachmentField
        id="reading-photo"
        label="Photo du compteur (facultative)"
        hint="JPEG ou PNG, 10 Mo au plus."
        companyId={companyId}
        accept="image/jpeg,image/png"
        capture
        value={photo}
        onChange={setPhoto}
        errors={fieldErrors}
        errorName="attachmentId"
      />
      <div className="space-y-2">
        <Label htmlFor="reading-note">Note</Label>
        <Textarea
          id="reading-note"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby={describedBy(fieldErrors, 'note')}
        />
        <FieldError errors={fieldErrors} name="note" />
      </div>
      <FormErrorAlert error={submitError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer le relevé'}
        </Button>
      </DialogFooter>
    </form>
  );
}
