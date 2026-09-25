'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { READING_STATUS_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { FormErrorAlert, ReadingStatusBadge } from '@/components/odometer/reading-display';
import { describedBy, isKmFormat, normalizeKmInput, readingKmLabel } from '@/components/odometer/reading-helpers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import { formatDateTime } from '@/lib/format';
import { PhotoPreparationError, prepareCameraPhoto } from '@/lib/image-capture';
import type { IngestResult } from '@/lib/odometer-types';
import { useOnlineStatus } from '@/lib/use-online-status';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';

type FieldErrors = Record<string, string[]>;

interface Draft {
  physicalKm: string;
  /** Saisie datetime-local dans le fuseau de l'organisation. */
  observedAt: string;
  note: string;
  photo: { id: string; name: string } | null;
  /** Clé d'idempotence générée à l'ouverture du formulaire, réutilisée à chaque nouvel essai (D-267). */
  idempotencyKey: string;
}

/**
 * Véhicule visé par le relevé, fourni par l'API (GET /driver-submissions/vehicles) : celui de l'utilisation en
 * cours ou, si l'organisation l'autorise, celui dont le conducteur est responsable habituel (D-268).
 */
export interface ReadingTarget {
  vehicleId: string;
  vehicleCode: string;
  registration: string;
  /** Société de rattachement de la photo : celle de l'utilisation, sinon celle de la fiche conducteur. */
  companyId: string;
  /** Clé du brouillon : l'utilisation en cours, ou le véhicule dont le conducteur est responsable habituel. */
  draftId: string;
  /** Remise de l'utilisation en cours ; null pour le véhicule dont le conducteur est responsable habituel. */
  checkedOutAt: string | null;
}

const draftStorageKey = (draftId: string) => `parc-auto:mon-vehicule:kilometrage:${draftId}`;

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  const photoOk = d.photo === null || (typeof d.photo === 'object' && typeof (d.photo as Record<string, unknown>).id === 'string' && typeof (d.photo as Record<string, unknown>).name === 'string');
  return typeof d.physicalKm === 'string' && typeof d.observedAt === 'string' && typeof d.note === 'string' && typeof d.idempotencyKey === 'string' && d.idempotencyKey.length >= 8 && photoOk;
}

