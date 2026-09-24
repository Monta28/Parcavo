'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { OverrideLegalNotice } from '@/components/documents/override-notice';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { ReservationView } from '@/lib/reservations-types';
import type { SiteView } from '@/lib/vehicles-types';
import { isoToLocalInput, localInputToIso } from '@/lib/zoned-time';
import { DriverSummaryPicker, useVehicleView, VehiclePicker } from './entity-pickers';
import { ApiErrorAlert, reservationStatusLabel, toneForReservation, useNow, useReservationRights } from './planning-shared';

const NO_SITE = '__aucun__';

export type ReservationDialogMode = 'detail' | 'modifier' | 'annuler' | 'non-honoree';

/** Lien vers le formulaire de remise, qui convertit la réservation (paramètre reservationId). */
export function convertHref(reservationId: string): string {
  return `/utilisations/nouvelle?reservationId=${encodeURIComponent(reservationId)}`;
}

/**
 * Détail d'une réservation (GET /reservations/:id) et ses actions : modification (PATCH, motif et
 * expectedVersion), annulation (POST cancel), non-présentation (POST no-show), conversion en remise.
 */
export function ReservationDialog({ reservationId, initialMode = 'detail', onClose }: { reservationId: string; initialMode?: ReservationDialogMode; onClose: () => void }) {
  const [requestedMode, setMode] = useState<ReservationDialogMode>(initialMode);
  const [notice, setNotice] = useState<string | null>(null);
  const isActionable = useIsActionable();
  const reservation = useQuery({ queryKey: ['reservation', reservationId], queryFn: () => api<ReservationView>(`/reservations/${reservationId}`) });
  // Une réservation devenue non modifiable (statut renvoyé par l'API, droits) s'ouvre toujours en lecture.
  const mode: ReservationDialogMode = reservation.data && !isActionable(reservation.data) ? 'detail' : requestedMode;
  const title = reservation.data ? `Réservation ${reservation.data.vehicleCode} · ${reservation.data.driverName}` : 'Réservation';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'modifier' ? `Modifier la ${title.charAt(0).toLowerCase()}${title.slice(1)}` : mode === 'annuler' ? 'Annuler la réservation' : mode === 'non-honoree' ? 'Déclarer la réservation non honorée' : title}</DialogTitle>
          <DialogDescription>
            {mode === 'modifier'
              ? 'Le motif de la modification est conservé avec son auteur et sa date. Les contrôles de la création sont refaits si le véhicule, le conducteur ou le créneau change ; après le début prévu, seule la fin reste modifiable.'
              : mode === 'annuler'
                ? 'L’annulation libère le créneau. Elle est définitive et conservée avec son auteur, sa date et son motif.'
                : mode === 'non-honoree'
                  ? 'Constat possible à partir du début prévu augmenté du délai de grâce : le créneau est libéré. Ce statut est définitif et conservé avec son auteur, sa date et son motif.'
                  : 'Créneau [début, fin[ : la fin prévue est exclue.'}
          </DialogDescription>
        </DialogHeader>
        {reservation.isPending ? (
          <LoadingState label="Chargement de la réservation…" />
        ) : reservation.isError ? (
          <ErrorState error={reservation.error} retry={() => void reservation.refetch()} />
        ) : mode === 'modifier' ? (
          <EditForm
            reservation={reservation.data}
            onDone={() => setMode('detail')}
            onStale={(message) => {
              setNotice(message);
              setMode('detail');
            }}
          />
        ) : mode === 'annuler' || mode === 'non-honoree' ? (
          <DecisionForm
            reservation={reservation.data}
            kind={mode}
            onDone={() => setMode('detail')}
            onStale={(message) => {
              setNotice(message);
              setMode('detail');
            }}
          />
        ) : (
          <Detail reservation={reservation.data} notice={notice} onMode={(m) => { setNotice(null); setMode(m); }} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Actions d'écriture proposées : réservation CONFIRMEE (statut de l'API) et rôle opérationnel sur sa société. */
function useIsActionable() {
  const { session } = useAppScope();
  const { canOperate } = useReservationRights();
  return (r: Pick<ReservationView, 'status' | 'companyId'>) => r.status === 'CONFIRMEE' && !session.isDriverOnly && canOperate(r.companyId);
}

function Detail({ reservation: r, notice, onMode, onClose }: { reservation: ReservationView; notice: string | null; onMode: (mode: ReservationDialogMode) => void; onClose: () => void }) {
  const { session } = useAppScope();
  const isActionable = useIsActionable();
  const sites = useQuery({
    queryKey: ['sites', r.companyId, 'tous'],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: r.companyId, pageSize: 100 })}`),
    enabled: Boolean(r.siteId) && !session.isDriverOnly,
  });
  const siteName = r.siteId ? (sites.data?.items.find((s) => s.id === r.siteId)?.name ?? null) : null;
  const actionable = isActionable(r);
  const now = useNow();
  // Instant calculé par l'API (début prévu + délai de grâce) : le bouton reste inactif avant.
  const noShowOpen = r.noShowAllowedFrom !== null && now >= Date.parse(r.noShowAllowedFrom);

  return (
    <div className="space-y-4">
      {notice ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={reservationStatusLabel(r.status)} tone={toneForReservation(r.status)} />
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Item label="Véhicule">
          {session.isDriverOnly ? (
            `${r.vehicleCode} · ${r.vehicleRegistration}`
          ) : (
            <Link href={`/vehicules/${r.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
              {r.vehicleCode} · {r.vehicleRegistration}
            </Link>
          )}
        </Item>
        <Item label="Conducteur">
          {session.isDriverOnly ? (
            r.driverName
          ) : (
            <Link href={`/conducteurs/${r.driverId}`} className="font-medium underline-offset-4 hover:underline">
              {r.driverName}
            </Link>
          )}
        </Item>
        <Item label="Début prévu (inclus)">{formatDateTime(r.startAt, session.timezone)}</Item>
        <Item label="Fin prévue (exclue)">{formatDateTime(r.endAt, session.timezone)}</Item>
        <Item label="Motif">{r.purpose}</Item>
        <Item label="Destination">{r.destination ?? '—'}</Item>
        {r.siteId ? <Item label="Site">{siteName ?? (sites.isPending ? 'Chargement…' : '—')}</Item> : null}
        <Item label="Créée">
          {formatDateTime(r.createdAt, session.timezone)}
          {r.createdByName ? ` par ${r.createdByName}` : ''}
        </Item>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Commentaire</dt>
          <dd className="whitespace-pre-wrap">{r.comment ?? '—'}</dd>
        </div>
        {r.status === 'ANNULEE' ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Annulation</dt>
            <dd>
              {formatDateTime(r.cancelledAt, session.timezone)}
              {r.closedByName ? ` par ${r.closedByName}` : ''}
              {r.cancelReason ? ` — ${r.cancelReason}` : ''}
            </dd>
          </div>
        ) : null}
        {r.status === 'NON_HONOREE' ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Non-présentation</dt>
            <dd>
              {r.noShowAt ? formatDateTime(r.noShowAt, session.timezone) : '—'}
              {r.closedByName ? ` par ${r.closedByName}` : ' (constat automatique à la fin prévue)'}
              {r.cancelReason ? ` — ${r.cancelReason}` : ''}
            </dd>
          </div>
        ) : null}
        {r.convertedUsageId ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Utilisation issue de la remise</dt>
            <dd>
              <Link href={`/utilisations/${r.convertedUsageId}`} className="underline underline-offset-4">
                Ouvrir l’utilisation
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>
      {actionable && !noShowOpen && r.noShowAllowedFrom ? <p className="text-xs text-muted-foreground">Non-présentation constatable à partir du {formatDateTime(r.noShowAllowedFrom, session.timezone)}.</p> : null}
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <Button type="button" variant="outline" onClick={onClose}>
          Fermer
        </Button>
        {actionable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => onMode('modifier')}>
              Modifier
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onMode('non-honoree')}
              disabled={!noShowOpen}
              title={!noShowOpen && r.noShowAllowedFrom ? `Constat possible à partir du ${formatDateTime(r.noShowAllowedFrom, session.timezone)}` : undefined}
            >
              Non honorée
            </Button>
            <Button type="button" variant="outline" className="text-destructive" onClick={() => onMode('annuler')}>
              Annuler la réservation
            </Button>
            <Button asChild>
              <Link href={convertHref(r.id)}>Convertir en remise</Link>
            </Button>
          </div>
        ) : null}
      </DialogFooter>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Mise à jour du cache et des listes après une action réussie. */
