'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { InterventionView } from '@/lib/interventions-types';
import { isoToLocalInput, localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { ApiErrorAlert } from '../form-parts';
import { type FieldErrors, describedBy } from '../intervention-helpers';

/** Mise à jour du cache après une action réussie, rechargement de la fiche sur conflit (409). */
export function useInterventionCache(interventionId: string) {
  const queryClient = useQueryClient();
  return {
    saved(updated: InterventionView, message: string) {
      toast.success(message);
      queryClient.setQueryData(['intervention', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['interventions'] });
      void queryClient.invalidateQueries({ queryKey: ['immobilizations'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', updated.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
      if (updated.incidentId) void queryClient.invalidateQueries({ queryKey: ['incident', updated.incidentId] });
    },
    failed(error: unknown, fallback: string) {
      toast.error(isApiError(error) ? error.message : fallback);
      // Version obsolète ou état changé : la fiche est rechargée, un nouvel envoi part de la version courante.
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['intervention', interventionId] });
        if (error.code === 'VERSION_OBSOLETE') toast.info('La fiche a été rechargée avec la version courante : vérifiez puis relancez l’action.');
      }
    },
  };
}

function errorsOf(error: unknown): FieldErrors {
  return isApiError(error) ? error.fieldErrors : {};
}

// Planifier -----------------------------------------------------------------------------------

/** Planifier (POST :id/plan) : enregistre les dates prévues ; aucun travail n'est considéré exécuté. */
export function PlanDialog({ intervention, onOpenChange }: { intervention: InterventionView; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const cache = useInterventionCache(intervention.id);
  const [start, setStart] = useState(() => isoToLocalInput(intervention.plannedStartAt, session.timezone));
  const [end, setEnd] = useState(() => isoToLocalInput(intervention.plannedEndAt, session.timezone));
  const [local, setLocal] = useState<FieldErrors>({});
  const plan = useMutation({
    mutationFn: () =>
      api<InterventionView>(`/interventions/${intervention.id}/plan`, {
        method: 'POST',
        body: { plannedStartAt: localInputToIso(start, session.timezone), plannedEndAt: end ? (localInputToIso(end, session.timezone) ?? undefined) : undefined, expectedVersion: intervention.version },
      }),
    onSuccess: (updated) => {
      cache.saved(updated, `Intervention ${updated.reference} planifiée.`);
      onOpenChange(false);
    },
    onError: (error) => cache.failed(error, 'Planification impossible.'),
  });
  const errors = { ...errorsOf(plan.error), ...local };
  const replan = intervention.status === 'PLANIFIEE';

  return (
    <Dialog open onOpenChange={(o) => !plan.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{replan ? 'Replanifier l’intervention' : 'Planifier l’intervention'}</DialogTitle>
          <DialogDescription>Planifier ne signifie pas exécuter : seules les dates prévues sont enregistrées. L’intervention devra ensuite être démarrée puis terminée avec sa date effective.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (!start || !localInputToIso(start, session.timezone)) next.plannedStartAt = ['Indiquez la date et l’heure de début prévues.'];
            if (end && !localInputToIso(end, session.timezone)) next.plannedEndAt = ['Date et heure invalides.'];
            setLocal(next);
            if (Object.keys(next).length === 0) plan.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="plan-start">Début prévu *</Label>
            <Input id="plan-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={Boolean(errors.plannedStartAt?.length) || undefined} aria-describedby={describedBy(errors, 'plannedStartAt', 'plan-tz')} />
            <FieldError errors={errors} name="plannedStartAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plan-end">Fin prévue</Label>
            <Input id="plan-end" type="datetime-local" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} aria-invalid={Boolean(errors.plannedEndAt?.length) || undefined} aria-describedby={describedBy(errors, 'plannedEndAt', 'plan-tz')} />
            <FieldError errors={errors} name="plannedEndAt" />
          </div>
          <p id="plan-tz" className="text-xs text-muted-foreground">
            Heures dans le fuseau de l’organisation ({session.timezone}).
          </p>
          <ApiErrorAlert error={plan.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={plan.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={plan.isPending}>
              {plan.isPending ? 'Enregistrement…' : replan ? 'Replanifier' : 'Planifier'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Démarrer ------------------------------------------------------------------------------------

/**
 * Démarrer (POST :id/start) : immobilisation explicite (D-205), case non cochée par défaut, cochée
 * quand l'intervention provient d'un incident ; le motif est alors obligatoire.
 */
export function StartDialog({ intervention, onOpenChange }: { intervention: InterventionView; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const cache = useInterventionCache(intervention.id);
  const [startedAt, setStartedAt] = useState(() => nowLocalInput(session.timezone));
  const [immobilize, setImmobilize] = useState(Boolean(intervention.incidentId));
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const start = useMutation({
    mutationFn: () =>
      api<InterventionView>(`/interventions/${intervention.id}/start`, {
        method: 'POST',
        body: {
          startedAt: localInputToIso(startedAt, session.timezone),
          immobilize,
          immobilizationReason: immobilize ? reason.trim() : undefined,
          expectedVersion: intervention.version,
        },
      }),
    onSuccess: (updated) => {
      cache.saved(updated, immobilize ? `Intervention ${updated.reference} démarrée ; véhicule ${updated.vehicleCode} immobilisé.` : `Intervention ${updated.reference} démarrée.`);
      onOpenChange(false);
    },
    onError: (error) => cache.failed(error, 'Démarrage impossible.'),
  });
  const errors = { ...errorsOf(start.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !start.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Démarrer l’intervention {intervention.reference}</DialogTitle>
          <DialogDescription>L’intervention passe « en cours ». L’immobilisation du véhicule n’est jamais automatique : cochez la case pour la déclarer.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (!localInputToIso(startedAt, session.timezone)) next.startedAt = ['Indiquez la date et l’heure réelles de début.'];
            if (immobilize && reason.trim().length < 3) next.immobilizationReason = ['Motif de l’immobilisation requis (3 caractères minimum).'];
            setLocal(next);
            if (Object.keys(next).length === 0) start.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="start-at">Début réel *</Label>
            <Input id="start-at" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} aria-invalid={Boolean(errors.startedAt?.length) || undefined} aria-describedby={describedBy(errors, 'startedAt', 'start-at-hint')} />
            <p id="start-at-hint" className="text-xs text-muted-foreground">
              Fuseau de l’organisation ({session.timezone}) ; une date future est refusée.
            </p>
            <FieldError errors={errors} name="startedAt" />
          </div>
          <div className="space-y-1">
            <div className="flex items-start gap-2">
              <Checkbox id="start-immobilize" checked={immobilize} onCheckedChange={(v) => setImmobilize(v === true)} className="mt-0.5" aria-describedby="start-immobilize-hint" />
              <Label htmlFor="start-immobilize" className="font-normal">
                Immobiliser le véhicule {intervention.vehicleCode}
              </Label>
            </div>
            <p id="start-immobilize-hint" className="pl-6 text-xs text-muted-foreground">
              {intervention.incidentId ? 'Cochée par défaut : l’intervention provient d’un incident. ' : ''}Le véhicule reste indisponible jusqu’à la fin de cette cause (proposée à la clôture ou à l’annulation).
            </p>
          </div>
          {immobilize ? (
            <div className="space-y-2">
              <Label htmlFor="start-reason">Motif de l’immobilisation *</Label>
              <Textarea
                id="start-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={Boolean(errors.immobilizationReason?.length) || undefined}
                aria-describedby={describedBy(errors, 'immobilizationReason')}
              />
              <FieldError errors={errors} name="immobilizationReason" />
            </div>
          ) : null}
          <ApiErrorAlert error={start.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={start.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? 'Démarrage…' : 'Démarrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Annuler / Rouvrir ---------------------------------------------------------------------------

function ReasonDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  destructive,
  endImmobilizationOption,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** « available » : cause ouverte liée, case cochée par défaut ; « none » : case affichée mais sans objet ; « hidden » : sans case. */
  endImmobilizationOption: 'available' | 'none' | 'hidden';
  pending: boolean;
  error: unknown;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { reason: string; endImmobilization?: boolean }) => void;
}) {
  const [reason, setReason] = useState('');
  const [endImmobilization, setEndImmobilization] = useState(endImmobilizationOption === 'available');
  const [local, setLocal] = useState<FieldErrors>({});
  const errors = { ...errorsOf(error), ...local };
  return (
    <Dialog open onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = reason.trim().length < 3 ? { reason: ['Motif obligatoire (3 caractères minimum).'] } : {};
            setLocal(next);
            if (Object.keys(next).length === 0) onSubmit({ reason: reason.trim(), ...(endImmobilizationOption === 'available' ? { endImmobilization } : {}) });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="action-reason">Motif *</Label>
            <Textarea id="action-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason?.length) || undefined} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          {endImmobilizationOption !== 'hidden' ? (
            <div className="space-y-1">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="action-end-immobilization"
                  checked={endImmobilization}
                  disabled={endImmobilizationOption === 'none'}
                  onCheckedChange={(v) => setEndImmobilization(v === true)}
                  className="mt-0.5"
                  aria-describedby="action-end-immobilization-hint"
                />
                <Label htmlFor="action-end-immobilization" className="font-normal">
                  Mettre fin à la cause d’immobilisation liée
                </Label>
              </div>
              <p id="action-end-immobilization-hint" className="pl-6 text-xs text-muted-foreground">
                {endImmobilizationOption === 'none' ? 'Aucune cause d’immobilisation ouverte n’est liée à cette intervention.' : 'Le véhicule redevient disponible s’il n’a pas d’autre cause d’immobilisation ouverte.'}
              </p>
            </div>
          ) : null}
          <ApiErrorAlert error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Retour
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Annuler (POST :id/cancel) : motif obligatoire, fin de la cause d'immobilisation liée proposée. */
export function CancelDialog({ intervention, onOpenChange }: { intervention: InterventionView; onOpenChange: (open: boolean) => void }) {
  const cache = useInterventionCache(intervention.id);
  const cancel = useMutation({
    mutationFn: (input: { reason: string; endImmobilization?: boolean }) => api<InterventionView>(`/interventions/${intervention.id}/cancel`, { method: 'POST', body: { ...input, expectedVersion: intervention.version } }),
    onSuccess: (updated) => {
      cache.saved(updated, `Intervention ${updated.reference} annulée.`);
      onOpenChange(false);
    },
    onError: (error) => cache.failed(error, 'Annulation impossible.'),
  });
  return (
    <ReasonDialog
      title={`Annuler l’intervention ${intervention.reference} ?`}
      description={<p>L’intervention sera marquée « annulée » avec votre motif ; elle reste consultable et n’est pas supprimée. Aucun plan d’entretien n’est mis à jour.</p>}
      confirmLabel="Annuler l’intervention"
      pendingLabel="Annulation…"
      destructive
      endImmobilizationOption={intervention.openImmobilizationCauseId ? 'available' : 'none'}
      pending={cancel.isPending}
      error={cancel.error}
      onOpenChange={onOpenChange}
      onSubmit={(input) => cancel.mutate(input)}
    />
  );
}

/** Rouvrir (POST :id/reopen) : chef de parc ou administrateur, motif obligatoire et audité. */
export function ReopenDialog({ intervention, onOpenChange }: { intervention: InterventionView; onOpenChange: (open: boolean) => void }) {
  const cache = useInterventionCache(intervention.id);
  const reopen = useMutation({
    mutationFn: (input: { reason: string }) => api<InterventionView>(`/interventions/${intervention.id}/reopen`, { method: 'POST', body: { reason: input.reason, expectedVersion: intervention.version } }),
    onSuccess: (updated) => {
      cache.saved(updated, `Intervention ${updated.reference} rouverte.`);
      onOpenChange(false);
    },
    onError: (error) => cache.failed(error, 'Réouverture impossible.'),
  });
  return (
    <ReasonDialog
      title={`Rouvrir l’intervention ${intervention.reference} ?`}
      description={
        <>
          <p className="font-medium text-foreground">La dépense liée sera annulée et les échéances recalculées.</p>
          <p>
            L’intervention repasse « en cours » avec un coût à saisir : ses lignes pièces / main-d’œuvre et son total sont annulés avec la dépense (valeurs conservées dans l’audit) et se ressaisissent à la nouvelle clôture. Les bases des plans sont recalculées sans elle. La
            réouverture est motivée et tracée dans l’audit.
          </p>
        </>
      }
      confirmLabel="Rouvrir"
      pendingLabel="Réouverture…"
      destructive
      endImmobilizationOption="hidden"
      pending={reopen.isPending}
      error={reopen.error}
      onOpenChange={onOpenChange}
      onSubmit={(input) => reopen.mutate(input)}
    />
  );
}
