'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Fuel, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useSession } from '@/components/layout/session-context';
import { AttachmentLink } from '@/components/odometer/reading-display';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { AttachmentView, DriverView } from '@/lib/drivers-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { FuelEntryView, SubmissionTargetView } from '@/lib/fuel-types';
import { PhotoPreparationError, prepareCameraPhoto } from '@/lib/image-capture';
import type { UsageView } from '@/lib/usages-types';
import { useOnlineStatus } from '@/lib/use-online-status';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { FuelStatusBadge, formatFuelLiters, useMoney } from '../carburant/fuel-display';
import { FullTankField, isDecimal3, normalizeDecimal } from '../carburant/fuel-form-parts';

/** Véhicule proposé pour un ticket : fourni par l'API (cible de soumission ou dernière utilisation). */
interface Candidate {
  vehicleId: string;
  label: string;
  detail: string;
  /** Société de rattachement du ticket téléversé (celle de l'utilisation, sinon celle de la fiche conducteur). */
  companyId: string;
}

interface Draft {
  vehicleId: string;
  filledAt: string;
  liters: string;
  totalAmount: string;
  unitPrice: string;
  odometerKm: string;
  isFullTank: boolean | null;
  notes: string;
  ticket: { id: string; name: string } | null;
  /** Clé d'idempotence générée à l'ouverture du formulaire, réutilisée à chaque nouvel essai (D-267). */
  idempotencyKey: string;
}

const DRAFT_KEY = 'parc-auto:mon-vehicule:carburant';

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  const ticketOk = d.ticket === null || (typeof d.ticket === 'object' && typeof (d.ticket as Record<string, unknown>).id === 'string' && typeof (d.ticket as Record<string, unknown>).name === 'string');
  const strings = ['vehicleId', 'filledAt', 'liters', 'totalAmount', 'unitPrice', 'odometerKm', 'notes', 'idempotencyKey'].every((k) => typeof d[k] === 'string');
  return strings && (d.isFullTank === null || typeof d.isFullTank === 'boolean') && ticketOk && (d.idempotencyKey as string).length >= 8;
}

/** Brouillon conservé en sessionStorage (D-267) : jamais présenté comme enregistré. */
function readDraft(): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft): void {
  try {
    if (draft.liters || draft.totalAmount || draft.ticket || draft.odometerKm || draft.notes) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Stockage indisponible (navigation privée, quota) : le brouillon reste en mémoire seulement.
  }
}

function clearDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

function freshDraft(timezone: string, vehicleId: string): Draft {
  return { vehicleId, filledAt: nowLocalInput(timezone), liters: '', totalAmount: '', unitPrice: '', odometerKm: '', isFullTank: null, notes: '', ticket: null, idempotencyKey: newIdempotencyKey() };
}

/**
 * Véhicules proposés au conducteur : cibles de soumission renvoyées par l'API (utilisation EN_COURS, ou
 * véhicule dont il est responsable habituel si l'organisation l'autorise, D-268), et véhicule de sa
 * dernière utilisation terminée (ticket oublié, D-226). Le serveur tranche à l'envoi (404 ou 422 motivé).
 */
function useCandidates(driverId: string) {
  const targets = useQuery({ queryKey: ['driver-submissions', 'vehicles'], queryFn: () => api<SubmissionTargetView[]>('/driver-submissions/vehicles') });
  // Utilisation la plus récente (en cours d'abord) : société du ticket de l'utilisation en cours.
  const latest = useQuery({ queryKey: ['usages', 'mon-vehicule', 'derniere'], queryFn: () => api<Page<UsageView>>(`/usages${toQuery({ pageSize: 1 })}`) });
  // Dernière utilisation terminée, même si une autre est en cours (ticket oublié après restitution, D-226).
  const lastReturned = useQuery({ queryKey: ['usages', 'mon-vehicule', 'derniere-terminee'], queryFn: () => api<Page<UsageView>>(`/usages${toQuery({ status: 'TERMINEE', pageSize: 1 })}`) });
  const driver = useQuery({ queryKey: ['driver', driverId], queryFn: () => api<DriverView>(`/drivers/${driverId}`) });
  const session = useSession();
  const usage = latest.data?.items[0] ?? null;
  const returned = lastReturned.data?.items[0] ?? null;
  const candidates: Candidate[] = [];
  for (const t of targets.data ?? []) {
    const companyId = usage && t.usageId === usage.id ? usage.companyId : driver.data?.companyId;
    if (!companyId) continue;
    candidates.push({ vehicleId: t.vehicleId, label: `${t.vehicleCode} · ${t.registration}`, detail: t.basis === 'UTILISATION_EN_COURS' ? 'Utilisation en cours' : 'Véhicule dont vous êtes responsable habituel', companyId });
  }
  if (returned && returned.status === 'TERMINEE' && !candidates.some((c) => c.vehicleId === returned.vehicleId)) {
    candidates.push({ vehicleId: returned.vehicleId, label: `${returned.vehicleCode} · ${returned.vehicleRegistration}`, detail: `Dernière utilisation, restituée le ${formatDateTime(returned.returnedAt, session.timezone)} (ticket oublié)`, companyId: returned.companyId });
  }
  const pending = targets.isPending || latest.isPending || lastReturned.isPending || driver.isPending;
  const error = targets.error ?? latest.error ?? lastReturned.error ?? null;
  return { candidates, pending, error };
}

