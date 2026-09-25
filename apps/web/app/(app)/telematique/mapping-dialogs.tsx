'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { SimulatorNotice } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { CloseMappingResult, MappingView, UnitView, VehicleRef } from '@/lib/telemetry-types';
import { localInputToIso } from '@/lib/zoned-time';
import { NaturesFields, UnitPicker, ValidFromField, VehiclePicker, type Natures } from './mapping-fields';

const EMPTY_NATURES: Natures = { odometerKind: '', fuelKinds: [] };

/**
 * Saisie datetime-local (heure de l'organisation) convertie en instant ISO UTC. Une saisie illisible
 * n'est jamais envoyée telle quelle (elle serait lue dans le fuseau du serveur) : elle bloque l'envoi.
 */
function zonedInput(value: string, timezone: string): { iso: string | undefined; invalid: boolean } {
  if (value === '') return { iso: undefined, invalid: false };
  const iso = localInputToIso(value, timezone);
  return iso ? { iso, invalid: false } : { iso: undefined, invalid: true };
}

function withLocalError(errors: Record<string, string[]>, field: string, invalid: boolean): Record<string, string[]> {
  return invalid ? { ...errors, [field]: ['Date ou heure invalide.'] } : errors;
}

/** Erreurs d'une mutation d'association : message, champs et rechargement sur version obsolète. */
function useMappingMutation<T>(fn: () => Promise<T>, success: (result: T) => string, onDone: () => void) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const mutation = useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      toast.success(success(result));
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      onDone();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Opération impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      toast.error(error.message);
      if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
        onDone();
      }
    },
  });
  return { mutation, fieldErrors, reset: () => setFieldErrors({}) };
}

function MappingSummary({ unit, vehicle, providerName, isSimulator }: { unit: { label: string; externalId: string; declaredRegistration: string | null } | null; vehicle: VehicleRef | null; providerName: string; isSimulator: boolean }) {
  return (
    <div className="space-y-2">
      <dl className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2">
        {unit ? (
          <div>
            <dt className="text-muted-foreground">Unité ({providerName})</dt>
            <dd>
              {unit.label} <span className="text-muted-foreground">({unit.externalId})</span>
              <span className="block text-xs text-muted-foreground">Immatriculation déclarée : {unit.declaredRegistration ?? 'aucune'}</span>
            </dd>
          </div>
        ) : null}
        {vehicle ? (
          <div>
            <dt className="text-muted-foreground">Véhicule</dt>
            <dd>
              {vehicle.code} · {vehicle.registration}
            </dd>
          </div>
        ) : null}
      </dl>
      {isSimulator ? <SimulatorNotice /> : null}
    </div>
  );
}

