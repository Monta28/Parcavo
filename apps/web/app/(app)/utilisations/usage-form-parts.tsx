'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { FRESHNESS_LABELS, FUEL_GAUGE_LABELS, MEASUREMENT_KIND_LABELS, READING_SOURCE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { StatusBadge, toneForFreshness } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { AttachmentView } from '@/lib/drivers-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { CurrentOdometerView, EffectiveSettingView, FuelGauge, UsageChecklistEntry } from '@/lib/usages-types';
import type { SiteView } from '@/lib/vehicles-types';
import { blockersFromDetails, checklistItemsFromSettings, reservationsFromDetails } from './usage-helpers';

type FieldErrors = Record<string, string[]>;

export interface UploadedPhoto {
  id: string;
  name: string;
}

async function uploadAttachment(file: File, companyId: string): Promise<AttachmentView> {
  const form = new FormData();
  form.append('file', file);
  form.append('companyId', companyId);
  return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
}

function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

// ---------------------------------------------------------------------------
// Erreur API détaillée (message métier, blocages, réservations en conflit)
// ---------------------------------------------------------------------------

/**
 * `idempotent` : l'envoi porte une clé d'idempotence (remise, restitution) ; hors connexion, on précise
 * qu'un nouvel essai est rejoué sans doublon. Sans clé, on invite seulement à vérifier puis réessayer.
 */
