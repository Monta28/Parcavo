'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { INCIDENT_SEVERITY_LABELS, READING_STATUS_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, formatKm } from '@/lib/format';
import type { UsageDetailView } from '@/lib/usages-types';
import {
  ApiErrorAlert,
  ChecklistField,
  type ChecklistState,
  checklistPayload,
  FuelGaugeField,
  gaugePayload,
  LocationField,
  type LocationMode,
  locationPayload,
  NO_GAUGE,
  PhotosField,
  type ReadingMode,
  ReadingField,
  type UploadedPhoto,
  useChecklistItems,
} from '../usage-form-parts';
import { isoToLocalInput, localInputToIso, locationInputErrors, normalizeKmInput, nowLocalInput, parseChecklist, readingInputErrors, useCanIn } from '../usage-helpers';

type FieldErrors = Record<string, string[]>;
type Severity = keyof typeof INCIDENT_SEVERITY_LABELS;

/** Champ à focaliser pour la première erreur de saisie détectée avant l'envoi. */
const FIELD_IDS: Record<string, string> = {
  returnedAt: 'returnedAt',
  'reading.physicalKm': 'RESTITUTION-km',
  'readingException.reason': 'RESTITUTION-exception-reason',
  'location.siteId': 'return-site',
  'location.placeLabel': 'return-place',
  'damageIncident.description': 'damageIncident.description',
};

/**
 * Restitution (CDC 4.4) : toujours possible, même si le véhicule est immobilisé ou hors service.
 * Idempotente (une clé par ouverture du formulaire) et protégée par la version de l'utilisation.
 */