/**
 * « Ajouter un ticket carburant » (CDC 10.3, 8.2, D-226, D-267) : déclaration d'un plein par le conducteur
 * depuis son téléphone (photo du ticket obligatoire, prise avec l'appareil). La soumission reste à valider
 * par le gestionnaire du parc : ni dépense ni relevé accepté avant validation. Envoi idempotent ; hors
 * connexion, rien n'est prétendu enregistré.
 */
export function FuelTicket({ driverId }: { driverId: string }) {
  const session = useSession();
  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  if (!session.isDriverOnly) {
    return (
      <section aria-labelledby="fuel-ticket-title" className="space-y-2">
        <h2 id="fuel-ticket-title" className="text-lg font-semibold">
          Ajouter un ticket carburant
        </h2>
        <p className="text-sm text-muted-foreground">
          La déclaration mobile est réservée aux comptes conducteur. Le personnel enregistre un plein depuis la page{' '}
          <Link href="/carburant/nouveau" className="underline underline-offset-4">
            Saisir un plein
          </Link>
          .
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="fuel-ticket-title" className="space-y-2">
      <h2 id="fuel-ticket-title" className="sr-only">
        Ajouter un ticket carburant
      </h2>
      {formOpen ? (
        <FuelTicketForm key={formKey} driverId={driverId} onClose={() => setFormOpen(false)} />
      ) : (
        <FuelTicketButton
          driverId={driverId}
          onOpen={() => {
            setFormKey((k) => k + 1);
            setFormOpen(true);
          }}
        />
      )}
    </section>
  );
}

function FuelTicketButton({ driverId, onOpen }: { driverId: string; onOpen: () => void }) {
  const { candidates, pending, error } = useCandidates(driverId);
  const unavailable = !pending && candidates.length === 0;
  return (
    <>
      <Button size="lg" variant="outline" className="h-14 w-full text-base" disabled={pending || candidates.length === 0} aria-describedby={unavailable ? 'fuel-ticket-unavailable' : undefined} onClick={onOpen}>
        <Fuel className="size-5" aria-hidden="true" /> Ajouter un ticket carburant
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(error) ? error.message : 'Véhicules disponibles indisponibles.'}
        </p>
      ) : unavailable ? (
        <p id="fuel-ticket-unavailable" className="text-sm text-muted-foreground">
          Aucun véhicule ne vous est attribué pour déclarer un plein : un ticket se déclare pendant une utilisation, ou juste après la restitution.
        </p>
      ) : null}
    </>
  );
}

