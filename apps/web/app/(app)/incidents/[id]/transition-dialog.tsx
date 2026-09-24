'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, type OpsRights, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { IncidentStatus, IncidentView } from '@/lib/incidents-types';
import { useIncidentCache } from './incident-cache';

export interface TransitionAction {
  key: string;
  to: IncidentStatus;
  label: string;
  title: string;
  description: string;
  note: 'required' | 'optional';
  noteLabel: string;
  success: string;
  destructive?: boolean;
}

const TAKE: TransitionAction = {
  key: 'take',
  to: 'EN_TRAITEMENT',
  label: 'Prendre en charge',
  title: 'Prendre en charge l’incident',
  description: 'L’incident passe « En traitement ». Une alerte « incident critique non traité » éventuelle est résolue.',
  note: 'optional',
  noteLabel: 'Commentaire interne (facultatif)',
  success: 'Incident pris en charge.',
};
const RESOLVE: TransitionAction = {
  key: 'resolve',
  to: 'RESOLU',
  label: 'Résoudre',
  title: 'Résoudre l’incident',
  description: 'Résolution technique : le problème est traité. La clôture administrative reste une étape distincte, réservée au chef de parc ou à l’administrateur.',
  note: 'required',
  noteLabel: 'Note de résolution *',
  success: 'Incident résolu.',
};
const CLOSE_WITHOUT_ACTION: TransitionAction = {
  key: 'close-no-action',
  to: 'CLOTURE',
  label: 'Clôturer sans suite',
  title: 'Clôturer l’incident sans suite',
  description: 'Classement « sans suite » d’un incident ouvert : le motif est obligatoire et conservé dans l’historique. Seul l’administrateur peut rouvrir un incident clôturé.',
  note: 'required',
  noteLabel: 'Motif du classement sans suite *',
  success: 'Incident clôturé sans suite.',
  destructive: true,
};
const CLOSE: TransitionAction = {
  key: 'close',
  to: 'CLOTURE',
  label: 'Clôturer',
  title: 'Clôture administrative',
  description: 'La clôture est refusée tant qu’une intervention issue de l’incident ou une cause d’immobilisation liée reste ouverte. Seul l’administrateur peut rouvrir un incident clôturé.',
  note: 'optional',
  noteLabel: 'Note de clôture (facultatif)',
  success: 'Incident clôturé.',
  destructive: true,
};
const REOPEN: TransitionAction = {
  key: 'reopen',
  to: 'EN_TRAITEMENT',
  label: 'Rouvrir',
  title: 'Rouvrir l’incident',
  description: 'L’incident résolu repasse « En traitement ». Le motif est obligatoire et conservé dans l’historique.',
  note: 'required',
  noteLabel: 'Motif de réouverture *',
  success: 'Incident rouvert.',
};
const REOPEN_CLOSED: TransitionAction = {
  key: 'reopen-closed',
  to: 'EN_TRAITEMENT',
  label: 'Rouvrir',
  title: 'Rouvrir un incident clôturé',
  description: 'Action réservée à l’administrateur : l’incident clôturé repasse « En traitement ». Le motif est obligatoire et conservé dans l’historique.',
  note: 'required',
  noteLabel: 'Motif de réouverture *',
  success: 'Incident rouvert.',
};

/** Actions proposées selon le statut et le rôle (D-215) ; l'API reste seule juge de chaque transition. */
export function transitionsFor(status: IncidentStatus, rights: OpsRights): TransitionAction[] {
  switch (status) {
    case 'OUVERT':
      return [...(rights.operational ? [TAKE, RESOLVE] : []), ...(rights.manager ? [CLOSE_WITHOUT_ACTION] : [])];
    case 'EN_TRAITEMENT':
      return rights.operational ? [RESOLVE] : [];
    case 'RESOLU':
      return rights.manager ? [CLOSE, REOPEN] : [];
    case 'CLOTURE':
      return rights.admin ? [REOPEN_CLOSED] : [];
    default:
      return [];
  }
}

function blockers(details: Record<string, unknown> | undefined): { interventions: number; causes: number } | null {
  if (!details) return null;
  const interventions = typeof details.openInterventions === 'number' ? details.openInterventions : 0;
  const causes = typeof details.openCauses === 'number' ? details.openCauses : 0;
  return interventions > 0 || causes > 0 ? { interventions, causes } : null;
}

/** Transition POST /incidents/:id/transition avec note ou motif, verrou optimiste (expectedVersion). */
export function TransitionDialog({ incident, action, onOpenChange }: { incident: IncidentView; action: TransitionAction; onOpenChange: (open: boolean) => void }) {
  const cache = useIncidentCache(incident.id);
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const mutation = useMutation({
    mutationFn: () => api<IncidentView>(`/incidents/${incident.id}/transition`, { method: 'POST', body: { to: action.to, note: note.trim() || undefined, expectedVersion: incident.version } }),
    onSuccess: (updated) => {
      cache.saved(updated, action.success);
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Transition impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(mutation.error), ...local };
  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const blocked = apiError?.code === 'CLOTURE_IMPOSSIBLE' ? blockers(apiError.details) : null;

  return (
    <Dialog open onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          <DialogDescription>{action.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = note.trim();
            const next: FieldErrors = {};
            if (action.note === 'required' && trimmed.length < 3) next.note = ['Saisissez au moins 3 caractères.'];
            else if (trimmed.length > 0 && trimmed.length < 3) next.note = ['Saisissez au moins 3 caractères ou laissez vide.'];
            setLocal(next);
            if (Object.keys(next).length === 0) mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="transition-note">{action.noteLabel}</Label>
            <Textarea id="transition-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={invalid(errors, 'note')} aria-describedby={describedBy(errors, 'note', 'transition-note-hint')} />
            <p id="transition-note-hint" className="text-xs text-muted-foreground">
              La note est ajoutée aux commentaires internes de l’incident.
            </p>
            <FieldError errors={errors} name="note" />
          </div>
          {mutation.error && !errors.note ? (
            <ApiErrorAlert error={mutation.error}>
              {blocked ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {blocked.interventions > 0 ? <li>Interventions encore ouvertes : {blocked.interventions}</li> : null}
                  {blocked.causes > 0 ? <li>Causes d’immobilisation encore ouvertes : {blocked.causes}</li> : null}
                </ul>
              ) : null}
            </ApiErrorAlert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Annuler
            </Button>
            <Button type="submit" variant={action.destructive ? 'destructive' : 'default'} disabled={mutation.isPending}>
              {mutation.isPending ? 'Enregistrement…' : action.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
