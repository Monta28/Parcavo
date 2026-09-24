'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { NONE, type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { EMPTY_PLACE, PlaceFields, type PlaceValue, placeCreateBody, placeLabel, placeLocalErrors } from '@/components/incidents/place-fields';
import { useAppScope } from '@/components/layout/session-context';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { ImmobilizationView } from '@/lib/immobilizations-types';
import type { IncidentImmobilizeResult, IncidentInterventionRef, IncidentView } from '@/lib/incidents-types';
import type { SupplierView } from '@/lib/suppliers-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { useIncidentCache } from './incident-cache';

// Ouvrir une intervention ----------------------------------------------------------------------

/**
 * « Ouvrir une intervention » (POST /incidents/:id/intervention) : intervention corrective par défaut,
 * rattachée à l'incident, puis redirection vers sa fiche (/interventions/:id).
 */
export function OpenInterventionDialog({ incident, onOpenChange }: { incident: IncidentView; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'CORRECTIF' | 'PREVENTIF'>('CORRECTIF');
  const [supplierId, setSupplierId] = useState(NONE);
  const [plannedStartAt, setPlannedStartAt] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const garages = useQuery({
    queryKey: ['suppliers', 'garages', incident.companyId],
    queryFn: () => api<Page<SupplierView>>(`/suppliers${toQuery({ companyId: incident.companyId, category: 'GARAGE', status: 'ACTIF', pageSize: 100 })}`),
  });
  const open = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentInterventionRef>(`/incidents/${incident.id}/intervention`, { method: 'POST', body }),
    onSuccess: (created) => {
      toast.success(`Intervention ${created.reference} ouverte depuis l’incident.`);
      void queryClient.invalidateQueries({ queryKey: ['incident', incident.id] });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['interventions'] });
      router.push(`/interventions/${created.id}`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Ouverture de l’intervention impossible.'),
  });
  const errors = { ...errorsOf(open.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !open.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ouvrir une intervention</DialogTitle>
          <DialogDescription>
            L’intervention est créée pour {incident.vehicleCode} et rattachée à l’incident {incident.reference}. Sans travaux précisés, une tâche « Traitement de l’incident » est proposée ; vous compléterez la fiche de l’intervention ensuite.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            const plannedIso = plannedStartAt ? localInputToIso(plannedStartAt, session.timezone) : null;
            if (plannedStartAt && !plannedIso) next.plannedStartAt = ['Date et heure invalides.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            open.mutate({
              kind,
              supplierId: supplierId !== NONE ? supplierId : undefined,
              plannedStartAt: plannedIso ?? undefined,
              diagnosis: diagnosis.trim() || undefined,
            });
          }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Nature</legend>
            <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'CORRECTIF' | 'PREVENTIF')} className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="intervention-kind-correctif" value="CORRECTIF" />
                <Label htmlFor="intervention-kind-correctif" className="font-normal">
                  Corrective (réparation)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="intervention-kind-preventif" value="PREVENTIF" />
                <Label htmlFor="intervention-kind-preventif" className="font-normal">
                  Préventive
                </Label>
              </div>
            </RadioGroup>
            <FieldError errors={errors} name="kind" />
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="intervention-supplier">Garage</Label>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger id="intervention-supplier" className="w-full" aria-invalid={invalid(errors, 'supplierId')} aria-describedby={describedBy(errors, 'supplierId')}>
                <SelectValue placeholder={garages.isPending ? 'Chargement…' : 'Aucun'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Non choisi pour l’instant</SelectItem>
                {(garages.data?.items ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={errors} name="supplierId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="intervention-planned">Début prévu</Label>
            <Input id="intervention-planned" type="datetime-local" value={plannedStartAt} onChange={(e) => setPlannedStartAt(e.target.value)} aria-invalid={invalid(errors, 'plannedStartAt')} aria-describedby={describedBy(errors, 'plannedStartAt', 'intervention-planned-hint')} />
            <p id="intervention-planned-hint" className="text-xs text-muted-foreground">
              Facultatif. Planifier ne signifie pas exécuter.
            </p>
            <FieldError errors={errors} name="plannedStartAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="intervention-diagnosis">Diagnostic</Label>
            <Textarea id="intervention-diagnosis" rows={3} maxLength={4000} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} aria-describedby={describedBy(errors, 'diagnosis', 'intervention-diagnosis-hint')} />
            <p id="intervention-diagnosis-hint" className="text-xs text-muted-foreground">
              Facultatif : la description de l’incident est reprise si ce champ reste vide.
            </p>
            <FieldError errors={errors} name="diagnosis" />
          </div>
          {open.error ? <ApiErrorAlert error={open.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={open.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={open.isPending}>
              {open.isPending ? 'Création…' : 'Ouvrir l’intervention'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Immobiliser ----------------------------------------------------------------------------------

/**
 * « Immobiliser le véhicule » (POST /incidents/:id/immobilize) : cause INCIDENT ajoutée à l'immobilisation
 * active du véhicule ou nouvelle immobilisation, dont l'identifiant est renvoyé. Le lieu et la fin prévue
 * saisis s'appliquent à cette immobilisation, y compris si elle était déjà active (annoncé avant l'envoi).
 * Début jamais futur (maintenant par défaut).
 */
export function ImmobilizeIncidentDialog({ incident, onOpenChange }: { incident: IncidentView; onOpenChange: (open: boolean) => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const cache = useIncidentCache(incident.id);
  const active = useQuery({
    queryKey: ['immobilizations', 'vehicle', incident.vehicleId, 'active'],
    queryFn: () => api<Page<ImmobilizationView>>(`/immobilizations${toQuery({ vehicleId: incident.vehicleId, status: 'ACTIVE', pageSize: 1 })}`),
  });
  const current = active.data?.items[0] ?? null;
  const [reason, setReason] = useState(() => `Incident ${incident.reference}`);
  const [startedAt, setStartedAt] = useState(() => nowLocalInput(session.timezone));
  const [expectedEndAt, setExpectedEndAt] = useState('');
  const [place, setPlace] = useState<PlaceValue>(EMPTY_PLACE);
  const [local, setLocal] = useState<FieldErrors>({});
  const immobilize = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentImmobilizeResult>(`/incidents/${incident.id}/immobilize`, { method: 'POST', body }),
    onSuccess: (result) => {
      const updated = result.incident;
      const applied = [result.placeApplied ? 'lieu' : null, result.expectedEndApplied ? 'fin prévue' : null].filter(Boolean).join(' et ');
      cache.saved(
        updated,
        result.created
          ? `Véhicule ${updated.vehicleCode} immobilisé pour l’incident ${updated.reference}.`
          : `Cause ajoutée à l’immobilisation active de ${updated.vehicleCode}${applied ? ` ; ${applied} mis à jour` : ''}.`,
      );
      // La fiche de l'immobilisation créée ou complétée est rechargée ; la section « Immobilisations liées » y mène.
      void queryClient.invalidateQueries({ queryKey: ['immobilization', result.immobilizationId] });
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Immobilisation impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(immobilize.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !immobilize.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Immobiliser le véhicule {incident.vehicleCode}</DialogTitle>
          <DialogDescription>
            Une cause « incident » est ajoutée à l’immobilisation active du véhicule, ou une nouvelle immobilisation est ouverte. Le lieu et la fin prévue saisis s’appliquent à cette immobilisation. La disponibilité est rétablie seulement après la fin de toutes les causes.
          </DialogDescription>
        </DialogHeader>
        {current ? (
          <div role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">Immobilisation déjà active depuis le {formatDateTime(current.startedAt, session.timezone)}</p>
            <p className="text-muted-foreground">
              Lieu : {placeLabel(current)} · Fin prévue : {current.expectedEndAt ? formatDateTime(current.expectedEndAt, session.timezone) : 'non renseignée'}. La cause y sera ajoutée ; un lieu ou une fin prévue saisis ici remplaceront ces valeurs.
            </p>
          </div>
        ) : null}
        {active.isError ? <p className="text-sm text-muted-foreground">Immobilisation active du véhicule non vérifiée : le serveur indiquera si la cause complète une immobilisation existante.</p> : null}
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = { ...placeLocalErrors(place) };
            const startIso = localInputToIso(startedAt, session.timezone);
            const endIso = expectedEndAt ? localInputToIso(expectedEndAt, session.timezone) : null;
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            if (!startIso) next.startedAt = ['Indiquez la date et l’heure de début.'];
            if (expectedEndAt && !endIso) next.expectedEndAt = ['Date et heure invalides.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            immobilize.mutate({ reason: reason.trim(), startedAt: startIso ?? undefined, expectedEndAt: endIso ?? undefined, ...placeCreateBody(place) });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="immobilize-reason">Motif *</Label>
            <Textarea id="immobilize-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="immobilize-start">Début *</Label>
              <Input id="immobilize-start" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} aria-invalid={invalid(errors, 'startedAt')} aria-describedby={describedBy(errors, 'startedAt', 'immobilize-tz')} />
              <FieldError errors={errors} name="startedAt" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="immobilize-end">Fin prévue</Label>
              <Input id="immobilize-end" type="datetime-local" value={expectedEndAt} min={startedAt || undefined} onChange={(e) => setExpectedEndAt(e.target.value)} aria-invalid={invalid(errors, 'expectedEndAt')} aria-describedby={describedBy(errors, 'expectedEndAt', 'immobilize-tz')} />
              <FieldError errors={errors} name="expectedEndAt" />
            </div>
          </div>
          <p id="immobilize-tz" className="text-xs text-muted-foreground">
            Heures dans le fuseau de l’organisation ({session.timezone}). Une immobilisation ne commence jamais dans le futur : planifiez plutôt une intervention.
          </p>
          <PlaceFields idPrefix="immobilize" companyId={incident.companyId} value={place} onChange={setPlace} errors={errors} />
          {immobilize.error ? <ApiErrorAlert error={immobilize.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={immobilize.isPending}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={immobilize.isPending}>
              {immobilize.isPending ? 'Enregistrement…' : 'Immobiliser'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Lien explicite avec un conducteur (contravention) --------------------------------------------

/**
 * Lien explicite du dossier avec le conducteur de l'utilisation en cours à l'instant déclaré
 * (PATCH driverId, chef de parc ou administrateur) : information de suivi, jamais une responsabilité.
 */
export function LinkDriverDialog({ incident, driverId, driverName, onOpenChange }: { incident: IncidentView; driverId: string; driverName: string; onOpenChange: (open: boolean) => void }) {
  const cache = useIncidentCache(incident.id);
  const link = useMutation({
    mutationFn: () => api<IncidentView>(`/incidents/${incident.id}`, { method: 'PATCH', body: { driverId, expectedVersion: incident.version } }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Conducteur lié au dossier.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Lien impossible.')) onOpenChange(false);
    },
  });
  return (
    <AlertDialog open onOpenChange={(o) => !link.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Lier {driverName} au dossier ?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Ce lien est une information de suivi posée explicitement : il ne désigne aucun responsable et n’entraîne aucune retenue.</p>
              {incident.driverName ? <p>Le conducteur actuellement lié ({incident.driverName}) sera remplacé.</p> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {link.error ? <ApiErrorAlert error={link.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={link.isPending}>Annuler</AlertDialogCancel>
          <Button type="button" disabled={link.isPending} onClick={() => link.mutate()}>
            {link.isPending ? 'Enregistrement…' : 'Lier le conducteur'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
