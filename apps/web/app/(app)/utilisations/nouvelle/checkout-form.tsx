'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { RESERVATION_STATUS_LABELS } from '@parc-auto/contracts';
import { OverrideLegalNotice } from '@/components/documents/override-notice';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { StatusBadge } from '@/components/status-badge';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { AssignmentView } from '@/lib/assignments-types';
import type { DriverView } from '@/lib/drivers-types';
import { formatDateTime, formatKm, fullName } from '@/lib/format';
import type { ReservationView } from '@/lib/reservations-types';
import type { CheckoutPreview, UsageDetailView } from '@/lib/usages-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { DriverPicker, VehiclePicker } from '../entity-pickers';
import { isoToLocalInput, localInputToIso, locationInputErrors, normalizeKmInput, nowLocalInput, readingInputErrors, useCanIn } from '../usage-helpers';
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

type FieldErrors = Record<string, string[]>;
const NO_RESERVATION = '__aucune__';

/** Champ à focaliser pour la première erreur de saisie détectée avant l'envoi. */
const FIELD_IDS: Record<string, string> = {
  vehicleId: 'checkout-vehicle',
  driverId: 'checkout-driver',
  checkedOutAt: 'checkedOutAt',
  expectedReturnAt: 'expectedReturnAt',
  purpose: 'purpose',
  'reading.physicalKm': 'REMISE-km',
  'readingException.reason': 'REMISE-exception-reason',
  'location.siteId': 'checkout-site',
  'location.placeLabel': 'checkout-place',
};

interface Props {
  initialVehicle: VehicleView | null;
  initialDriver: DriverView | null;
  initialReservation: ReservationView | null;
}