/** Brouillon conservé en sessionStorage (D-267) : jamais présenté comme enregistré. */
function readDraft(draftId: string): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(draftStorageKey(draftId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(draftId: string, draft: Draft): void {
  try {
    if (draft.physicalKm || draft.note || draft.photo) window.sessionStorage.setItem(draftStorageKey(draftId), JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftStorageKey(draftId));
  } catch {
    // Stockage indisponible (navigation privée, quota) : le brouillon reste en mémoire seulement.
  }
}

function clearDraft(draftId: string): void {
  try {
    window.sessionStorage.removeItem(draftStorageKey(draftId));
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

function freshDraft(timezone: string): Draft {
  return { physicalKm: '', observedAt: nowLocalInput(timezone), note: '', photo: null, idempotencyKey: newIdempotencyKey() };
}

/**
 * « Ajouter un kilométrage » (CDC 10.3, D-153, D-162, D-267) : valeur lue au compteur, date et heure
 * (maintenant par défaut), photo facultative prise avec l'appareil du téléphone. Envoi idempotent vers
 * POST /vehicles/:vehicleId/readings (véhicule cible fourni par l'API) ; un conducteur obtient toujours une
 * soumission en attente de validation.
 */
export function ReadingForm({ target, reference, onClose }: { target: ReadingTarget; reference: string | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [initial] = useState(() => {
    const saved = readDraft(target.draftId);
    return { draft: saved ?? freshDraft(session.timezone), restored: saved !== null };
  });
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [restored, setRestored] = useState(initial.restored);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<IngestResult | null>(null);
  const kmInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!result) writeDraft(target.draftId, draft);
  }, [target.draftId, draft, result]);

  // Focus sur la saisie à l'ouverture (et après « Ajouter un autre kilométrage »), sur la confirmation après envoi.
  useEffect(() => {
    if (result) resultHeading.current?.focus();
    else kmInput.current?.focus();
  }, [result]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const prepared = await prepareCameraPhoto(file);
      const form = new FormData();
      form.append('file', prepared);
      form.append('companyId', target.companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (att) => update({ photo: { id: att.id, name: att.originalName } }),
  });

  const submit = useMutation({
    mutationFn: (body: { physicalKm: string; observedAt: string; attachmentId?: string; note?: string }) =>
      api<IngestResult>(`/vehicles/${target.vehicleId}/readings`, { method: 'POST', body, idempotencyKey: draft.idempotencyKey }),
    onSuccess: (res) => {
      clearDraft(target.draftId);
      setFieldErrors({});
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', target.vehicleId] });
      toast.success(res.reading.status === 'EN_ATTENTE' ? 'Kilométrage envoyé : en attente de validation.' : `Kilométrage enregistré : ${READING_STATUS_LABELS[res.reading.status] ?? res.reading.status}.`);
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.status === 0 ? 'Non enregistré : vérifiez votre connexion puis réessayez.' : error.message);
        // Un envoi antérieur a pu aboutir : la liste des soumissions est rechargée.
        if (error.status === 409) void queryClient.invalidateQueries({ queryKey: ['readings'] });
      } else toast.error('Non enregistré, réessayez.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    const km = normalizeKmInput(draft.physicalKm);
    const observedIso = localInputToIso(draft.observedAt, session.timezone);
    if (!km) local.physicalKm = ['Saisissez la valeur affichée au compteur.'];
    else if (!isKmFormat(km)) local.physicalKm = ['Nombre positif attendu, par exemple 45230.'];
    if (!observedIso) local.observedAt = ['Indiquez la date et l’heure du relevé.'];
    setFieldErrors(local);
    if (!observedIso || Object.keys(local).length > 0) return;
    submit.mutate({ physicalKm: km, observedAt: observedIso, attachmentId: draft.photo?.id, note: draft.note.trim() || undefined });
  }

  function restart() {
    const next = freshDraft(session.timezone);
    submit.reset();
    upload.reset();
    setFieldErrors({});
    setRestored(false);
    setResult(null);
    setDraft(next);
  }

  function cancel() {
    clearDraft(target.draftId);
    onClose();
  }

  if (result) {
    const r = result.reading;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h2 ref={resultHeading} tabIndex={-1} className="outline-none">
              {result.outcome === 'IDEMPOTENT' ? 'Kilométrage déjà enregistré' : 'Kilométrage envoyé'}
            </h2>
          </CardTitle>
          <CardDescription>Réponse du serveur reçue : la saisie est enregistrée.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div role="status" className="space-y-2 rounded-md border p-3">
            <p className="text-lg font-semibold">{readingKmLabel(r)}</p>
            <p className="text-muted-foreground">Relevé du {formatDateTime(r.observedAt, session.timezone)}</p>
            <ReadingStatusBadge status={r.status} />
            {r.status === 'EN_ATTENTE' ? <p>Le gestionnaire du parc doit le valider. Suivez son statut dans « Mes soumissions ».</p> : null}
            {result.outcome === 'IDEMPOTENT' ? <p>Ce relevé existait déjà : aucun doublon n’a été créé.</p> : null}
            {result.anomaly ? (
              <p className="text-muted-foreground">
                {r.status === 'EN_ATTENTE' ? 'Motif d’attente' : 'Point signalé'} : {result.anomaly.reason}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" className="h-11" onClick={restart}>
              Ajouter un autre kilométrage
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              Fermer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const busy = submit.isPending || upload.isPending;
  const submitError = submit.error;
  const bodyMismatch = isApiError(submitError) && submitError.code === 'IDEMPOTENCE_CORPS_DIFFERENT';
  const uploadError = upload.error instanceof PhotoPreparationError ? upload.error.message : isApiError(upload.error) ? upload.error.message : upload.error ? 'Téléversement impossible : la photo n’est pas jointe.' : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h2>Ajouter un kilométrage</h2>
        </CardTitle>
        <CardDescription>
          {target.vehicleCode} · {target.registration}.{' '}
          {session.isDriverOnly ? 'Le relevé sera soumis à la validation du gestionnaire du parc.' : 'Le statut du relevé (accepté ou en attente de validation) est déterminé par le serveur.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" noValidate onSubmit={onSubmit}>
          {restored ? (
            <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              Brouillon non envoyé restauré : vérifiez les valeurs puis envoyez. Rien n’a été enregistré tant que la confirmation n’apparaît pas.
            </p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="reading-km">Kilométrage affiché au compteur *</Label>
            <div className="flex items-center gap-2">
              <Input
                ref={kmInput}
                id="reading-km"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="send"
                className="h-12 text-lg"
                value={draft.physicalKm}
                onChange={(e) => update({ physicalKm: e.target.value })}
                aria-invalid={fieldErrors.physicalKm?.length ? true : undefined}
                aria-describedby={describedBy(fieldErrors, 'physicalKm', 'reading-km-hint')}
              />
              <span className="text-muted-foreground" aria-hidden="true">
                km
              </span>
            </div>
            <p id="reading-km-hint" className="text-xs text-muted-foreground">
              Valeur lue au tableau de bord, en kilomètres.{reference ? ` Dernier kilométrage validé : ${reference}.` : ''}
            </p>
            <FieldError errors={fieldErrors} name="physicalKm" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reading-observed-at">Date et heure du relevé *</Label>
            <Input
              id="reading-observed-at"
              type="datetime-local"
              className="h-12"
              value={draft.observedAt}
              onChange={(e) => update({ observedAt: e.target.value })}
              aria-invalid={fieldErrors.observedAt?.length ? true : undefined}
              aria-describedby={describedBy(fieldErrors, 'observedAt', 'reading-observed-at-hint')}
            />
            <p id="reading-observed-at-hint" className="text-xs text-muted-foreground">
              Par défaut, maintenant : indiquez le moment où vous avez lu le compteur ({target.checkedOutAt ? `véhicule remis le ${formatDateTime(target.checkedOutAt, session.timezone)}` : 'véhicule dont vous êtes responsable habituel'}). Une date future est refusée.
            </p>
            <FieldError errors={fieldErrors} name="observedAt" />
          </div>

          <div className="space-y-2">
            <Label id="reading-photo-label" htmlFor="reading-photo">
              Photo du compteur (recommandée)
            </Label>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
            {draft.photo ? (
              <div className="flex flex-wrap items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/v1/attachments/${draft.photo.id}/download`} alt="Photo du compteur jointe" className="h-20 w-28 rounded-md border object-cover" />
                <Button
                  id="reading-photo"
                  type="button"
                  variant="outline"
                  onClick={() => update({ photo: null })}
                  aria-labelledby="reading-photo-label reading-photo"
                  aria-describedby={describedBy(fieldErrors, 'attachmentId', 'reading-photo-hint')}
                >
                  Retirer la photo
                </Button>
              </div>
            ) : (
              <Button
                id="reading-photo"
                type="button"
                variant="outline"
                className="h-12 w-full"
                disabled={upload.isPending}
                onClick={() => fileInput.current?.click()}
                aria-labelledby="reading-photo-label reading-photo"
                aria-describedby={describedBy(fieldErrors, 'attachmentId', 'reading-photo-hint')}
              >
                <Camera className="size-4" aria-hidden="true" />
                {upload.isPending ? 'Envoi de la photo…' : 'Prendre ou choisir une photo'}
              </Button>
            )}
            <p id="reading-photo-hint" className="text-xs text-muted-foreground">
              La photo aide à valider votre saisie. Elle est réduite en JPEG avant l’envoi.
            </p>
            {uploadError ? (
              <p role="alert" className="text-sm text-destructive">
                {uploadError}
              </p>
            ) : null}
            <FieldError errors={fieldErrors} name="attachmentId" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reading-note">Commentaire (facultatif)</Label>
            <Textarea id="reading-note" maxLength={1000} value={draft.note} onChange={(e) => update({ note: e.target.value })} aria-invalid={fieldErrors.note?.length ? true : undefined} aria-describedby={describedBy(fieldErrors, 'note')} />
            <FieldError errors={fieldErrors} name="note" />
          </div>

          {!online ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Hors connexion : l’envoi échouera et rien ne sera enregistré. Votre saisie reste sur cet appareil ; envoyez-la quand la connexion revient.
            </p>
          ) : null}

          {submitError ? (
            <div className="space-y-2">
              <FormErrorAlert error={submitError} />
              {isApiError(submitError) && (submitError.status === 0 || submitError.status >= 500) ? (
                <p className="text-sm text-muted-foreground">Votre saisie est conservée. Le nouvel envoi réutilise la même clé : aucun doublon ne sera créé.</p>
              ) : null}
              {bodyMismatch ? (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">Un envoi précédent de ce formulaire a peut-être déjà été enregistré : vérifiez « Mes soumissions » avant de recommencer.</p>
                  <Button type="button" variant="outline" onClick={restart}>
                    Recommencer une nouvelle saisie
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" className="h-12 text-base" disabled={busy}>
              {submit.isPending ? 'Envoi…' : 'Envoyer le kilométrage'}
            </Button>
            <Button type="button" variant="outline" className="h-12" onClick={cancel} disabled={submit.isPending}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
