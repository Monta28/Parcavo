'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { OverrideLegalNotice } from '@/components/documents/override-notice';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { ReservationView } from '@/lib/reservations-types';
import type { SiteView } from '@/lib/vehicles-types';
import { localInputToIso } from '@/lib/zoned-time';
import { DriverSummaryPicker, VehiclePicker, useVehicleView } from './entity-pickers';
import { ApiErrorAlert, useReservationRights } from './planning-shared';

const NO_SITE = '__aucun__';

interface FormState {
  vehicleId: string;
  driverId: string;
  startAt: string;
  endAt: string;
  purpose: string;
  siteId: string;
  destination: string;
  comment: string;
  overrideReason: string;
}

/**
 * Création d'une réservation (POST /reservations) : la création vaut confirmation après contrôles de l'API
 * (chevauchements [début, fin[ du véhicule et du conducteur, conducteur actif, blocages connus).
 */
export function NewReservationDialog({ defaultVehicleId, onClose }: { defaultVehicleId?: string; onClose: () => void }) {
  const { session, companyId } = useAppScope();
  const queryClient = useQueryClient();
  const { canOperate, canOverride } = useReservationRights();
  const [form, setForm] = useState<FormState>({ vehicleId: defaultVehicleId ?? '', driverId: '', startAt: '', endAt: '', purpose: '', siteId: NO_SITE, destination: '', comment: '', overrideReason: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [overridable, setOverridable] = useState(false);
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const vehicle = useVehicleView(form.vehicleId);
  const vehicleCompanyId = vehicle.data?.companyId ?? null;
  const sites = useQuery({
    queryKey: ['sites', vehicleCompanyId, 'actifs'],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: vehicleCompanyId, pageSize: 100, status: 'ACTIF' })}`),
    enabled: Boolean(vehicleCompanyId),
  });
  const mayOverride = overridable && vehicleCompanyId !== null && canOverride(vehicleCompanyId);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ReservationView>('/reservations', { method: 'POST', body }),
    onSuccess: (reservation) => {
      toast.success(`Réservation confirmée : ${reservation.vehicleCode} pour ${reservation.driverName}.`);
      void queryClient.invalidateQueries({ queryKey: ['planning'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        setOverridable(error.code === 'RESERVATION_BLOQUEE' && error.details?.overridable === true);
      }
    },
  });

  const submit = () => {
    const errors: Record<string, string[]> = {};
    if (!form.vehicleId) errors.vehicleId = ['Choisissez un véhicule.'];
    if (!form.driverId) errors.driverId = ['Choisissez un conducteur.'];
    const startAt = localInputToIso(form.startAt, session.timezone);
    const endAt = localInputToIso(form.endAt, session.timezone);
    if (!startAt) errors.startAt = ['Date et heure de début requises.'];
    if (!endAt) errors.endAt = ['Date et heure de fin requises.'];
    if (form.purpose.trim().length < 2) errors.purpose = ['Motif requis (2 caractères minimum).'];
    if (mayOverride && form.overrideReason.trim().length < 5) errors.overrideReason = ['Motif de dérogation requis (5 caractères minimum).'];
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    create.mutate({
      vehicleId: form.vehicleId,
      driverId: form.driverId,
      startAt,
      endAt,
      purpose: form.purpose.trim(),
      destination: form.destination.trim() || undefined,
      siteId: form.siteId === NO_SITE ? undefined : form.siteId,
      comment: form.comment.trim() || undefined,
      overrideReason: mayOverride ? form.overrideReason.trim() : undefined,
    });
  };

  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nouvelle réservation</DialogTitle>
          <DialogDescription>
            Créneau [début, fin[ : la fin est exclue, deux créneaux consécutifs sont donc possibles. Heures exprimées dans le fuseau {session.timezone}. Les contrôles sont refaits au départ.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-reservation-vehicle">Véhicule *</Label>
            <VehiclePicker
              id="new-reservation-vehicle"
              value={form.vehicleId}
              onChange={(vehicleId) => {
                update({ vehicleId, driverId: '', siteId: NO_SITE });
                setOverridable(false);
              }}
              companyId={companyId}
              activeOnly
              allowCompany={canOperate}
              invalid={invalid('vehicleId')}
              describedBy="vehicleId-error"
              modal
            />
            <FieldError errors={fieldErrors} name="vehicleId" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-reservation-driver">Conducteur *</Label>
            <DriverSummaryPicker
              id="new-reservation-driver"
              value={form.driverId}
              onChange={(driverId) => {
                update({ driverId });
                setOverridable(false);
              }}
              companyId={vehicleCompanyId}
              invalid={invalid('driverId')}
              describedBy="driver-hint driverId-error"
              modal
            />
            <p id="driver-hint" className="text-xs text-muted-foreground">
              Conducteurs actifs de la société du véhicule.
            </p>
            <FieldError errors={fieldErrors} name="driverId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-reservation-start">Début prévu (inclus) *</Label>
            <Input id="new-reservation-start" type="datetime-local" required value={form.startAt} onChange={(e) => update({ startAt: e.target.value })} aria-invalid={invalid('startAt')} aria-describedby="startAt-error" />
            <FieldError errors={fieldErrors} name="startAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-reservation-end">Fin prévue (exclue) *</Label>
            <Input id="new-reservation-end" type="datetime-local" required value={form.endAt} onChange={(e) => update({ endAt: e.target.value })} aria-invalid={invalid('endAt')} aria-describedby="endAt-error" />
            <FieldError errors={fieldErrors} name="endAt" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-reservation-purpose">Motif *</Label>
            <Input id="new-reservation-purpose" required minLength={2} maxLength={300} value={form.purpose} onChange={(e) => update({ purpose: e.target.value })} aria-invalid={invalid('purpose')} aria-describedby="purpose-error" />
            <FieldError errors={fieldErrors} name="purpose" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-reservation-site">Site de destination</Label>
            <Select value={form.siteId} onValueChange={(siteId) => update({ siteId })} disabled={!vehicleCompanyId}>
              <SelectTrigger id="new-reservation-site" className="w-full" aria-describedby="siteId-error">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SITE}>Aucun site</SelectItem>
                {(sites.data?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={fieldErrors} name="siteId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-reservation-destination">Destination</Label>
            <Input id="new-reservation-destination" maxLength={300} value={form.destination} onChange={(e) => update({ destination: e.target.value })} placeholder="Ex. client, ville" aria-describedby="destination-error" />
            <FieldError errors={fieldErrors} name="destination" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-reservation-comment">Commentaire</Label>
            <Textarea id="new-reservation-comment" maxLength={2000} value={form.comment} onChange={(e) => update({ comment: e.target.value })} aria-describedby="comment-error" />
            <FieldError errors={fieldErrors} name="comment" />
          </div>
          {mayOverride ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="new-reservation-override">Motif de la dérogation *</Label>
              <Textarea id="new-reservation-override" minLength={5} maxLength={500} value={form.overrideReason} onChange={(e) => update({ overrideReason: e.target.value })} aria-invalid={invalid('overrideReason')} aria-describedby="override-hint override-legal overrideReason-error" />
              <p id="override-hint" className="text-xs text-muted-foreground">
                Blocage documentaire ou de permis levable par dérogation motivée et tracée. Elle ne vaut pas dérogation au départ, qui refait tous les contrôles.
              </p>
              <OverrideLegalNotice id="override-legal" />
              <FieldError errors={fieldErrors} name="overrideReason" />
            </div>
          ) : null}
          {create.isError ? (
            <div className="sm:col-span-2">
              <ApiErrorAlert error={create.error} />
            </div>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Confirmation…' : mayOverride ? 'Confirmer avec dérogation' : 'Confirmer la réservation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
