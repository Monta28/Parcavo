'use client';

import { useMutation } from '@tanstack/react-query';
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
import { type AssignmentView, RESPONSIBLE_REMINDER } from '@/lib/assignments-types';
import { formatDateTime } from '@/lib/format';
import { isoToLocalInput, localInputToIso } from '@/lib/zoned-time';
import { DriverSummaryPicker } from '../../planning/entity-pickers';

type FieldErrors = Record<string, string[]>;

/**
 * Modification d'une affectation habituelle (PATCH /responsible-assignments/:id, CDC 15.2) : seuls les champs
 * que l'API déclare modifiables (editableFields) sont proposés ; motif obligatoire et version affichée envoyée
 * (409 si l'affectation a changé entre-temps). Seuls les champs réellement modifiés sont transmis.
 */
export function EditAssignmentDialog({ assignment, onClose, onSaved, onConflict }: { assignment: AssignmentView; onClose: () => void; onSaved: (updated: AssignmentView) => void; onConflict: () => void }) {
  const session = useSession();
  const editable = new Set(assignment.editableFields);
  const [driverId, setDriverId] = useState(assignment.driverId);
  const [startsAt, setStartsAt] = useState(() => isoToLocalInput(assignment.startsAt, session.timezone));
  const [noEnd, setNoEnd] = useState(assignment.endsAt === null);
  const [endsAt, setEndsAt] = useState(() => (assignment.endsAt ? isoToLocalInput(assignment.endsAt, session.timezone) : ''));
  const [notes, setNotes] = useState(assignment.notes ?? '');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AssignmentView>(`/responsible-assignments/${assignment.id}`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      toast.success(`Affectation de ${updated.driverName} modifiée.`);
      onSaved(updated);
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète, chevauchement ou affectation terminée entre-temps : l'historique est rechargé.
        if (error.status === 409) onConflict();
      } else toast.error('Modification impossible.');
    },
  });

  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    const body: Record<string, unknown> = {};
    if (editable.has('driverId') && driverId !== assignment.driverId) {
      if (!driverId) local.driverId = ['Choisissez le conducteur responsable.'];
      else body.driverId = driverId;
    }
    if (editable.has('startsAt')) {
      const iso = localInputToIso(startsAt, session.timezone);
      if (!iso) local.startsAt = ['Indiquez la date et l’heure de début.'];
      else if (new Date(iso).getTime() !== new Date(assignment.startsAt).getTime()) body.startsAt = iso;
    }
    if (editable.has('endsAt')) {
      if (noEnd) {
        if (assignment.endsAt !== null) body.endsAt = null;
      } else {
        const iso = endsAt ? localInputToIso(endsAt, session.timezone) : undefined;
        if (!iso) local.endsAt = ['Indiquez la fin prévue, ou cochez « sans fin prévue ».'];
        else if (assignment.endsAt === null || new Date(iso).getTime() !== new Date(assignment.endsAt).getTime()) body.endsAt = iso;
      }
    }
    if (editable.has('notes') && notes.trim() !== (assignment.notes ?? '')) body.notes = notes.trim() || null;
    if (reason.trim().length < 3) local.reason = ['Motif obligatoire (3 caractères minimum).'];
    if (Object.keys(local).length === 0 && Object.keys(body).length === 0) local.reason = ['Aucune modification à enregistrer.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    save.mutate({ ...body, reason: reason.trim(), expectedVersion: assignment.version });
  }

  const stale = isApiError(save.error) && save.error.code === 'VERSION_OBSOLETE';

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Modifier l’affectation de {assignment.driverName}</DialogTitle>
          <DialogDescription>
            {RESPONSIBLE_REMINDER}{' '}
            {assignment.status === 'EN_COURS'
              ? `Affectation en cours depuis le ${formatDateTime(assignment.startsAt, session.timezone)} : seules la fin prévue et les notes se modifient ; pour confier le véhicule à un autre responsable, nommez-le avec un remplacement explicite.`
              : 'Affectation à venir : responsable, période et notes sont modifiables avec les contrôles de la nomination.'}{' '}
            La modification est journalisée avec son motif.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={submit}>
          {editable.has('driverId') ? (
            <div className="space-y-2">
              <Label htmlFor="edit-assignment-driver">Conducteur responsable *</Label>
              <DriverSummaryPicker id="edit-assignment-driver" value={driverId} onChange={setDriverId} companyId={assignment.companyId} invalid={invalid('driverId')} describedBy="driverId-error" modal />
              <FieldError errors={fieldErrors} name="driverId" />
            </div>
          ) : null}
          {editable.has('startsAt') ? (
            <div className="space-y-2">
              <Label htmlFor="edit-assignment-start">Début de la responsabilité *</Label>
              <Input id="edit-assignment-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-invalid={invalid('startsAt')} aria-describedby="startsAt-error" />
              <FieldError errors={fieldErrors} name="startsAt" />
            </div>
          ) : null}
          {editable.has('endsAt') ? (
            <div className="space-y-2">
              <Label htmlFor="edit-assignment-end">Fin prévue</Label>
              <Input id="edit-assignment-end" type="datetime-local" value={endsAt} disabled={noEnd} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={invalid('endsAt')} aria-describedby="edit-assignment-end-hint endsAt-error" />
              <div className="flex items-center gap-2">
                <Checkbox id="edit-assignment-no-end" checked={noEnd} onCheckedChange={(v) => setNoEnd(v === true)} />
                <Label htmlFor="edit-assignment-no-end" className="font-normal">
                  Sans fin prévue
                </Label>
              </div>
              <p id="edit-assignment-end-hint" className="text-xs text-muted-foreground">
                Une fin prévue est future ; pour terminer l’affectation maintenant, utilisez « Terminer l’affectation ».
              </p>
              <FieldError errors={fieldErrors} name="endsAt" />
            </div>
          ) : null}
          {editable.has('notes') ? (
            <div className="space-y-2">
              <Label htmlFor="edit-assignment-notes">Notes</Label>
              <Textarea id="edit-assignment-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={invalid('notes')} aria-describedby="notes-error" />
              <FieldError errors={fieldErrors} name="notes" />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="edit-assignment-reason">Motif de la modification * (3 caractères minimum)</Label>
            <Textarea id="edit-assignment-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid('reason')} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          {save.error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">{isApiError(save.error) ? save.error.message : 'Une erreur est survenue : rien n’a été enregistré.'}</p>
              {stale ? <p className="mt-1 text-muted-foreground">L’historique a été rechargé : fermez ce dialogue et recommencez sur l’affectation à jour.</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || stale}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer la modification'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