export function ReturnForm({ usage, onDone, onCancel }: { usage: UsageDetailView; onDone: () => void; onCancel: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const canOverride = useCanIn(usage.companyId, 'exceptions.override');
  const checklistItems = useChecklistItems(usage.companyId);
  const departureChecklist = parseChecklist(usage.checkoutChecklist);

  const [returnedAt, setReturnedAt] = useState(() => nowLocalInput(session.timezone));
  const [readingMode, setReadingMode] = useState<ReadingMode>('releve');
  const [km, setKm] = useState('');
  const [kmPhoto, setKmPhoto] = useState<UploadedPhoto | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [locationMode, setLocationMode] = useState<LocationMode>('site');
  const [siteId, setSiteId] = useState('');
  const [placeLabel, setPlaceLabel] = useState('');
  const [gauge, setGauge] = useState(NO_GAUGE);
  const [checklist, setChecklist] = useState<ChecklistState>({});
  const [notes, setNotes] = useState('');
  const [confirmedByName, setConfirmedByName] = useState('');
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [damage, setDamage] = useState(false);
  const [damageDescription, setDamageDescription] = useState('');
  const [damageSeverity, setDamageSeverity] = useState<Severity>('MOYENNE');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const withReading = readingMode === 'releve' || !canOverride;
  const returnedIso = localInputToIso(returnedAt, session.timezone);

  const save = useMutation({
    mutationFn: () =>
      api<UsageDetailView>(`/usages/${usage.id}/return`, {
        method: 'POST',
        idempotencyKey,
        body: {
          returnedAt: returnedIso,
          reading: withReading && km.trim() ? { physicalKm: normalizeKmInput(km), ...(kmPhoto ? { attachmentId: kmPhoto.id } : {}) } : undefined,
          readingException: !withReading ? { reason: exceptionReason.trim() } : undefined,
          location: locationPayload(locationMode, siteId, placeLabel),
          fuelGauge: gaugePayload(gauge),
          checklist: checklistPayload(checklistItems.data, checklist),
          notes: notes.trim() || undefined,
          confirmedByName: confirmedByName.trim() || undefined,
          photoAttachmentIds: photos.length ? photos.map((p) => p.id) : undefined,
          damageIncident: damage ? { description: damageDescription.trim(), severity: damageSeverity } : undefined,
          expectedVersion: usage.version,
        },
      }),
    onSuccess: (updated) => {
      setConfirmOpen(false);
      queryClient.setQueryData(['usage', usage.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['usages'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', usage.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['driver', usage.driverId] });
      void queryClient.invalidateQueries({ queryKey: ['planning'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      toast.success(`Retour enregistré : ${updated.vehicleCode} restitué.${updated.damageIncident ? ` Incident de dommage ${updated.damageIncident.reference} ouvert ; il reste à traiter.` : ''}`);
      if (updated.returnReading && updated.returnReading.status !== 'ACCEPTE') {
        toast.warning(`Relevé de retour « ${READING_STATUS_LABELS[updated.returnReading.status] ?? updated.returnReading.status} » : la distance reste à valider.`);
      }
      onDone();
    },
    onError: (error) => {
      setConfirmOpen(false);
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète ou utilisation déjà terminée : on recharge la fiche pour repartir de l'état courant.
        if (error.status === 409) void queryClient.invalidateQueries({ queryKey: ['usage', usage.id] });
      } else toast.error('Enregistrement du retour impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    // Contrôles de présence uniquement (ordre visuel du formulaire) : les règles métier sont vérifiées par l'API.
    const local: FieldErrors = {};
    if (!returnedIso) local.returnedAt = ['Indiquez la date et l’heure du retour.'];
    Object.assign(local, readingInputErrors(withReading, km, exceptionReason), locationInputErrors(locationMode, siteId, placeLabel));
    if (damage && !damageDescription.trim()) local['damageIncident.description'] = ['Décrivez le dommage constaté ou décochez la déclaration.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) {
      document.getElementById(FIELD_IDS[Object.keys(local)[0] as string] ?? '')?.focus();
      return;
    }
    setConfirmOpen(true);
  }

  const checkoutKm = usage.checkoutReading?.physicalKm ?? null;

  return (
    <Card id="retour">
      <CardHeader>
        <CardTitle className="text-base">
          <h2 tabIndex={-1} id="retour-titre">
            Enregistrer le retour
          </h2>
        </CardTitle>
        <CardDescription>Le retour reste toujours possible, même si le véhicule est immobilisé ou hors service. La distance n’est validée qu’avec deux relevés acceptés.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" noValidate onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="returnedAt">Date et heure réelles du retour *</Label>
              <Input
                id="returnedAt"
                type="datetime-local"
                value={returnedAt}
                min={isoToLocalInput(usage.checkedOutAt, session.timezone)}
                onChange={(e) => setReturnedAt(e.target.value)}
                aria-invalid={Boolean(fieldErrors.returnedAt?.length) || undefined}
                aria-describedby={['returnedAt-hint', fieldErrors.returnedAt?.length ? 'returnedAt-error' : ''].filter(Boolean).join(' ')}
              />
              <p id="returnedAt-hint" className="text-xs text-muted-foreground">
                Remise le {formatDateTime(usage.checkedOutAt, session.timezone)} · retour prévu le {formatDateTime(usage.expectedReturnAt, session.timezone)}.
              </p>
              <FieldError errors={fieldErrors} name="returnedAt" />
            </div>
            <FuelGaugeField id="return-fuel" label="Niveau de carburant approximatif" value={gauge} onChange={setGauge} errors={fieldErrors} />
          </div>

          <ReadingField
            context="RESTITUTION"
            vehicleId={usage.vehicleId}
            companyId={usage.companyId}
            mode={readingMode}
            onModeChange={setReadingMode}
            canException={canOverride}
            km={km}
            onKmChange={setKm}
            reason={exceptionReason}
            onReasonChange={setExceptionReason}
            photo={kmPhoto}
            onPhotoChange={setKmPhoto}
            errors={fieldErrors}
            reference={
              <p className="text-sm text-muted-foreground">
                Relevé de départ : {usage.checkoutWithoutReading ? 'aucun (départ sans relevé)' : usage.checkoutReading ? `${formatKm(checkoutKm)} (${READING_STATUS_LABELS[usage.checkoutReading.status] ?? usage.checkoutReading.status})` : '—'}
              </p>
            }
          />

          <LocationField
            idPrefix="return"
            legend="Lieu de restitution"
            companyId={usage.companyId}
            mode={locationMode}
            onModeChange={setLocationMode}
            siteId={siteId}
            onSiteChange={setSiteId}
            placeLabel={placeLabel}
            onPlaceChange={setPlaceLabel}
            errors={fieldErrors}
          />

          <ChecklistField idPrefix="return" legend="Checklist de retour" companyId={usage.companyId} state={checklist} onChange={setChecklist} errors={fieldErrors} departure={departureChecklist} />

          <div className="space-y-2">
            <Label htmlFor="return-notes">Observations (réserves au retour)</Label>
            <Textarea id="return-notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} aria-describedby={fieldErrors.notes?.length ? 'notes-error' : undefined} />
            <FieldError errors={fieldErrors} name="notes" />
          </div>

          <PhotosField
            id="return-photos"
            legend="Photos du retour"
            companyId={usage.companyId}
            photos={photos}
            onAdd={(added) => setPhotos((prev) => [...prev, ...added])}
            onRemove={(id) => setPhotos((prev) => prev.filter((p) => p.id !== id))}
            errors={fieldErrors}
          />

          <fieldset className="space-y-3">
            <legend className="text-base font-semibold">Dommage constaté</legend>
            <div className="flex items-center gap-2">
              <Checkbox id="return-damage" checked={damage} onCheckedChange={(v) => setDamage(v === true)} />
              <Label htmlFor="return-damage">Déclarer un dommage (ouvre un incident)</Label>
            </div>
            {damage ? (
              <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-2">
                  <Label htmlFor="damageIncident.description">Description du dommage *</Label>
                  <Textarea
                    id="damageIncident.description"
                    value={damageDescription}
                    maxLength={4000}
                    onChange={(e) => setDamageDescription(e.target.value)}
                    aria-invalid={Boolean(fieldErrors['damageIncident.description']?.length) || undefined}
                    aria-describedby={['damage-hint', fieldErrors['damageIncident.description']?.length ? 'damageIncident.description-error' : ''].filter(Boolean).join(' ')}
                  />
                  <p id="damage-hint" className="text-xs text-muted-foreground">
                    L’incident est ouvert au moment du retour ; le retour ne le clôture pas.
                  </p>
                  <FieldError errors={fieldErrors} name="damageIncident.description" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="damage-severity">Gravité</Label>
                  <Select value={damageSeverity} onValueChange={(v) => setDamageSeverity(v as Severity)}>
                    <SelectTrigger id="damage-severity" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(INCIDENT_SEVERITY_LABELS).map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="return-confirmedByName">Confirmation nominative (facultative)</Label>
            <Input
              id="return-confirmedByName"
              value={confirmedByName}
              maxLength={150}
              autoComplete="off"
              onChange={(e) => setConfirmedByName(e.target.value)}
              placeholder="Nom de la personne qui confirme la restitution"
              aria-describedby={['return-confirmedByName-hint', fieldErrors.confirmedByName?.length ? 'confirmedByName-error' : ''].filter(Boolean).join(' ')}
            />
            <p id="return-confirmedByName-hint" className="text-xs text-muted-foreground">
              Simple mention du nom, conservée sur la fiche. Ce n’est pas une signature certifiée.
            </p>
            <FieldError errors={fieldErrors} name="confirmedByName" />
          </div>

          {submitError ? <ApiErrorAlert error={submitError} title="Le retour n’a pas été enregistré" idempotent /> : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer le retour'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !save.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer le retour</AlertDialogTitle>
            <AlertDialogDescription>
              {usage.vehicleCode} restitué par {usage.driverName}. L’utilisation passera « Terminée » ; cette action ne peut pas être annulée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid gap-1 text-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Retour :</dt>
              <dd className="font-medium">{returnedIso ? formatDateTime(returnedIso, session.timezone) : '—'}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Compteur :</dt>
              <dd className="font-medium">{withReading ? (km.trim() ? `${km.trim()} km (valeur saisie)` : 'Non saisi') : 'Retour constaté sans relevé (exception motivée)'}</dd>
            </div>
            {damage ? (
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Dommage :</dt>
                <dd className="font-medium">incident de gravité « {INCIDENT_SEVERITY_LABELS[damageSeverity]} » ouvert</dd>
              </div>
            ) : null}
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Revenir au formulaire</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {save.isPending ? 'Enregistrement…' : 'Confirmer le retour'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