/** Confirmation d'une proposition (14.5, D-301) : aucune donnée n'est ingérée avant cette décision. */
export function ConfirmMappingDialog({ mapping, onClose }: { mapping: MappingView; onClose: () => void }) {
  const { session } = useAppScope();
  const [natures, setNatures] = useState<Natures>(EMPTY_NATURES);
  const [validFrom, setValidFrom] = useState('');
  const effect = zonedInput(validFrom, session.timezone);
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () =>
      api<MappingView>(`/telemetry/mappings/${mapping.id}/confirm`, {
        method: 'POST',
        body: { odometerKind: natures.odometerKind, fuelKinds: natures.fuelKinds, validFrom: effect.iso, expectedVersion: mapping.version },
      }),
    (m) => `Association confirmée pour ${m.vehicle.code} à compter du ${formatDateTime(m.validFrom, session.timezone)}.`,
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Confirmer l’association</DialogTitle>
          <DialogDescription>
            Proposition du {formatDateTime(mapping.proposedAt, session.timezone)}
            {mapping.proposalReason ? ` : ${mapping.proposalReason}` : ''}. La confirmation ouvre l’ingestion à partir de la date d’effet (reprise initiale comprise).
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          <MappingSummary unit={{ label: mapping.unitLabel, externalId: mapping.unitExternalId, declaredRegistration: mapping.unitDeclaredRegistration }} vehicle={mapping.vehicle} providerName={mapping.providerName} isSimulator={mapping.isSimulator} />
          <NaturesFields idPrefix="confirm" value={natures} onChange={setNatures} errors={fieldErrors} />
          <ValidFromField id="confirm-validFrom" value={validFrom} onChange={setValidFrom} errors={withLocalError(fieldErrors, 'validFrom', effect.invalid)} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || natures.odometerKind === '' || effect.invalid}>
              {mutation.isPending ? 'Confirmation…' : 'Confirmer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RejectMappingDialog({ mapping, onClose }: { mapping: MappingView; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () => api<MappingView>(`/telemetry/mappings/${mapping.id}/reject`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: mapping.version } }),
    () => 'Proposition rejetée : elle ne sera plus proposée pour ce véhicule.',
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Rejeter la proposition</DialogTitle>
          <DialogDescription>
            {mapping.unitLabel} → {mapping.vehicle.code}. L’unité reste listée parmi les unités non associées.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Motif *</Label>
            <Textarea id="reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={mutation.isPending || reason.trim().length < 3}>
              {mutation.isPending ? 'Rejet…' : 'Rejeter'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ignorer une unité volontairement sans véhicule (remorque, boîtier de rechange ; D-249) : plus de
 * proposition ni d'alerte « unité non associée ». Motif obligatoire ; l'API refuse (409) une unité dont
 * l'association est en cours et rejette les propositions en attente.
 */
export function IgnoreUnitDialog({ unit, onClose }: { unit: UnitView; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () => api<UnitView>(`/telemetry/units/${unit.id}/ignore`, { method: 'POST', body: { reason: reason.trim() } }),
    (u) => `Unité « ${u.label} » ignorée : plus de proposition ni d’alerte « unité non associée ».`,
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Ignorer cette unité</DialogTitle>
          <DialogDescription>
            Pour une unité volontairement sans véhicule (remorque, boîtier de rechange…). Elle ne reçoit plus de proposition d’association ni d’alerte « unité non associée » ; les propositions en attente sont rejetées. Vous pourrez cesser de l’ignorer depuis la catégorie « Ignorées ».
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          <MappingSummary unit={unit} vehicle={null} providerName={unit.providerName} isSimulator={unit.isSimulator} />
          <div className="space-y-2">
            <Label htmlFor="ignore-reason">Motif * (remorque, boîtier de rechange…)</Label>
            <Textarea id="ignore-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || reason.trim().length < 3}>
              {mutation.isPending ? 'Enregistrement…' : 'Ignorer l’unité'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Ne plus ignorer une unité (D-249) : elle redevient à associer et son alerte d'information est relevée de nouveau. */
export function UnignoreUnitDialog({ unit, onClose }: { unit: UnitView; onClose: () => void }) {
  const { session } = useAppScope();
  const [reason, setReason] = useState('');
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () => api<UnitView>(`/telemetry/units/${unit.id}/unignore`, { method: 'POST', body: { reason: reason.trim() || undefined } }),
    (u) => `Unité « ${u.label} » de nouveau à associer.`,
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Ne plus ignorer cette unité</DialogTitle>
          <DialogDescription>
            Ignorée le {formatDateTime(unit.ignoredAt, session.timezone)}
            {unit.ignoredReason ? ` : ${unit.ignoredReason}` : ''}. L’unité redevient à associer : la prochaine découverte peut la proposer, et l’alerte « unité non associée » est de nouveau levée tant qu’aucune association n’est confirmée.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          <MappingSummary unit={unit} vehicle={null} providerName={unit.providerName} isSimulator={unit.isSimulator} />
          <div className="space-y-2">
            <Label htmlFor="unignore-reason">Motif (facultatif)</Label>
            <Textarea id="unignore-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Enregistrement…' : 'Ne plus ignorer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Association manuelle confirmée (POST /telemetry/mappings) : depuis une unité non associée (choix du
 * véhicule) ou depuis un véhicule sans unité (choix de l'unité).
 */
export function CreateMappingDialog({ unit, vehicle, onClose }: { unit?: UnitView; vehicle?: VehicleRef; onClose: () => void }) {
  const { session } = useAppScope();
  const [unitId, setUnitId] = useState(unit?.id ?? '');
  const [vehicleId, setVehicleId] = useState(vehicle?.id ?? '');
  const [natures, setNatures] = useState<Natures>(EMPTY_NATURES);
  const [validFrom, setValidFrom] = useState('');
  const effect = zonedInput(validFrom, session.timezone);
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () =>
      api<MappingView>('/telemetry/mappings', {
        method: 'POST',
        body: { unitId, vehicleId, odometerKind: natures.odometerKind, fuelKinds: natures.fuelKinds, validFrom: effect.iso },
      }),
    (m) => `Association confirmée : ${m.unitLabel} → ${m.vehicle.code}.`,
    onClose,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{unit ? 'Associer l’unité à un véhicule' : 'Associer une unité au véhicule'}</DialogTitle>
          <DialogDescription>Association manuelle, confirmée immédiatement par le chef de parc de la société du véhicule. Un véhicule et une unité n’ont qu’une association en cours.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          {unit ? <MappingSummary unit={unit} vehicle={null} providerName={unit.providerName} isSimulator={unit.isSimulator} /> : <UnitPicker value={unitId} onChange={setUnitId} errors={fieldErrors} />}
          {vehicle ? <MappingSummary unit={null} vehicle={vehicle} providerName="" isSimulator={false} /> : <VehiclePicker value={vehicleId} onChange={setVehicleId} errors={fieldErrors} />}
          <NaturesFields idPrefix="create" value={natures} onChange={setNatures} errors={fieldErrors} />
          <ValidFromField id="create-validFrom" value={validFrom} onChange={setValidFrom} errors={withLocalError(fieldErrors, 'validFrom', effect.invalid)} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || !unitId || !vehicleId || natures.odometerKind === '' || effect.invalid}>
              {mutation.isPending ? 'Enregistrement…' : 'Associer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Clôture d'une association et changement de boîtier (D-300) : le kilométrage cumulé n'est jamais
 * modifié ; une valeur CAN inférieure reçue ensuite reste une anomalie à valider.
 */
export function CloseMappingDialog({ mapping, onClose }: { mapping: MappingView; onClose: () => void }) {
  const { session } = useAppScope();
  const [reason, setReason] = useState('');
  const [closedAt, setClosedAt] = useState('');
  const [replace, setReplace] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [natures, setNatures] = useState<Natures>(EMPTY_NATURES);
  const change = zonedInput(closedAt, session.timezone);
  const { mutation, fieldErrors, reset } = useMappingMutation(
    () =>
      api<CloseMappingResult>(`/telemetry/mappings/${mapping.id}/close`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          closedAt: change.iso,
          replacement: replace ? { unitId, odometerKind: natures.odometerKind, fuelKinds: natures.fuelKinds } : undefined,
          expectedVersion: mapping.version,
        },
      }),
    (r) => (r.replacement ? `Boîtier remplacé pour ${r.closed.vehicle.code} : ${r.replacement.unitLabel} associé.` : `Association clôturée pour ${r.closed.vehicle.code}.`),
    onClose,
  );
  const replacementErrors = Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k.startsWith('replacement.') ? k.slice('replacement.'.length) : k, v]));
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Clôturer l’association ou changer de boîtier</DialogTitle>
          <DialogDescription>
            {mapping.unitLabel} → {mapping.vehicle.code}, en vigueur depuis le {formatDateTime(mapping.validFrom, session.timezone)}. Le kilométrage cumulé du véhicule n’est jamais modifié.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            reset();
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="close-reason">Motif * (changement de boîtier, retrait…)</Label>
            <Textarea id="close-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="close-at">Instant du changement</Label>
            <Input id="close-at" type="datetime-local" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} aria-describedby="close-at-hint closedAt-error" />
            <p id="close-at-hint" className="text-xs text-muted-foreground">
              Facultatif (défaut : maintenant). Ni futur, ni antérieur au dernier relevé reçu de l’unité.
            </p>
            <FieldError errors={withLocalError(fieldErrors, 'closedAt', change.invalid)} name="closedAt" />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="close-replace" checked={replace} onCheckedChange={(v) => setReplace(v === true)} className="mt-0.5" />
            <div>
              <Label htmlFor="close-replace" className="font-normal">
                Remplacer par un nouveau boîtier
              </Label>
              <p className="text-xs text-muted-foreground">La nouvelle association est confirmée à partir du même instant ; en DISTANCE_GPS, les estimations reprennent au prochain relevé manuel.</p>
            </div>
          </div>
          {replace ? (
            <div className="space-y-4 rounded-md border p-3">
              <UnitPicker value={unitId} onChange={setUnitId} excludeUnitId={mapping.unitId} errors={replacementErrors} />
              <NaturesFields idPrefix="replace" value={natures} onChange={setNatures} errors={replacementErrors} />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant={replace ? 'default' : 'destructive'} disabled={mutation.isPending || reason.trim().length < 3 || change.invalid || (replace && (!unitId || natures.odometerKind === ''))}>
              {mutation.isPending ? 'Enregistrement…' : replace ? 'Changer de boîtier' : 'Clôturer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
