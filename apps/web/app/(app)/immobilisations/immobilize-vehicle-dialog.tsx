'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { EMPTY_PLACE, PlaceFields, type PlaceValue, placeCreateBody, placeLocalErrors } from '@/components/incidents/place-fields';
import { useAppScope } from '@/components/layout/session-context';
import { MaintenanceVehiclePicker } from '@/components/maintenance/vehicle-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { ImmobilizationView } from '@/lib/immobilizations-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { EMPTY_SOURCE, SourceFields, type SourceValue, sourceBody, sourceLocalErrors } from './source-fields';

/**
 * « Immobiliser un véhicule » (POST /immobilizations) : ouvre une immobilisation, ou ajoute la cause à
 * l'immobilisation active du véhicule (lieu et fin prévue saisis appliqués explicitement). Début jamais
 * futur ; garage, site ou lieu libre exclusifs.
 */
export function ImmobilizeVehicleDialog({ initialVehicleId = '', onOpenChange }: { initialVehicleId?: string; onOpenChange: (open: boolean) => void }) {
  const { session, companyId } = useAppScope();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [vehicleId, setVehicleId] = useState(initialVehicleId);
  const vehicle = useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`), enabled: Boolean(vehicleId) });
  const vehicleCompanyId = vehicle.data?.companyId ?? null;
  const [reason, setReason] = useState('');
  const [startedAt, setStartedAt] = useState(() => nowLocalInput(session.timezone));
  const [expectedEndAt, setExpectedEndAt] = useState('');
  const [place, setPlace] = useState<PlaceValue>(EMPTY_PLACE);
  const [source, setSource] = useState<SourceValue>(EMPTY_SOURCE);
  const [local, setLocal] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ImmobilizationView>('/immobilizations', { method: 'POST', body }),
    onSuccess: (created) => {
      toast.success(`Véhicule ${created.vehicleCode} immobilisé.`);
      queryClient.setQueryData(['immobilization', created.id], created);
      void queryClient.invalidateQueries({ queryKey: ['immobilizations'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', created.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident'] });
      router.push(`/immobilisations/${created.id}`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Immobilisation impossible.'),
  });
  const errors = { ...errorsOf(create.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Immobiliser un véhicule</DialogTitle>
          <DialogDescription>
            Si le véhicule est déjà immobilisé, la cause est ajoutée à son immobilisation active : le lieu et la fin prévue saisis ici remplacent alors ceux de cette immobilisation (modification enregistrée dans le journal). La disponibilité est rétablie seulement après la fin de toutes les causes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = { ...placeLocalErrors(place), ...sourceLocalErrors(source) };
            const startIso = localInputToIso(startedAt, session.timezone);
            const endIso = expectedEndAt ? localInputToIso(expectedEndAt, session.timezone) : null;
            if (!vehicleId) next.vehicleId = ['Choisissez le véhicule.'];
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            if (!startIso) next.startedAt = ['Indiquez la date et l’heure de début.'];
            if (expectedEndAt && !endIso) next.expectedEndAt = ['Date et heure invalides.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            create.mutate({ vehicleId, reason: reason.trim(), startedAt: startIso ?? undefined, expectedEndAt: endIso ?? undefined, ...placeCreateBody(place), ...sourceBody(source) });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="immobilization-vehicle">Véhicule *</Label>
            <MaintenanceVehiclePicker
              id="immobilization-vehicle"
              value={vehicleId}
              companyId={companyId}
              onChange={(v: VehicleView | null) => {
                setVehicleId(v?.id ?? '');
                setPlace(EMPTY_PLACE);
                setSource(EMPTY_SOURCE);
              }}
              invalid={Boolean(errors.vehicleId?.length)}
              describedBy={describedBy(errors, 'vehicleId')}
            />
            <FieldError errors={errors} name="vehicleId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="immobilization-reason">Motif *</Label>
            <Textarea id="immobilization-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <SourceFields idPrefix="immobilization" vehicleId={vehicleId || null} value={source} onChange={setSource} errors={errors} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="immobilization-start">Début *</Label>
              <Input id="immobilization-start" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} aria-invalid={invalid(errors, 'startedAt')} aria-describedby={describedBy(errors, 'startedAt', 'immobilization-tz')} />
              <FieldError errors={errors} name="startedAt" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="immobilization-expected-end">Fin prévue</Label>
              <Input
                id="immobilization-expected-end"
                type="datetime-local"
                value={expectedEndAt}
                min={startedAt || undefined}
                onChange={(e) => setExpectedEndAt(e.target.value)}
                aria-invalid={invalid(errors, 'expectedEndAt')}
                aria-describedby={describedBy(errors, 'expectedEndAt', 'immobilization-tz')}
              />
              <FieldError errors={errors} name="expectedEndAt" />
            </div>
          </div>
          <p id="immobilization-tz" className="text-xs text-muted-foreground">
            Heures dans le fuseau de l’organisation ({session.timezone}). Le début n’est jamais dans le futur : pour un arrêt à venir, planifiez une intervention.
          </p>
          <PlaceFields idPrefix="immobilization" companyId={vehicleCompanyId} value={place} onChange={setPlace} errors={errors} />
          {create.error ? <ApiErrorAlert error={create.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={create.isPending}>
              {create.isPending ? 'Enregistrement…' : 'Immobiliser'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