function useRefresh(reservationId: string) {
  const queryClient = useQueryClient();
  return (updated?: ReservationView) => {
    if (updated) queryClient.setQueryData(['reservation', reservationId], updated);
    void queryClient.invalidateQueries({ queryKey: ['reservation', reservationId] });
    void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    void queryClient.invalidateQueries({ queryKey: ['planning'] });
  };
}

/** Verrou optimiste : la réservation a été modifiée entre-temps (409 VERSION_OBSOLETE). */
function isStale(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === 'VERSION_OBSOLETE';
}

function EditForm({ reservation: r, onDone, onStale }: { reservation: ReservationView; onDone: () => void; onStale: (message: string) => void }) {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const { canOperate, canOverride } = useReservationRights();
  const refresh = useRefresh(r.id);
  // Périmètre modifiable calculé par l'API : après le début prévu, seule la fin reste modifiable.
  const endOnly = r.editScope === 'FIN_SEULEMENT';
  const initialStart = isoToLocalInput(r.startAt, session.timezone);
  const initialEnd = isoToLocalInput(r.endAt, session.timezone);
  const [vehicleId, setVehicleId] = useState(r.vehicleId);
  const [driverId, setDriverId] = useState(r.driverId);
  const [siteId, setSiteId] = useState(r.siteId ?? NO_SITE);
  const [startAt, setStartAt] = useState(initialStart);
  const [endAt, setEndAt] = useState(initialEnd);
  const [purpose, setPurpose] = useState(r.purpose);
  const [destination, setDestination] = useState(r.destination ?? '');
  const [comment, setComment] = useState(r.comment ?? '');
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overridable, setOverridable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const vehicle = useVehicleView(vehicleId);
  const vehicleCompanyId = vehicle.data?.companyId ?? (vehicleId === r.vehicleId ? r.companyId : null);
  const sites = useQuery({
    queryKey: ['sites', vehicleCompanyId, 'actifs'],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: vehicleCompanyId, pageSize: 100, status: 'ACTIF' })}`),
    enabled: Boolean(vehicleCompanyId) && !endOnly,
  });
  const mayOverride = overridable && vehicleCompanyId !== null && canOverride(vehicleCompanyId);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ReservationView>(`/reservations/${r.id}`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      toast.success('Réservation modifiée.');
      refresh(updated);
      onDone();
    },
    onError: (error) => {
      if (isStale(error)) {
        refresh();
        onStale(error.message);
      } else if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        setOverridable(error.code === 'RESERVATION_BLOQUEE' && error.details?.overridable === true);
      }
    },
  });

  const submit = () => {
    const errors: Record<string, string[]> = {};
    const startIso = startAt === initialStart ? undefined : localInputToIso(startAt, session.timezone);
    const endIso = endAt === initialEnd ? undefined : localInputToIso(endAt, session.timezone);
    if (!vehicleId) errors.vehicleId = ['Choisissez un véhicule.'];
    if (!driverId) errors.driverId = ['Choisissez un conducteur.'];
    if (startIso === null) errors.startAt = ['Date et heure de début requises.'];
    if (endIso === null) errors.endAt = ['Date et heure de fin requises.'];
    if (purpose.trim().length < 2) errors.purpose = ['Motif requis (2 caractères minimum).'];
    if (reason.trim().length < 3) errors.reason = ['Motif de la modification requis (3 caractères minimum).'];
    if (mayOverride && overrideReason.trim().length < 5) errors.overrideReason = ['Motif de dérogation requis (5 caractères minimum).'];
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const nextDestination = destination.trim() || null;
    const nextComment = comment.trim() || null;
    const nextSiteId = siteId === NO_SITE ? null : siteId;
    save.mutate({
      vehicleId: vehicleId !== r.vehicleId ? vehicleId : undefined,
      driverId: driverId !== r.driverId ? driverId : undefined,
      startAt: startIso,
      endAt: endIso,
      purpose: purpose.trim() !== r.purpose ? purpose.trim() : undefined,
      destination: nextDestination !== r.destination ? nextDestination : undefined,
      siteId: nextSiteId !== r.siteId ? nextSiteId : undefined,
      comment: nextComment !== r.comment ? nextComment : undefined,
      overrideReason: mayOverride ? overrideReason.trim() : undefined,
      reason: reason.trim(),
      expectedVersion: r.version,
    });
  };
  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-muted-foreground sm:col-span-2">
        {endOnly ? 'Le début prévu est passé : seule la fin prévue peut encore être modifiée. ' : ''}Heures exprimées dans le fuseau {session.timezone}.
      </p>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="edit-reservation-vehicle">Véhicule *</Label>
        {endOnly ? (
          <p id="edit-reservation-vehicle" className="text-sm">
            {r.vehicleCode} · {r.vehicleRegistration}
          </p>
        ) : (
          <VehiclePicker
            id="edit-reservation-vehicle"
            value={vehicleId}
            onChange={(v) => {
              setVehicleId(v);
              setSiteId(NO_SITE);
              setOverridable(false);
            }}
            companyId={scopeCompanyId}
            activeOnly
            allowCompany={canOperate}
            invalid={invalid('vehicleId')}
            describedBy="vehicleId-error"
            modal
          />
        )}
        <FieldError errors={fieldErrors} name="vehicleId" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="edit-reservation-driver">Conducteur *</Label>
        {endOnly ? (
          <p id="edit-reservation-driver" className="text-sm">
            {r.driverName}
          </p>
        ) : (
          <DriverSummaryPicker
            id="edit-reservation-driver"
            value={driverId}
            onChange={(d) => {
              setDriverId(d);
              setOverridable(false);
            }}
            companyId={vehicleCompanyId}
            invalid={invalid('driverId')}
            describedBy="edit-driver-hint driverId-error"
            modal
          />
        )}
        {endOnly ? null : (
          <p id="edit-driver-hint" className="text-xs text-muted-foreground">
            Conducteurs actifs de la société du véhicule.
          </p>
        )}
        <FieldError errors={fieldErrors} name="driverId" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-reservation-start">Début prévu (inclus) *</Label>
        <Input id="edit-reservation-start" type="datetime-local" required disabled={endOnly} value={startAt} onChange={(e) => setStartAt(e.target.value)} aria-invalid={invalid('startAt')} aria-describedby="startAt-error" />
        <FieldError errors={fieldErrors} name="startAt" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-reservation-end">Fin prévue (exclue) *</Label>
        <Input id="edit-reservation-end" type="datetime-local" required value={endAt} onChange={(e) => setEndAt(e.target.value)} aria-invalid={invalid('endAt')} aria-describedby="endAt-error" />
        <FieldError errors={fieldErrors} name="endAt" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="edit-reservation-purpose">Motif *</Label>
        <Input id="edit-reservation-purpose" required minLength={2} maxLength={300} disabled={endOnly} value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-invalid={invalid('purpose')} aria-describedby="purpose-error" />
        <FieldError errors={fieldErrors} name="purpose" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-reservation-site">Site de destination</Label>
        <Select value={siteId} onValueChange={setSiteId} disabled={endOnly || !vehicleCompanyId}>
          <SelectTrigger id="edit-reservation-site" className="w-full" aria-describedby="siteId-error">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SITE}>Aucun site</SelectItem>
            {siteId !== NO_SITE && !(sites.data?.items ?? []).some((site) => site.id === siteId) ? <SelectItem value={siteId}>Site actuel</SelectItem> : null}
            {(sites.data?.items ?? []).map((site) => (
              <SelectItem key={site.id} value={site.id}>
                {site.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError errors={fieldErrors} name="siteId" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-reservation-destination">Destination</Label>
        <Input id="edit-reservation-destination" maxLength={300} disabled={endOnly} value={destination} onChange={(e) => setDestination(e.target.value)} aria-describedby="destination-error" />
        <FieldError errors={fieldErrors} name="destination" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="edit-reservation-comment">Commentaire</Label>
        <Textarea id="edit-reservation-comment" maxLength={2000} disabled={endOnly} value={comment} onChange={(e) => setComment(e.target.value)} aria-describedby="comment-error" />
        <FieldError errors={fieldErrors} name="comment" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="edit-reservation-reason">Motif de la modification *</Label>
        <Textarea id="edit-reservation-reason" required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid('reason')} aria-describedby="reason-error" />
        <FieldError errors={fieldErrors} name="reason" />
      </div>
      {mayOverride ? (
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="edit-reservation-override">Motif de la dérogation *</Label>
          <Textarea id="edit-reservation-override" minLength={5} maxLength={500} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} aria-invalid={invalid('overrideReason')} aria-describedby="edit-override-hint edit-override-legal overrideReason-error" />
          <p id="edit-override-hint" className="text-xs text-muted-foreground">
            Blocage documentaire ou de permis levable par dérogation motivée et tracée. Elle ne vaut pas dérogation au départ, qui refait tous les contrôles.
          </p>
          <OverrideLegalNotice id="edit-override-legal" />
          <FieldError errors={fieldErrors} name="overrideReason" />
        </div>
      ) : null}
      {save.isError && !isStale(save.error) ? (
        <div className="sm:col-span-2">
          <ApiErrorAlert error={save.error} />
        </div>
      ) : null}
      <DialogFooter className="sm:col-span-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          Retour
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : mayOverride ? 'Enregistrer avec dérogation' : 'Enregistrer la modification'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DecisionForm({ reservation: r, kind, onDone, onStale }: { reservation: ReservationView; kind: 'annuler' | 'non-honoree'; onDone: () => void; onStale: (message: string) => void }) {
  const { session } = useAppScope();
  const refresh = useRefresh(r.id);
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const path = kind === 'annuler' ? 'cancel' : 'no-show';

  const decide = useMutation({
    mutationFn: () => api<ReservationView>(`/reservations/${r.id}/${path}`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: r.version } }),
    onSuccess: (updated) => {
      toast.success(kind === 'annuler' ? 'Réservation annulée.' : 'Réservation déclarée non honorée.');
      refresh(updated);
      onDone();
    },
    onError: (error) => {
      if (isStale(error)) {
        refresh();
        onStale(error.message);
      } else if (isApiError(error)) setFieldErrors(error.fieldErrors);
    },
  });
  const reasonId = `${path}-reason`;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length < 3) {
          setFieldErrors({ reason: ['Motif requis (3 caractères minimum).'] });
          return;
        }
        setFieldErrors({});
        decide.mutate();
      }}
    >
      <p className="text-sm">
        <span className="font-medium">
          {r.vehicleCode} · {r.vehicleRegistration}
        </span>{' '}
        pour {r.driverName}, du {formatDateTime(r.startAt, session.timezone)} au {formatDateTime(r.endAt, session.timezone)}.
        {kind === 'non-honoree' && r.noShowAllowedFrom ? ` Constat possible à partir du ${formatDateTime(r.noShowAllowedFrom, session.timezone)}.` : ''}
      </p>
      <div className="space-y-2">
        <Label htmlFor={reasonId}>{kind === 'annuler' ? 'Motif de l’annulation *' : 'Motif du constat *'}</Label>
        <Textarea id={reasonId} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason?.length ? true : undefined} aria-describedby="reason-error" />
        <FieldError errors={fieldErrors} name="reason" />
      </div>
      {decide.isError && !isStale(decide.error) ? <ApiErrorAlert error={decide.error} /> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={decide.isPending}>
          Retour
        </Button>
        <Button type="submit" variant={kind === 'annuler' ? 'destructive' : 'default'} disabled={decide.isPending || reason.trim().length < 3}>
          {decide.isPending ? 'Enregistrement…' : kind === 'annuler' ? 'Confirmer l’annulation' : 'Confirmer la non-présentation'}
        </Button>
      </DialogFooter>
    </form>
  );
}