function FuelTicketForm({ driverId, onClose }: { driverId: string; onClose: () => void }) {
  const session = useSession();
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const money = useMoney();
  const { candidates, pending } = useCandidates(driverId);
  const [initial] = useState(() => {
    const saved = readDraft();
    return { draft: saved ?? freshDraft(session.timezone, ''), restored: saved !== null };
  });
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [restored, setRestored] = useState(initial.restored);
  const [local, setLocal] = useState<FieldErrors>({});
  const [result, setResult] = useState<FuelEntryView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const litersInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  // Véhicule retenu : celui du brouillon s'il est toujours proposé par l'API, sinon le premier proposé.
  const candidate = candidates.find((c) => c.vehicleId === draft.vehicleId) ?? candidates[0] ?? null;

  useEffect(() => {
    if (!result) writeDraft(draft);
  }, [draft, result]);

  useEffect(() => {
    if (result) resultHeading.current?.focus();
    else litersInput.current?.focus();
  }, [result]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!candidate) throw new Error('Choisissez d’abord le véhicule.');
      const prepared = await prepareCameraPhoto(file);
      const form = new FormData();
      form.append('file', prepared);
      form.append('companyId', candidate.companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (att) => update({ ticket: { id: att.id, name: att.originalName } }),
  });

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>('/fuel-entries', { method: 'POST', body, idempotencyKey: draft.idempotencyKey }),
    onSuccess: (created) => {
      clearDraft();
      setResult(created);
      void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      toast.success('Ticket envoyé : en attente de validation.');
    },
    onError: (error) => {
      toast.error(isApiError(error) && error.status === 0 ? 'Non enregistré : vérifiez votre connexion puis réessayez.' : isApiError(error) ? error.message : 'Non enregistré, réessayez.');
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
    },
  });

  function restart() {
    submit.reset();
    upload.reset();
    setLocal({});
    setRestored(false);
    setResult(null);
    setDraft(freshDraft(session.timezone, candidate?.vehicleId ?? ''));
  }

  function cancel() {
    clearDraft();
    onClose();
  }

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h3 ref={resultHeading} tabIndex={-1} className="outline-none">
              Ticket envoyé
            </h3>
          </CardTitle>
          <CardDescription>Réponse du serveur reçue : votre déclaration est enregistrée.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div role="status" className="space-y-2 rounded-md border p-3">
            <p className="text-base font-semibold">
              {result.vehicleCode} · {formatFuelLiters(result.liters)}
              {result.totalAmount !== null ? ` · ${money(result.totalAmount)}` : ''}
            </p>
            <p className="text-muted-foreground">Plein du {formatDateTime(result.filledAt, session.timezone)}</p>
            <FuelStatusBadge status={result.status} />
            {result.status === 'SOUMIS' ? <p>Le gestionnaire du parc doit la valider. Suivez son statut dans « Mes déclarations de plein ».</p> : null}
            {result.amountMismatch ? <p className="text-muted-foreground">Un écart entre litres × prix unitaire et montant total est signalé : le gestionnaire le vérifiera.</p> : null}
            {result.tankCapacityExceeded ? <p className="text-muted-foreground">Les litres dépassent la capacité du réservoir enregistrée : le gestionnaire le vérifiera.</p> : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" className="h-11" onClick={restart}>
              Déclarer un autre plein
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              Fermer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const errors = { ...errorsOf(submit.error), ...local };
  const busy = submit.isPending || upload.isPending;
  const bodyMismatch = isApiError(submit.error) && submit.error.code === 'IDEMPOTENCE_CORPS_DIFFERENT';
  const uploadError = upload.error instanceof PhotoPreparationError ? upload.error.message : isApiError(upload.error) ? upload.error.message : upload.error ? 'Téléversement impossible : la photo n’est pas jointe.' : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    const filledIso = localInputToIso(draft.filledAt, session.timezone);
    const liters = normalizeDecimal(draft.liters);
    const total = normalizeDecimal(draft.totalAmount);
    const unitPrice = normalizeDecimal(draft.unitPrice);
    const km = normalizeDecimal(draft.odometerKm);
    if (!candidate) next.vehicleId = ['Aucun véhicule disponible pour cette déclaration.'];
    if (!filledIso) next.filledAt = ['Indiquez la date et l’heure du plein.'];
    if (!liters) next.liters = ['Indiquez les litres.'];
    else if (!isDecimal3(liters)) next.liters = ['Nombre positif attendu, par exemple 35,5.'];
    if (!total) next.totalAmount = ['Indiquez le montant payé.'];
    else if (!isDecimal3(total)) next.totalAmount = ['Montant positif attendu, par exemple 89,640.'];
    if (unitPrice && !isDecimal3(unitPrice)) next.unitPrice = ['Prix positif attendu, par exemple 2,525.'];
    if (km && !isDecimal3(km)) next.odometerKm = ['Nombre positif attendu, par exemple 45230.'];
    if (draft.isFullTank === null) next.isFullTank = ['Indiquez si le plein est complet ou partiel.'];
    if (!draft.ticket) next.ticketAttachmentId = ['Prenez le ticket en photo.'];
    setLocal(next);
    if (Object.keys(next).length > 0 || !candidate || !filledIso || draft.isFullTank === null || !online) return;
    submit.mutate({
      vehicleId: candidate.vehicleId,
      filledAt: filledIso,
      liters,
      totalAmount: total,
      unitPrice: unitPrice || undefined,
      odometerKm: km || undefined,
      isFullTank: draft.isFullTank,
      ticketAttachmentId: draft.ticket?.id,
      notes: draft.notes.trim() || undefined,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h3>Déclarer un plein</h3>
        </CardTitle>
        <CardDescription>Votre ticket sera soumis à la validation du gestionnaire du parc.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" noValidate onSubmit={onSubmit}>
          {restored ? (
            <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              Brouillon non envoyé restauré : vérifiez les valeurs puis envoyez. Rien n’a été enregistré tant que la confirmation n’apparaît pas.
            </p>
          ) : null}

          {pending ? (
            <LoadingState label="Chargement de vos véhicules…" />
          ) : candidates.length > 1 ? (
            <div className="space-y-2">
              <p id="fuel-ticket-vehicle-label" className="text-sm leading-none font-medium">
                Véhicule *
              </p>
              <RadioGroup aria-labelledby="fuel-ticket-vehicle-label" value={candidate?.vehicleId ?? ''} onValueChange={(v) => update({ vehicleId: v })} className="gap-2">
                {candidates.map((c) => (
                  <div key={c.vehicleId} className="flex items-center gap-3 rounded-md border p-3">
                    <RadioGroupItem id={`fuel-ticket-vehicle-${c.vehicleId}`} value={c.vehicleId} />
                    <Label htmlFor={`fuel-ticket-vehicle-${c.vehicleId}`} className="font-normal">
                      <span className="font-medium">{c.label}</span>
                      <span className="block text-xs text-muted-foreground">{c.detail}</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <FieldError errors={errors} name="vehicleId" />
            </div>
          ) : candidate ? (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{candidate.label}</p>
              <p className="text-xs text-muted-foreground">{candidate.detail}</p>
              <FieldError errors={errors} name="vehicleId" />
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              Aucun véhicule ne vous est attribué pour déclarer un plein.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="fuel-ticket-filled-at">Date et heure du plein *</Label>
            <Input id="fuel-ticket-filled-at" type="datetime-local" className="h-12" value={draft.filledAt} onChange={(e) => update({ filledAt: e.target.value })} aria-invalid={invalid(errors, 'filledAt')} aria-describedby={describedBy(errors, 'filledAt', 'fuel-ticket-filled-at-hint')} />
            <p id="fuel-ticket-filled-at-hint" className="text-xs text-muted-foreground">
              Par défaut, maintenant : indiquez l’heure du ticket. Une date future est refusée.
            </p>
            <FieldError errors={errors} name="filledAt" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="fuel-ticket-liters">Litres *</Label>
              <Input ref={litersInput} id="fuel-ticket-liters" inputMode="decimal" autoComplete="off" className="h-12 text-lg" value={draft.liters} onChange={(e) => update({ liters: e.target.value })} aria-invalid={invalid(errors, 'liters')} aria-describedby={describedBy(errors, 'liters')} />
              <FieldError errors={errors} name="liters" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fuel-ticket-total">Montant payé ({session.currency}) *</Label>
              <Input id="fuel-ticket-total" inputMode="decimal" autoComplete="off" className="h-12 text-lg" value={draft.totalAmount} onChange={(e) => update({ totalAmount: e.target.value })} aria-invalid={invalid(errors, 'totalAmount')} aria-describedby={describedBy(errors, 'totalAmount')} />
              <FieldError errors={errors} name="totalAmount" />
            </div>
          </div>

          <FullTankField idPrefix="fuel-ticket-full" value={draft.isFullTank} onChange={(v) => update({ isFullTank: v })} errors={errors} large />

          <div className="space-y-2">
            <Label htmlFor="fuel-ticket-km">Kilométrage au compteur</Label>
            <Input id="fuel-ticket-km" inputMode="decimal" autoComplete="off" className="h-12" value={draft.odometerKm} onChange={(e) => update({ odometerKm: e.target.value })} aria-invalid={invalid(errors, 'odometerKm')} aria-describedby={describedBy(errors, 'odometerKm', 'fuel-ticket-km-hint')} />
            <p id="fuel-ticket-km-hint" className="text-xs text-muted-foreground">
              Recommandé : sans compteur, ce plein ne pourra pas servir au calcul de consommation.
            </p>
            <FieldError errors={errors} name="odometerKm" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="fuel-ticket-unit-price">Prix au litre ({session.currency})</Label>
            <Input id="fuel-ticket-unit-price" inputMode="decimal" autoComplete="off" className="h-12" value={draft.unitPrice} onChange={(e) => update({ unitPrice: e.target.value })} aria-invalid={invalid(errors, 'unitPrice')} aria-describedby={describedBy(errors, 'unitPrice', 'fuel-ticket-unit-price-hint')} />
            <p id="fuel-ticket-unit-price-hint" className="text-xs text-muted-foreground">
              Facultatif, tel qu’imprimé sur le ticket.
            </p>
            <FieldError errors={errors} name="unitPrice" />
          </div>

          <div className="space-y-2">
            <Label id="fuel-ticket-photo-label" htmlFor="fuel-ticket-photo">
              Photo du ticket *
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
            {draft.ticket ? (
              <div className="flex flex-wrap items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/v1/attachments/${draft.ticket.id}/download`} alt="Photo du ticket jointe" className="h-20 w-28 rounded-md border object-cover" />
                <Button id="fuel-ticket-photo" type="button" variant="outline" onClick={() => update({ ticket: null })} aria-labelledby="fuel-ticket-photo-label fuel-ticket-photo" aria-describedby={describedBy(errors, 'ticketAttachmentId', 'fuel-ticket-photo-hint')}>
                  Retirer la photo
                </Button>
              </div>
            ) : (
              <Button
                id="fuel-ticket-photo"
                type="button"
                variant="outline"
                className="h-12 w-full"
                disabled={upload.isPending || !candidate}
                onClick={() => fileInput.current?.click()}
                aria-labelledby="fuel-ticket-photo-label fuel-ticket-photo"
                aria-invalid={invalid(errors, 'ticketAttachmentId')}
                aria-describedby={describedBy(errors, 'ticketAttachmentId', 'fuel-ticket-photo-hint')}
              >
                <Camera className="size-4" aria-hidden="true" />
                {upload.isPending ? 'Envoi de la photo…' : 'Prendre le ticket en photo'}
              </Button>
            )}
            <p id="fuel-ticket-photo-hint" className="text-xs text-muted-foreground">
              Obligatoire. La photo est réduite en JPEG avant l’envoi.
            </p>
            {uploadError ? (
              <p role="alert" className="text-sm text-destructive">
                {uploadError}
              </p>
            ) : null}
            <FieldError errors={errors} name="ticketAttachmentId" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="fuel-ticket-notes">Commentaire (facultatif)</Label>
            <Textarea id="fuel-ticket-notes" maxLength={2000} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
            <FieldError errors={errors} name="notes" />
          </div>

          {!online ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Hors connexion : le ticket ne peut pas être envoyé et rien n’est enregistré. Votre saisie reste sur cet appareil ; envoyez-la quand la connexion revient.
            </p>
          ) : null}

          {submit.error ? (
            <ApiErrorAlert error={submit.error}>
              {isApiError(submit.error) && (submit.error.status === 0 || submit.error.status >= 500) ? <p className="mt-1 text-muted-foreground">Votre saisie est conservée. Le nouvel envoi réutilise la même clé : aucun doublon ne sera créé.</p> : null}
              {bodyMismatch ? (
                <div className="mt-2 space-y-2">
                  <p className="text-muted-foreground">Ce formulaire a déjà servi à envoyer un ticket : vérifiez « Mes déclarations de plein » avant de recommencer.</p>
                  <Button type="button" variant="outline" size="sm" onClick={restart}>
                    Recommencer une nouvelle déclaration
                  </Button>
                </div>
              ) : null}
            </ApiErrorAlert>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" className="h-12 text-base" disabled={busy || !online || !candidate}>
              {submit.isPending ? 'Envoi…' : 'Envoyer le ticket'}
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

/**
 * « Mes déclarations de plein » (CDC 2.3, 10.3, D-226) : tickets soumis par le conducteur (GET /fuel-entries,
 * restreint par l'API à ses propres soumissions), statut, motif de rejet, ticket et retrait tant que la
 * déclaration est en attente. Aucune dépense ni facture n'est exposée.
 */
export function MyFuelDeclarations() {
  const session = useSession();
  const queryClient = useQueryClient();
  const money = useMoney();
  const [page, setPage] = useState(1);
  const [toWithdraw, setToWithdraw] = useState<FuelEntryView | null>(null);
  const query = toQuery({ page, pageSize: 10 });
  const entries = useQuery({ queryKey: ['fuel-entries', 'mes-declarations', query], queryFn: () => api<Page<FuelEntryView>>(`/fuel-entries${query}`), enabled: session.isDriverOnly });
  const withdraw = useMutation({
    mutationFn: (entry: FuelEntryView) => api<FuelEntryView>(`/fuel-entries/${entry.id}/cancel`, { method: 'POST', body: { expectedVersion: entry.version } }),
    onSuccess: () => {
      toast.success('Déclaration retirée.');
      setToWithdraw(null);
      void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Retrait impossible.');
      setToWithdraw(null);
      void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
    },
  });

  if (!session.isDriverOnly) return null;

  return (
    <section aria-labelledby="fuel-declarations-title" className="space-y-3">
      <div>
        <h2 id="fuel-declarations-title" className="text-lg font-semibold">
          Mes déclarations de plein
        </h2>
        <p className="text-sm text-muted-foreground">Statut de chaque ticket : en attente de validation, validé ou rejeté avec son motif.</p>
      </div>
      {entries.isPending ? (
        <LoadingState label="Chargement des déclarations…" />
      ) : entries.isError ? (
        <ErrorState error={entries.error} retry={() => void entries.refetch()} />
      ) : entries.data.total === 0 ? (
        <EmptyState title="Aucune déclaration de plein" description="Les tickets carburant que vous envoyez apparaîtront ici avec leur statut." />
      ) : (
        <div>
          <ul className="space-y-2">
            {entries.data.items.map((e) => (
              <li key={e.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold">
                      {formatFuelLiters(e.liters)}
                      {e.totalAmount !== null ? ` · ${money(e.totalAmount)}` : ''}
                    </p>
                    <p className="text-muted-foreground">
                      {e.vehicleCode} · plein du {formatDateTime(e.filledAt, session.timezone)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {e.isFullTank ? 'Plein complet' : 'Plein partiel'}
                      {e.declaredPhysicalKm ? ` · compteur ${formatKm(e.declaredPhysicalKm)}` : ''}
                    </p>
                  </div>
                  <FuelStatusBadge status={e.status} />
                </div>
                {e.status === 'SOUMIS' ? <p className="mt-2">En attente de validation par le gestionnaire du parc.</p> : null}
                {e.status === 'VALIDE' ? <p className="mt-2">Validé{e.decidedAt ? ` le ${formatDateTime(e.decidedAt, session.timezone)}` : ''}.</p> : null}
                {e.status === 'REJETE' ? (
                  <div className="mt-2 space-y-0.5">
                    <p className="text-destructive">Refusé{e.decidedAt ? ` le ${formatDateTime(e.decidedAt, session.timezone)}` : ''}.</p>
                    <p>
                      <span className="text-muted-foreground">Motif du rejet : </span>
                      {e.decisionReason ?? 'non communiqué'}
                    </p>
                  </div>
                ) : null}
                {e.status === 'ANNULE' ? <p className="mt-2 text-muted-foreground">Déclaration retirée ou annulée{e.decisionReason ? ` : ${e.decisionReason}` : ''}.</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {e.ticketAttachmentId ? <AttachmentLink id={e.ticketAttachmentId} label="Voir le ticket" /> : null}
                  {e.status === 'SOUMIS' ? (
                    <Button type="button" variant="ghost" size="sm" className="h-10" disabled={withdraw.isPending} onClick={() => setToWithdraw(e)}>
                      Retirer la déclaration
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <PaginationControls page={entries.data.page} pageSize={entries.data.pageSize} total={entries.data.total} onPageChange={setPage} />
        </div>
      )}
      <AlertDialog open={toWithdraw !== null} onOpenChange={(open) => !open && !withdraw.isPending && setToWithdraw(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retirer cette déclaration de plein ?</AlertDialogTitle>
            <AlertDialogDescription>
              {toWithdraw ? `${toWithdraw.vehicleCode} · ${formatFuelLiters(toWithdraw.liters)} · plein du ${formatDateTime(toWithdraw.filledAt, session.timezone)}. ` : ''}
              Elle ne sera pas validée ; vous pourrez en envoyer une nouvelle.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>Garder</AlertDialogCancel>
            <AlertDialogAction
              disabled={withdraw.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (toWithdraw) withdraw.mutate(toWithdraw);
              }}
            >
              {withdraw.isPending ? 'Retrait…' : 'Retirer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