export function CheckoutForm({ initialVehicle, initialDriver, initialReservation }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, companyId: scopeCompanyId } = useAppScope();
  // Une clé par ouverture du formulaire : un nouvel essai du même envoi est rejoué sans doublon.
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const convertible = initialReservation?.status === 'CONFIRMEE' ? initialReservation : null;

  const [vehicle, setVehicle] = useState<VehicleView | null>(initialVehicle);
  const [driver, setDriver] = useState<DriverView | null>(initialDriver);
  const [reservationId, setReservationId] = useState(convertible?.id ?? NO_RESERVATION);
  const [checkedOutAt, setCheckedOutAt] = useState(() => nowLocalInput(session.timezone));
  const [expectedReturnAt, setExpectedReturnAt] = useState(() => isoToLocalInput(convertible?.endAt, session.timezone));
  const [purpose, setPurpose] = useState(convertible?.purpose ?? '');
  const [readingMode, setReadingMode] = useState<ReadingMode>('releve');
  const [km, setKm] = useState('');
  const [kmPhoto, setKmPhoto] = useState<UploadedPhoto | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [locationMode, setLocationMode] = useState<LocationMode>('site');
  const [siteId, setSiteId] = useState('');
  const [placeLabel, setPlaceLabel] = useState('');
  const [gauge, setGauge] = useState(NO_GAUGE);
  const [checklist, setChecklist] = useState<ChecklistState>({});
  const [notes, setNotes] = useState('');
  const [confirmedByName, setConfirmedByName] = useState('');
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const vehicleCompanyId = vehicle?.companyId ?? null;
  const canOverride = useCanIn(vehicleCompanyId, 'exceptions.override');
  const withReading = readingMode === 'releve' || !canOverride;
  const checklistItems = useChecklistItems(vehicleCompanyId);

  const atIso = localInputToIso(checkedOutAt, session.timezone);
  const expectedIso = localInputToIso(expectedReturnAt, session.timezone);
  const previewKey = ['usages', 'checkout-preview', vehicle?.id ?? null, driver?.id ?? null, atIso ?? null, expectedIso ?? null] as const;
  const fetchPreview = () => api<CheckoutPreview>(`/usages/checkout-preview${toQuery({ vehicleId: vehicle?.id, driverId: driver?.id, at: atIso, expectedReturnAt: expectedIso })}`);
  const preview = useQuery({ queryKey: previewKey, queryFn: fetchPreview, enabled: Boolean(vehicle && driver) });
  const softBlockers = preview.data?.blockers.filter((b) => b.overridable) ?? [];

  const reservations = useQuery({
    queryKey: ['reservations', 'convertible', vehicle?.id ?? null, driver?.id ?? null],
    queryFn: () => api<Page<ReservationView>>(`/reservations${toQuery({ vehicleId: vehicle?.id, driverId: driver?.id, status: 'CONFIRMEE', pageSize: 20 })}`),
    enabled: Boolean(vehicle && driver),
  });
  // La réservation demandée par l'URL reste proposée même si elle n'est pas dans la première page de résultats.
  const fetchedReservations = reservations.data?.items ?? [];
  const reservationOptions = convertible && vehicle?.id === convertible.vehicleId && driver?.id === convertible.driverId && !fetchedReservations.some((r) => r.id === convertible.id) ? [convertible, ...fetchedReservations] : fetchedReservations;

  // D-135 : l'interface propose la fin de l'affectation habituelle comme retour prévu (période calculée par l'API).
  const assignments = useQuery({
    queryKey: ['responsible-assignments', 'checkout', vehicle?.id ?? null, driver?.id ?? null],
    queryFn: () => api<AssignmentView[]>(`/responsible-assignments${toQuery({ vehicleId: vehicle?.id, driverId: driver?.id })}`),
    enabled: Boolean(vehicle && driver),
  });
  const currentAssignment = assignments.data?.find((a) => a.isCurrent) ?? null;
  const selectedReservation = reservationOptions.find((r) => r.id === reservationId) ?? null;

  const changeVehicle = (next: VehicleView | null) => {
    if (next?.companyId !== vehicle?.companyId) {
      // Sites, checklist et pièces jointes dépendent de la société du véhicule.
      setSiteId('');
      setChecklist({});
      setPhotos([]);
      setKmPhoto(null);
    }
    setVehicle(next);
    setReservationId(NO_RESERVATION);
    setKm('');
  };
  const changeDriver = (next: DriverView | null) => {
    setDriver(next);
    setReservationId(NO_RESERVATION);
  };
  const changeReservation = (id: string) => {
    setReservationId(id);
    const r = reservationOptions.find((x) => x.id === id);
    if (r && !expectedReturnAt) setExpectedReturnAt(isoToLocalInput(r.endAt, session.timezone));
    if (r && !purpose.trim()) setPurpose(r.purpose);
  };

  const buildBody = () => ({
    vehicleId: vehicle?.id,
    driverId: driver?.id,
    checkedOutAt: atIso,
    expectedReturnAt: expectedIso,
    purpose: purpose.trim(),
    reservationId: reservationId !== NO_RESERVATION ? reservationId : undefined,
    reading: withReading && km.trim() ? { physicalKm: normalizeKmInput(km), ...(kmPhoto ? { attachmentId: kmPhoto.id } : {}) } : undefined,
    readingException: !withReading ? { reason: exceptionReason.trim() } : undefined,
    overrideReason: softBlockers.length > 0 && overrideReason.trim() ? overrideReason.trim() : undefined,
    location: locationPayload(locationMode, siteId, placeLabel),
    fuelGauge: gaugePayload(gauge),
    checklist: checklistPayload(checklistItems.data, checklist),
    notes: notes.trim() || undefined,
    confirmedByName: confirmedByName.trim() || undefined,
    photoAttachmentIds: photos.length ? photos.map((p) => p.id) : undefined,
  });

  const checkout = useMutation({
    mutationFn: () => api<UsageDetailView>('/usages/checkout', { method: 'POST', body: buildBody(), idempotencyKey }),
    onSuccess: (usage) => {
      setConfirmOpen(false);
      toast.success(`Remise enregistrée : ${usage.vehicleCode} remis à ${usage.driverName}.`);
      queryClient.setQueryData(['usage', usage.id], usage);
      void queryClient.invalidateQueries({ queryKey: ['usages'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', usage.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['driver', usage.driverId] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['reservation'] });
      void queryClient.invalidateQueries({ queryKey: ['planning'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
      router.push(`/utilisations/${usage.id}`);
    },
    onError: (error) => {
      setConfirmOpen(false);
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Les blocages ont pu changer entre-temps : on relit les contrôles préalables.
        if (error.status === 409 || error.status === 422) void queryClient.invalidateQueries({ queryKey: ['usages', 'checkout-preview'] });
      } else toast.error('Enregistrement impossible.');
    },
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setSubmitError(null);
    setPreviewProblem(null);
    // Contrôles de présence uniquement : les règles métier sont vérifiées par l'API.
    // L'ordre des clés suit l'ordre visuel du formulaire (focalisation de la première erreur).
    const local: FieldErrors = {};
    if (!vehicle) local.vehicleId = ['Choisissez le véhicule.'];
    if (!driver) local.driverId = ['Choisissez le conducteur.'];
    if (!atIso) local.checkedOutAt = ['Indiquez la date et l’heure de la remise.'];
    if (!expectedIso) local.expectedReturnAt = ['Indiquez le retour prévu.'];
    if (!purpose.trim()) local.purpose = ['Indiquez le motif de l’utilisation.'];
    Object.assign(local, readingInputErrors(withReading, km, exceptionReason), locationInputErrors(locationMode, siteId, placeLabel));
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      document.getElementById(FIELD_IDS[Object.keys(local)[0] as string] ?? '')?.focus();
      return;
    }
    // Contrôles préalables relus juste avant l'envoi (blocages, réservations en conflit).
    setChecking(true);
    let fresh: CheckoutPreview;
    try {
      fresh = await queryClient.fetchQuery({ queryKey: previewKey, queryFn: fetchPreview, staleTime: 0 });
    } catch (error) {
      setSubmitError(error);
      return;
    } finally {
      setChecking(false);
    }
    const hard = fresh.blockers.filter((b) => !b.overridable);
    const soft = fresh.blockers.filter((b) => b.overridable);
    if (hard.length > 0 || fresh.conflictingReservations.length > 0) {
      setPreviewProblem('La remise est impossible en l’état : consultez les contrôles avant remise.');
      previewRef.current?.focus();
      return;
    }
    if (soft.length > 0 && !overrideReason.trim()) {
      if (canOverride) {
        setFieldErrors({ overrideReason: ['Motif de dérogation obligatoire pour lever ces blocages.'] });
        setPreviewProblem('Une dérogation motivée est nécessaire : saisissez son motif dans les contrôles avant remise.');
      } else {
        setPreviewProblem('Une dérogation motivée par une personne habilitée (chef de parc ou administrateur) est nécessaire pour cette remise.');
      }
      previewRef.current?.focus();
      return;
    }
    setConfirmOpen(true);
  }

  const busy = checking || checkout.isPending;

  return (
    <form className="space-y-4" noValidate onSubmit={onSubmit} aria-describedby="checkout-intro">
      <p id="checkout-intro" className="text-sm text-muted-foreground">
        Les champs marqués * sont obligatoires. Le relevé du compteur doit être accepté par le serveur pour valider le départ.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h2>Véhicule et conducteur</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="checkout-vehicle">Véhicule disponible *</Label>
            <VehiclePicker
              id="checkout-vehicle"
              companyId={scopeCompanyId}
              operationalStatus="DISPONIBLE"
              value={vehicle}
              onChange={changeVehicle}
              invalid={Boolean(fieldErrors.vehicleId?.length)}
              describedBy={fieldErrors.vehicleId?.length ? 'vehicleId-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="vehicleId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="checkout-driver">Conducteur actif *</Label>
            <DriverPicker
              id="checkout-driver"
              companyId={vehicleCompanyId ?? scopeCompanyId}
              status="ACTIF"
              value={driver}
              onChange={changeDriver}
              invalid={Boolean(fieldErrors.driverId?.length)}
              describedBy={fieldErrors.driverId?.length ? 'driverId-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="driverId" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="checkout-reservation">Réservation à convertir</Label>
            <Select value={reservationId} onValueChange={changeReservation} disabled={!vehicle || !driver}>
              <SelectTrigger id="checkout-reservation" className="w-full" aria-describedby="checkout-reservation-hint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_RESERVATION}>Aucune (remise sans réservation)</SelectItem>
                {reservationOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    Du {formatDateTime(r.startAt, session.timezone)} au {formatDateTime(r.endAt, session.timezone)} · {r.purpose}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="checkout-reservation-hint" className="text-xs text-muted-foreground">
              {!vehicle || !driver
                ? 'Choisissez le véhicule et le conducteur pour afficher leurs réservations confirmées.'
                : reservations.isPending
                  ? 'Recherche des réservations confirmées…'
                  : reservations.isError
                    ? `Réservations indisponibles : ${isApiError(reservations.error) ? reservations.error.message : 'erreur inconnue'}`
                    : reservationOptions.length === 0
                      ? 'Aucune réservation confirmée pour ce véhicule et ce conducteur.'
                      : 'La réservation choisie passera au statut « Convertie ».'}
            </p>
            {initialReservation && initialReservation.status !== 'CONFIRMEE' ? (
              <p role="alert" className="text-sm text-warning-foreground">
                La réservation demandée est « {RESERVATION_STATUS_LABELS[initialReservation.status] ?? initialReservation.status} » : elle ne peut pas être convertie.
              </p>
            ) : null}
            <FieldError errors={fieldErrors} name="reservationId" />
          </div>
        </CardContent>
      </Card>

      {vehicle && driver ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Contrôles avant remise</h2>
            </CardTitle>
            <CardDescription>Blocages calculés par le serveur ; ils sont vérifiés de nouveau à l’enregistrement.</CardDescription>
          </CardHeader>
          <CardContent>
            <div ref={previewRef} tabIndex={-1} className="space-y-3 outline-none" aria-live="polite">
              {preview.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Vérification des blocages…
                </p>
              ) : preview.isError ? (
                <ApiErrorAlert error={preview.error} title="Contrôles préalables indisponibles" />
              ) : (
                <>
                  {preview.data.blockers.length === 0 && preview.data.conflictingReservations.length === 0 ? (
                    <StatusBadge label="Aucun blocage détecté" tone="success" />
                  ) : null}
                  {preview.data.blockers.length > 0 ? (
                    <ul className="space-y-2">
                      {preview.data.blockers.map((b) => (
                        <li key={`${b.code}-${b.message}`} className="flex flex-col gap-1 rounded-md border p-3 text-sm sm:flex-row sm:items-start sm:gap-3">
                          <StatusBadge label={b.overridable ? 'Dérogation possible' : 'Bloquant'} tone={b.overridable ? 'warning' : 'danger'} className="shrink-0" />
                          <span>{b.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {preview.data.conflictingReservations.length > 0 ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      <p className="font-medium">Réservations confirmées en conflit sur la période :</p>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {preview.data.conflictingReservations.map((r) => (
                          <li key={r.id}>
                            {r.driverName} : du {formatDateTime(r.startAt, session.timezone)} au {formatDateTime(r.endAt, session.timezone)}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-muted-foreground">Ajustez le retour prévu ou faites modifier la réservation concernée.</p>
                    </div>
                  ) : null}
                  {preview.data.lastReading ? (
                    <p className="text-sm text-muted-foreground">
                      Dernier relevé accepté : {formatKm(preview.data.lastReading.physicalKm)} le {formatDateTime(preview.data.lastReading.observedAt, session.timezone)}.
                    </p>
                  ) : null}
                  {softBlockers.length > 0 ? (
                    canOverride ? (
                      <div className="space-y-2">
                        <Label htmlFor="overrideReason">Motif de la dérogation * (5 caractères minimum)</Label>
                        <Textarea
                          id="overrideReason"
                          value={overrideReason}
                          maxLength={500}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          aria-invalid={Boolean(fieldErrors.overrideReason?.length) || undefined}
                          aria-describedby={['overrideReason-hint', 'overrideReason-legal', fieldErrors.overrideReason?.length ? 'overrideReason-error' : ''].filter(Boolean).join(' ')}
                        />
                        <p id="overrideReason-hint" className="text-xs text-muted-foreground">
                          La dérogation lève uniquement les blocages marqués « Dérogation possible ». Elle est enregistrée et auditée avec votre nom.
                        </p>
                        <OverrideLegalNotice id="overrideReason-legal" />
                        <FieldError errors={fieldErrors} name="overrideReason" />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-sm text-warning-foreground">Ces blocages ne peuvent être levés que par une dérogation motivée d’un chef de parc ou d’un administrateur.</p>
                        <OverrideLegalNotice />
                      </div>
                    )
                  ) : null}
                </>
              )}
              {previewProblem ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {previewProblem}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h2>Remise</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="checkedOutAt">Date et heure réelles de la remise *</Label>
            <Input
              id="checkedOutAt"
              type="datetime-local"
              value={checkedOutAt}
              onChange={(e) => setCheckedOutAt(e.target.value)}
              aria-invalid={Boolean(fieldErrors.checkedOutAt?.length) || undefined}
              aria-describedby={fieldErrors.checkedOutAt?.length ? 'checkedOutAt-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="checkedOutAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="expectedReturnAt">Retour prévu *</Label>
            <Input
              id="expectedReturnAt"
              type="datetime-local"
              value={expectedReturnAt}
              min={checkedOutAt || undefined}
              onChange={(e) => setExpectedReturnAt(e.target.value)}
              aria-invalid={Boolean(fieldErrors.expectedReturnAt?.length) || undefined}
              aria-describedby={[currentAssignment ? 'expectedReturnAt-hint' : '', fieldErrors.expectedReturnAt?.length ? 'expectedReturnAt-error' : ''].filter(Boolean).join(' ') || undefined}
            />
            {currentAssignment ? (
              <div id="expectedReturnAt-hint" className="space-y-1 text-xs text-muted-foreground">
                {currentAssignment.endsAt ? (
                  <>
                    <p>
                      {currentAssignment.driverName} est responsable habituel de ce véhicule jusqu’au {formatDateTime(currentAssignment.endsAt, session.timezone)}.
                    </p>
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setExpectedReturnAt(isoToLocalInput(currentAssignment.endsAt, session.timezone))}>
                      Utiliser la fin de l’affectation habituelle
                    </Button>
                  </>
                ) : (
                  <p>{currentAssignment.driverName} est responsable habituel de ce véhicule, sans fin d’affectation : choisissez une date de retour prévu, prolongeable ensuite avec motif.</p>
                )}
              </div>
            ) : null}
            <FieldError errors={fieldErrors} name="expectedReturnAt" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="purpose">Motif *</Label>
            <Input
              id="purpose"
              value={purpose}
              maxLength={300}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Ex. mission client, tournée commerciale"
              aria-invalid={Boolean(fieldErrors.purpose?.length) || undefined}
              aria-describedby={fieldErrors.purpose?.length ? 'purpose-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="purpose" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <ReadingField
            context="REMISE"
            vehicleId={vehicle?.id ?? null}
            companyId={vehicleCompanyId}
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
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-6 pt-6 md:grid-cols-2">
          <LocationField
            idPrefix="checkout"
            legend="Lieu de remise"
            companyId={vehicleCompanyId}
            mode={locationMode}
            onModeChange={setLocationMode}
            siteId={siteId}
            onSiteChange={setSiteId}
            placeLabel={placeLabel}
            onPlaceChange={setPlaceLabel}
            errors={fieldErrors}
          />
          <FuelGaugeField id="checkout-fuel" label="Niveau de carburant approximatif" value={gauge} onChange={setGauge} errors={fieldErrors} />
          <div className="md:col-span-2">
            <ChecklistField idPrefix="checkout" legend="Clés, documents et accessoires remis" companyId={vehicleCompanyId} state={checklist} onChange={setChecklist} errors={fieldErrors} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-2">
            <Label htmlFor="notes">Observations (réserves à la remise)</Label>
            <Textarea id="notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} aria-describedby={fieldErrors.notes?.length ? 'notes-error' : undefined} />
            <FieldError errors={fieldErrors} name="notes" />
          </div>
          <PhotosField
            id="checkout-photos"
            legend="Photos de la remise"
            companyId={vehicleCompanyId}
            photos={photos}
            onAdd={(added) => setPhotos((prev) => [...prev, ...added])}
            onRemove={(id) => setPhotos((prev) => prev.filter((p) => p.id !== id))}
            errors={fieldErrors}
          />
          <div className="space-y-2">
            <Label htmlFor="confirmedByName">Confirmation nominative (facultative)</Label>
            <Input
              id="confirmedByName"
              value={confirmedByName}
              maxLength={150}
              autoComplete="off"
              onChange={(e) => setConfirmedByName(e.target.value)}
              placeholder="Nom de la personne qui confirme la remise"
              aria-describedby={['confirmedByName-hint', fieldErrors.confirmedByName?.length ? 'confirmedByName-error' : ''].filter(Boolean).join(' ')}
            />
            <p id="confirmedByName-hint" className="text-xs text-muted-foreground">
              Simple mention du nom, conservée sur la fiche de remise. Ce n’est pas une signature certifiée.
            </p>
            <FieldError errors={fieldErrors} name="confirmedByName" />
          </div>
        </CardContent>
      </Card>

      {submitError ? <ApiErrorAlert error={submitError} title="La remise n’a pas été enregistrée" idempotent /> : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={busy}>
          {checking ? 'Vérification des blocages…' : checkout.isPending ? 'Enregistrement…' : 'Vérifier et enregistrer la remise'}
        </Button>
        <Button variant="outline" asChild>
          <Link href="/utilisations">Annuler</Link>
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !checkout.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer la remise</AlertDialogTitle>
            <AlertDialogDescription>
              {vehicle ? `${vehicle.code} · ${vehicle.registration}` : ''} remis à {driver ? fullName(driver) : ''}. L’utilisation passera « En cours ».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid gap-1 text-sm">
            <SummaryRow label="Remise" value={atIso ? formatDateTime(atIso, session.timezone) : '—'} />
            <SummaryRow label="Retour prévu" value={expectedIso ? formatDateTime(expectedIso, session.timezone) : '—'} />
            <SummaryRow label="Compteur" value={withReading ? (km.trim() ? `${km.trim()} km (valeur saisie)` : 'Non saisi') : 'Départ sans relevé (exception motivée)'} />
            {selectedReservation ? <SummaryRow label="Réservation convertie" value={`du ${formatDateTime(selectedReservation.startAt, session.timezone)} au ${formatDateTime(selectedReservation.endAt, session.timezone)}`} /> : null}
            {softBlockers.length > 0 ? <SummaryRow label="Dérogation" value={overrideReason.trim()} /> : null}
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={checkout.isPending}>Revenir au formulaire</AlertDialogCancel>
            <AlertDialogAction
              disabled={checkout.isPending}
              onClick={(e) => {
                e.preventDefault();
                checkout.mutate();
              }}
            >
              {checkout.isPending ? 'Enregistrement…' : 'Confirmer la remise'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label} :</dt>
      <dd className="font-medium">{value || '—'}</dd>
    </div>
  );
}
