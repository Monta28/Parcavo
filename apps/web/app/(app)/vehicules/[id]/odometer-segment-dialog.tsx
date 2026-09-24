'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, formatKm } from '@/lib/format';
import type { OdometerCurrentView, SegmentView } from '@/lib/odometer-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';

export type SegmentMode = 'INITIAL' | 'REPLACEMENT';
type BaseChoice = 'origine' | 'base' | 'inconnu';

/**
 * Initialisation du compteur (D-127 : chef et opérateur) ou remplacement autorisé (D-166 : readings.correct)
 * via POST /vehicles/:id/odometer-segments. La base cumulée du nouveau segment est déterminée par l'API ;
 * le remplacement exige un motif et un justificatif joint (contrôles de l'API).
 */
export function OdometerSegmentDialog({
  mode,
  onClose,
  vehicleId,
  companyId,
  current,
  openSegment,
}: {
  mode: SegmentMode | null;
  onClose: () => void;
  vehicleId: string;
  companyId: string;
  current: OdometerCurrentView | undefined;
  openSegment: SegmentView | null;
}) {
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {mode ? (
          <SegmentForm
            key={mode}
            mode={mode}
            vehicleId={vehicleId}
            companyId={companyId}
            current={current}
            openSegment={openSegment}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SegmentForm({
  mode,
  vehicleId,
  companyId,
  current,
  openSegment,
  onClose,
}: {
  mode: SegmentMode;
  vehicleId: string;
  companyId: string;
  current: OdometerCurrentView | undefined;
  openSegment: SegmentView | null;
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const replacement = mode === 'REPLACEMENT';
  const [startedAt, setStartedAt] = useState(() => nowLocalInput(session.timezone));
  const [physicalKm, setPhysicalKm] = useState('');
  const [base, setBase] = useState<BaseChoice>('origine');
  const [cumulativeKm, setCumulativeKm] = useState('');
  const [oldCounterFinalKm, setOldCounterFinalKm] = useState('');
  const [reason, setReason] = useState('');
  const [justification, setJustification] = useState<UploadedFile | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<SegmentView>(`/vehicles/${vehicleId}/odometer-segments`, { method: 'POST', body }),
    onSuccess: (segment) => {
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      toast.success(
        replacement
          ? `Compteur n° ${segment.sequence} enregistré : cumul de départ ${formatKm(segment.startCumulativeKm)}${segment.cumulativeKnown ? '' : ' (cumul incomplet)'}.`
          : `Compteur initialisé : ${formatKm(segment.startPhysicalKm)} affichés${segment.cumulativeKnown ? `, cumul ${formatKm(segment.startCumulativeKm)}` : ', cumul incomplet'}.`,
      );
      onClose();
    },
    onError: (error) => {
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Enregistrement impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const local: FieldErrors = {};
    const iso = localInputToIso(startedAt, session.timezone);
    const km = normalizeKmInput(physicalKm);
    const cumul = normalizeKmInput(cumulativeKm);
    const oldKm = normalizeKmInput(oldCounterFinalKm);
    if (!iso) local.startedAt = ['Date d’effet obligatoire.'];
    if (!km) local.physicalKm = ['Valeur affichée obligatoire.'];
    else if (!isKmFormat(km)) local.physicalKm = ['Nombre attendu.'];
    if (!replacement && base === 'base' && !isKmFormat(cumul))
      local.cumulativeKm = ['Base cumulée validée obligatoire (nombre).'];
    if (replacement && cumul && !isKmFormat(cumul)) local.cumulativeKm = ['Nombre attendu.'];
    if (replacement && oldKm && !isKmFormat(oldKm)) local.oldCounterFinalKm = ['Nombre attendu.'];
    if (replacement && reason.trim().length < 3)
      local.reason = ['Motif du remplacement obligatoire (3 caractères au moins).'];
    // L'API exige le justificatif du remplacement (JUSTIFICATIF_REQUIS).
    if (replacement && !justification)
      local.justificationAttachmentId = [
        'Joignez le justificatif du remplacement (photo, facture ou attestation).',
      ];
    if (!replacement && reason.trim() && reason.trim().length < 3)
      local.reason = ['3 caractères au moins.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    const body: Record<string, unknown> = {
      mode,
      startedAt: iso,
      physicalKm: km,
      reason: reason.trim() || undefined,
    };
    if (replacement) {
      if (cumul) body.cumulativeKm = cumul;
      if (oldKm) body.oldCounterFinalKm = oldKm;
      if (justification) body.justificationAttachmentId = justification.id;
    } else if (base === 'base') {
      body.cumulativeKm = cumul;
      body.cumulativeKnown = true;
    } else if (base === 'inconnu') {
      body.cumulativeKnown = false;
    }
    save.mutate(body);
  }

  const reading = current?.reading ?? null;

  return (
    <form className="space-y-4" noValidate onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>
          {replacement ? 'Remplacement de compteur' : 'Initialiser le compteur'}
        </DialogTitle>
        <DialogDescription>
          {replacement
            ? 'Le compteur actuel est clôturé à la date du remplacement et un nouveau compteur est ouvert. Sa base cumulée est le dernier cumul validé de l’ancien compteur : aucune distance n’est fabriquée.'
            : 'Déclare la valeur de départ du compteur. Pour un compteur d’origine, le cumul du véhicule est égal à la valeur affichée ; sinon, indiquez une base validée ou déclarez l’historique inconnu.'}
        </DialogDescription>
      </DialogHeader>
      {replacement ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm">
          Compteur actuel : n° {openSegment?.sequence ?? '—'}
          {reading ? (
            <>
              {' '}
              · dernier relevé accepté {readingKmLabel(reading)} le{' '}
              {formatDateTime(reading.observedAt, session.timezone)}
            </>
          ) : null}
          .
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="segment-started">
            {replacement ? 'Date du remplacement *' : 'Date d’effet *'}
          </Label>
          <Input
            id="segment-started"
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            aria-invalid={Boolean(fieldErrors.startedAt?.length) || undefined}
            aria-describedby={describedBy(fieldErrors, 'startedAt', 'segment-started-hint')}
          />
          <p id="segment-started-hint" className="text-xs text-muted-foreground">
            Heure de {session.timezone} ; jamais dans le futur.
          </p>
          <FieldError errors={fieldErrors} name="startedAt" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="segment-km">
            {replacement
              ? 'Valeur affichée par le nouveau compteur (km) *'
              : 'Valeur affichée par le compteur (km) *'}
          </Label>
          <Input
            id="segment-km"
            inputMode="decimal"
            autoComplete="off"
            value={physicalKm}
            onChange={(e) => setPhysicalKm(e.target.value)}
            aria-invalid={Boolean(fieldErrors.physicalKm?.length) || undefined}
            aria-describedby={describedBy(fieldErrors, 'physicalKm')}
          />
          <FieldError errors={fieldErrors} name="physicalKm" />
        </div>
      </div>

      {replacement ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="segment-old-km">Dernière valeur lue sur l’ancien compteur (km)</Label>
            <Input
              id="segment-old-km"
              inputMode="decimal"
              autoComplete="off"
              value={oldCounterFinalKm}
              onChange={(e) => setOldCounterFinalKm(e.target.value)}
              aria-invalid={Boolean(fieldErrors.oldCounterFinalKm?.length) || undefined}
              aria-describedby={describedBy(
                fieldErrors,
                'oldCounterFinalKm',
                'segment-old-km-hint',
              )}
            />
            <p id="segment-old-km-hint" className="text-xs text-muted-foreground">
              Facultatif : si elle est lisible, elle est enregistrée comme relevé de clôture de
              l’ancien compteur à la date du remplacement.
            </p>
            <FieldError errors={fieldErrors} name="oldCounterFinalKm" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="segment-cumul">Base cumulée validée (km)</Label>
            <Input
              id="segment-cumul"
              inputMode="decimal"
              autoComplete="off"
              value={cumulativeKm}
              onChange={(e) => setCumulativeKm(e.target.value)}
              aria-invalid={Boolean(fieldErrors.cumulativeKm?.length) || undefined}
              aria-describedby={describedBy(fieldErrors, 'cumulativeKm', 'segment-cumul-hint')}
            />
            <p id="segment-cumul-hint" className="text-xs text-muted-foreground">
              Facultatif : utilisée seulement si aucun relevé validé n’existe sur l’ancien compteur.
              Sans base connue, le cumul du véhicule est signalé incomplet.
            </p>
            <FieldError errors={fieldErrors} name="cumulativeKm" />
          </div>
        </>
      ) : (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Kilométrage cumulé du véhicule</legend>
          <RadioGroup
            value={base}
            onValueChange={(v) => setBase(v as BaseChoice)}
            aria-describedby={describedBy(fieldErrors, 'cumulativeKnown')}
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem id="base-origine" value="origine" className="mt-0.5" />
              <Label htmlFor="base-origine" className="font-normal">
                Compteur d’origine : cumul égal à la valeur affichée
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem id="base-base" value="base" className="mt-0.5" />
              <Label htmlFor="base-base" className="font-normal">
                Compteur non d’origine : base cumulée validée connue
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem id="base-inconnu" value="inconnu" className="mt-0.5" />
              <Label htmlFor="base-inconnu" className="font-normal">
                Historique antérieur inconnu : cumul incomplet
              </Label>
            </div>
          </RadioGroup>
          <FieldError errors={fieldErrors} name="cumulativeKnown" />
          {base === 'base' ? (
            <div className="space-y-2">
              <Label htmlFor="segment-cumul">Base cumulée validée (km) *</Label>
              <Input
                id="segment-cumul"
                inputMode="decimal"
                autoComplete="off"
                value={cumulativeKm}
                onChange={(e) => setCumulativeKm(e.target.value)}
                aria-invalid={Boolean(fieldErrors.cumulativeKm?.length) || undefined}
                aria-describedby={describedBy(fieldErrors, 'cumulativeKm')}
              />
              <FieldError errors={fieldErrors} name="cumulativeKm" />
            </div>
          ) : null}
          {base === 'inconnu' ? (
            <p className="text-sm text-muted-foreground">
              Les échéances d’entretien au kilomètre afficheront « cumul incomplet » tant qu’aucune
              base n’est validée.
            </p>
          ) : null}
        </fieldset>
      )}

      <div className="space-y-2">
        <Label htmlFor="segment-reason">
          {replacement ? 'Motif du remplacement *' : 'Motif (facultatif)'}
        </Label>
        <Textarea
          id="segment-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={Boolean(fieldErrors.reason?.length) || undefined}
          aria-describedby={describedBy(fieldErrors, 'reason')}
        />
        <FieldError errors={fieldErrors} name="reason" />
      </div>

      {replacement ? (
        <AttachmentField
          id="segment-justification"
          label="Justificatif du remplacement *"
          hint="Photo du compteur, facture ou attestation : PDF, JPEG ou PNG, 10 Mo au plus. Obligatoire pour enregistrer le remplacement."
          companyId={companyId}
          accept="application/pdf,image/jpeg,image/png"
          value={justification}
          onChange={setJustification}
          errors={fieldErrors}
          errorName="justificationAttachmentId"
        />
      ) : null}

      <FormErrorAlert error={submitError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button
          type="submit"
          variant={replacement ? 'destructive' : 'default'}
          disabled={save.isPending}
        >
          {save.isPending
            ? 'Enregistrement…'
            : replacement
              ? 'Enregistrer le remplacement'
              : 'Initialiser le compteur'}
        </Button>
      </DialogFooter>
    </form>
  );
}