export function ApiErrorAlert({ error, title, idempotent = false }: { error: unknown; title?: string; idempotent?: boolean }) {
  const session = useSession();
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  const blockers = blockersFromDetails(apiError?.details);
  const reservations = reservationsFromDetails(apiError?.details);
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      {title ? <p className="font-medium text-destructive">{title}</p> : null}
      <p className="text-destructive">{apiError ? apiError.message : 'Une erreur est survenue.'}</p>
      {apiError?.status === 0 ? (
        <p className="mt-1 text-muted-foreground">
          {idempotent
            ? 'Vérifiez votre connexion puis relancez l’envoi sans modifier le formulaire : il sera rejoué avec la même clé, sans créer de doublon.'
            : 'Vérifiez votre connexion puis réessayez.'}
        </p>
      ) : null}
      {blockers.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {blockers.map((b) => (
            <li key={`${b.code}-${b.message}`}>{b.message}</li>
          ))}
        </ul>
      ) : null}
      {reservations.length > 0 ? (
        <div className="mt-2">
          <p className="font-medium">Réservations en conflit :</p>
          <ul className="list-disc space-y-1 pl-5">
            {reservations.map((r) => (
              <li key={r.id}>
                {r.driverName} : du {formatDateTime(r.startAt, session.timezone)} au {formatDateTime(r.endAt, session.timezone)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {apiError?.requestId ? <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compteur : relevé lu ou exception motivée
// ---------------------------------------------------------------------------

export type ReadingMode = 'releve' | 'exception';

export function CurrentOdometerHint({ vehicleId }: { vehicleId: string }) {
  const session = useSession();
  const odometer = useQuery({ queryKey: ['vehicle', vehicleId, 'odometer'], queryFn: () => api<CurrentOdometerView>(`/vehicles/${vehicleId}/odometer`) });
  if (odometer.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Chargement du compteur courant…
      </p>
    );
  }
  if (odometer.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Compteur courant indisponible : {isApiError(odometer.error) ? odometer.error.message : 'erreur inconnue'}{' '}
        <button type="button" className="underline underline-offset-4" onClick={() => void odometer.refetch()}>
          Réessayer
        </button>
      </p>
    );
  }
  const o = odometer.data;
  const r = o.reading;
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      {r ? (
        <>
          <p>
            Compteur courant : <span className="font-semibold">{formatKm(r.isEstimate ? r.cumulativeKm : r.physicalKm, { estimate: r.isEstimate })}</span>
          </p>
          <p className="text-muted-foreground">
            {READING_SOURCE_LABELS[r.source as keyof typeof READING_SOURCE_LABELS] ?? r.source} · {MEASUREMENT_KIND_LABELS[r.measurementKind as keyof typeof MEASUREMENT_KIND_LABELS] ?? r.measurementKind} · observé le{' '}
            {formatDateTime(r.observedAt, session.timezone)}
          </p>
        </>
      ) : (
        <p>Kilométrage inconnu : aucun relevé accepté pour ce véhicule.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <StatusBadge label={`Kilométrage : ${FRESHNESS_LABELS[o.freshness]}${o.ageDays !== null ? ` (${o.ageDays} j)` : ''}`} tone={toneForFreshness(o.freshness)} />
        {o.pendingCount > 0 ? <StatusBadge label={`${o.pendingCount} relevé(s) en attente de validation`} tone="warning" /> : null}
        {!o.cumulativeKnown ? <StatusBadge label="Cumul incomplet" tone="warning" /> : null}
      </div>
      {o.lastTelematicsHint ? (
        <p className="text-muted-foreground">
          Aide télématique : {formatKm(o.lastTelematicsHint.valueKm)} ({MEASUREMENT_KIND_LABELS[o.lastTelematicsHint.kind as keyof typeof MEASUREMENT_KIND_LABELS] ?? o.lastTelematicsHint.kind}) le{' '}
          {formatDateTime(o.lastTelematicsHint.observedAt, session.timezone)}. Indication seulement : saisissez la valeur lue sur le tableau de bord.
        </p>
      ) : null}
    </div>
  );
}

export function ReadingField({
  context,
  vehicleId,
  companyId,
  mode,
  onModeChange,
  canException,
  km,
  onKmChange,
  reason,
  onReasonChange,
  photo,
  onPhotoChange,
  errors,
  reference,
}: {
  context: 'REMISE' | 'RESTITUTION';
  vehicleId: string | null;
  companyId: string | null;
  mode: ReadingMode;
  onModeChange: (mode: ReadingMode) => void;
  canException: boolean;
  km: string;
  onKmChange: (value: string) => void;
  reason: string;
  onReasonChange: (value: string) => void;
  photo: UploadedPhoto | null;
  onPhotoChange: (photo: UploadedPhoto | null) => void;
  errors: FieldErrors;
  reference?: React.ReactNode;
}) {
  const exceptionLabel = context === 'REMISE' ? 'Départ sans relevé (exception motivée)' : 'Retour constaté sans relevé (exception motivée)';
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-semibold">Relevé du compteur</legend>
      {vehicleId ? <CurrentOdometerHint vehicleId={vehicleId} /> : <p className="text-sm text-muted-foreground">Choisissez d’abord le véhicule pour afficher son compteur courant.</p>}
      {reference}
      {canException ? (
        <RadioGroup value={mode} onValueChange={(v) => onModeChange(v as ReadingMode)} aria-label="Mode de relevé" className="gap-2">
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${context}-mode-releve`} value="releve" />
            <Label htmlFor={`${context}-mode-releve`}>Relevé lu sur le compteur</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${context}-mode-exception`} value="exception" />
            <Label htmlFor={`${context}-mode-exception`}>{exceptionLabel}</Label>
          </div>
        </RadioGroup>
      ) : null}
      {mode === 'releve' || !canException ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${context}-km`}>Compteur affiché (km) *</Label>
            <Input
              id={`${context}-km`}
              inputMode="decimal"
              autoComplete="off"
              value={km}
              onChange={(e) => onKmChange(e.target.value)}
              aria-invalid={Boolean(errors['reading.physicalKm']?.length) || undefined}
              aria-describedby={describedBy(errors, 'reading.physicalKm', `${context}-km-hint`)}
            />
            <p id={`${context}-km-hint`} className="text-xs text-muted-foreground">
              Valeur lue sur le tableau de bord, jamais estimée. Le relevé est contrôlé par le serveur.
            </p>
            <FieldError errors={errors} name="reading.physicalKm" />
          </div>
          <SinglePhotoField id={`${context}-km-photo`} label="Photo du compteur (facultative)" companyId={companyId} photo={photo} onChange={onPhotoChange} errors={errors} errorName="reading.attachmentId" />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${context}-exception-reason`}>Motif de l’exception * (5 caractères minimum)</Label>
          <Textarea
            id={`${context}-exception-reason`}
            value={reason}
            maxLength={500}
            onChange={(e) => onReasonChange(e.target.value)}
            aria-invalid={Boolean(errors['readingException.reason']?.length) || undefined}
            aria-describedby={describedBy(errors, 'readingException.reason', `${context}-exception-hint`)}
          />
          <p id={`${context}-exception-hint`} className="text-xs text-muted-foreground">
            {context === 'REMISE'
              ? 'Exception réservée au chef de parc ou à l’administrateur : une alerte persistante est créée et la distance restera indéterminée.'
              : 'Constat réservé au chef de parc ou à l’administrateur : le trajet restera « distance non validée » jusqu’à régularisation.'}
          </p>
          <FieldError errors={errors} name="readingException.reason" />
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Lieu : site ou lieu libre (exclusifs)
// ---------------------------------------------------------------------------

export type LocationMode = 'site' | 'libre';

export function LocationField({
  idPrefix,
  legend,
  companyId,
  mode,
  onModeChange,
  siteId,
  onSiteChange,
  placeLabel,
  onPlaceChange,
  errors,
}: {
  idPrefix: string;
  legend: string;
  companyId: string | null;
  mode: LocationMode;
  onModeChange: (mode: LocationMode) => void;
  siteId: string;
  onSiteChange: (id: string) => void;
  placeLabel: string;
  onPlaceChange: (value: string) => void;
  errors: FieldErrors;
}) {
  const sites = useQuery({
    queryKey: ['sites', companyId],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId, pageSize: 100, status: 'ACTIF' })}`),
    enabled: Boolean(companyId),
  });
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-semibold">{legend}</legend>
      <RadioGroup value={mode} onValueChange={(v) => onModeChange(v as LocationMode)} aria-label={`${legend} : type de lieu`} className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-loc-site`} value="site" />
          <Label htmlFor={`${idPrefix}-loc-site`}>Site de la société</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-loc-libre`} value="libre" />
          <Label htmlFor={`${idPrefix}-loc-libre`}>Lieu libre</Label>
        </div>
      </RadioGroup>
      <p id={`${idPrefix}-loc-hint`} className="text-xs text-muted-foreground">
        Lieu obligatoire : un site actif de la société du véhicule, ou un lieu libre.
      </p>
      {mode === 'site' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-site`}>Site *</Label>
          <Select value={siteId} onValueChange={onSiteChange} disabled={!companyId}>
            <SelectTrigger
              id={`${idPrefix}-site`}
              className="w-full"
              aria-invalid={Boolean(errors['location.siteId']?.length) || undefined}
              aria-describedby={describedBy(errors, 'location.siteId', `${idPrefix}-loc-hint`)}
            >
              <SelectValue placeholder={!companyId ? 'Choisissez d’abord le véhicule' : sites.isPending ? 'Chargement des sites…' : 'Choisir un site'} />
            </SelectTrigger>
            <SelectContent>
              {(sites.data?.items ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sites.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Sites indisponibles : {isApiError(sites.error) ? sites.error.message : 'erreur inconnue'}
            </p>
          ) : sites.data && sites.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun site actif pour cette société : indiquez un lieu libre.</p>
          ) : null}
          <FieldError errors={errors} name="location.siteId" />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-place`}>Lieu *</Label>
          <Input
            id={`${idPrefix}-place`}
            value={placeLabel}
            maxLength={200}
            onChange={(e) => onPlaceChange(e.target.value)}
            placeholder="Ex. parking client, agence de Sfax"
            aria-invalid={Boolean(errors['location.placeLabel']?.length) || undefined}
            aria-describedby={describedBy(errors, 'location.placeLabel', `${idPrefix}-loc-hint`)}
          />
          <FieldError errors={errors} name="location.placeLabel" />
        </div>
      )}
    </fieldset>
  );
}

export function locationPayload(mode: LocationMode, siteId: string, placeLabel: string): { siteId?: string; placeLabel?: string } | undefined {
  if (mode === 'site' && siteId) return { siteId };
  if (mode === 'libre' && placeLabel.trim()) return { placeLabel: placeLabel.trim() };
  return undefined;
}

// ---------------------------------------------------------------------------
// Carburant approximatif
// ---------------------------------------------------------------------------

export const NO_GAUGE = '__non_renseigne__';

export function FuelGaugeField({ id, label, value, onChange, errors }: { id: string; label: string; value: string; onChange: (v: string) => void; errors: FieldErrors }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" aria-describedby={describedBy(errors, 'fuelGauge')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_GAUGE}>Non renseigné</SelectItem>
          {Object.entries(FUEL_GAUGE_LABELS).map(([k, l]) => (
            <SelectItem key={k} value={k}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={errors} name="fuelGauge" />
    </div>
  );
}

export function gaugePayload(value: string): FuelGauge | undefined {
  return value === NO_GAUGE ? undefined : (value as FuelGauge);
}

// ---------------------------------------------------------------------------
// Checklist : clés, documents et accessoires (paramètre usage.checklistItems)
// ---------------------------------------------------------------------------

export type ChecklistState = Record<string, { present: boolean; comment: string }>;

export function useChecklistItems(companyId: string | null) {
  return useQuery({
    queryKey: ['settings', 'effective', companyId],
    queryFn: () => api<EffectiveSettingView[]>(`/settings${toQuery({ companyId })}`),
    enabled: Boolean(companyId),
    select: (settings) => checklistItemsFromSettings(settings),
  });
}

export function ChecklistField({
  idPrefix,
  legend,
  companyId,
  state,
  onChange,
  errors,
  departure,
}: {
  idPrefix: string;
  legend: string;
  companyId: string | null;
  state: ChecklistState;
  onChange: (state: ChecklistState) => void;
  errors: FieldErrors;
  /** Checklist de départ, affichée pour comparaison lors du retour. */
  departure?: UsageChecklistEntry[];
}) {
  const items = useChecklistItems(companyId);
  const update = (label: string, patch: Partial<{ present: boolean; comment: string }>) => {
    const current = state[label] ?? { present: false, comment: '' };
    onChange({ ...state, [label]: { ...current, ...patch } });
  };
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-semibold">{legend}</legend>
      {!companyId ? (
        <p className="text-sm text-muted-foreground">Choisissez d’abord le véhicule pour afficher la checklist de sa société.</p>
      ) : items.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Chargement de la checklist…
        </p>
      ) : items.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Checklist indisponible : {isApiError(items.error) ? items.error.message : 'erreur inconnue'}{' '}
          <button type="button" className="underline underline-offset-4" onClick={() => void items.refetch()}>
            Réessayer
          </button>
        </p>
      ) : items.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun élément de checklist n’est paramétré pour cette société.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.data.map((label, index) => {
            const entry = state[label] ?? { present: false, comment: '' };
            const before = departure?.find((d) => d.label === label);
            const checkboxId = `${idPrefix}-check-${index}`;
            return (
              <li key={label} className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center">
                <div className="flex items-center gap-2">
                  <Checkbox id={checkboxId} checked={entry.present} onCheckedChange={(v) => update(label, { present: v === true })} />
                  <Label htmlFor={checkboxId} className="leading-snug">
                    {label}
                  </Label>
                  {departure ? <span className="text-xs text-muted-foreground">(au départ : {before ? (before.present ? 'remis' : 'non remis') : 'non renseigné'})</span> : null}
                </div>
                <Input aria-label={`Commentaire : ${label}`} placeholder="Commentaire (facultatif)" maxLength={300} value={entry.comment} onChange={(e) => update(label, { comment: e.target.value })} />
              </li>
            );
          })}
        </ul>
      )}
      <FieldError errors={errors} name="checklist" />
    </fieldset>
  );
}

export function checklistPayload(items: string[] | undefined, state: ChecklistState): UsageChecklistEntry[] | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map((label) => {
    const entry = state[label];
    const comment = entry?.comment.trim();
    return { label, present: entry?.present ?? false, ...(comment ? { comment } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Photos (téléversement privé puis rattachement par la remise ou la restitution)
// ---------------------------------------------------------------------------

export function SinglePhotoField({
  id,
  label,
  companyId,
  photo,
  onChange,
  errors,
  errorName,
}: {
  id: string;
  label: string;
  companyId: string | null;
  photo: UploadedPhoto | null;
  onChange: (photo: UploadedPhoto | null) => void;
  errors: FieldErrors;
  errorName: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadAttachment(file, companyId as string),
    onSuccess: (att) => onChange({ id: att.id, name: att.originalName }),
  });
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        disabled={!companyId || upload.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }}
      />
      {photo ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/v1/attachments/${photo.id}/download`} alt="Photo du compteur téléversée" className="h-16 w-24 rounded-md border object-cover" />
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            Retirer la photo
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" disabled={!companyId || upload.isPending} onClick={() => input.current?.click()}>
          {upload.isPending ? 'Envoi…' : 'Prendre ou choisir une photo'}
        </Button>
      )}
      {upload.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(upload.error) ? upload.error.message : 'Téléversement impossible.'}
        </p>
      ) : null}
      <FieldError errors={errors} name={errorName} />
    </div>
  );
}

export function PhotosField({
  id,
  legend,
  companyId,
  photos,
  onAdd,
  onRemove,
  errors,
  max = 10,
}: {
  id: string;
  legend: string;
  companyId: string | null;
  photos: UploadedPhoto[];
  onAdd: (added: UploadedPhoto[]) => void;
  onRemove: (id: string) => void;
  errors: FieldErrors;
  max?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const added: UploadedPhoto[] = [];
      try {
        for (const [index, file] of files.entries()) {
          setProgress(`Envoi ${index + 1} / ${files.length}…`);
          const att = await uploadAttachment(file, companyId as string);
          added.push({ id: att.id, name: att.originalName });
        }
      } finally {
        // Les photos déjà reçues par le serveur restent jointes même si un envoi suivant échoue.
        if (added.length) onAdd(added);
        setProgress(null);
      }
    },
  });
  const remaining = max - photos.length;
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-semibold">{legend}</legend>
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/jpeg,image/png"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label={`${legend} : choisir des fichiers`}
        disabled={!companyId || upload.isPending || remaining <= 0}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).slice(0, Math.max(0, remaining));
          if (files.length) upload.mutate(files);
          e.target.value = '';
        }}
      />
      {photos.length > 0 ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {photos.map((p, index) => (
            <li key={p.id} className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/v1/attachments/${p.id}/download`} alt={`Photo ${index + 1} : ${p.name}`} className="aspect-video w-full rounded-md border object-cover" />
              <Button type="button" variant="ghost" size="sm" className="h-auto px-1 py-0.5 text-xs" onClick={() => onRemove(p.id)}>
                Retirer<span className="sr-only"> la photo {index + 1}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Aucune photo (facultatif).</p>
      )}
      <Button type="button" variant="outline" disabled={!companyId || upload.isPending || remaining <= 0} onClick={() => input.current?.click()}>
        {upload.isPending ? (progress ?? 'Envoi…') : remaining <= 0 ? `Maximum de ${max} photos atteint` : 'Ajouter des photos (JPEG ou PNG)'}
      </Button>
      {upload.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(upload.error) ? upload.error.message : 'Téléversement impossible.'}
        </p>
      ) : null}
      <FieldError errors={errors} name="photoAttachmentIds" />
    </fieldset>
  );
}
