'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { type AssignmentView, assignmentState, RESPONSIBLE_REMINDER } from '@/lib/assignments-types';
import { formatDateTime } from '@/lib/format';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { DriverSummaryPicker } from '../../planning/entity-pickers';
import { EditAssignmentDialog } from './edit-assignment-dialog';

type FieldErrors = Record<string, string[]>;

const assignmentsKey = (vehicleId: string) => ['responsible-assignments', 'vehicle', vehicleId] as const;

/**
 * Responsable habituel du véhicule (CDC 4.1) : historique (GET /responsible-assignments?vehicleId=),
 * nomination (POST /responsible-assignments), modification motivée (PATCH /responsible-assignments/:id) et fin
 * motivée (POST /responsible-assignments/:id/end).
 * Les chevauchements sont refusés par l'API (409) ; le remplacement du responsable en cours est explicite.
 */
export function AssignmentsPanel({ vehicleId, companyId, canManage }: { vehicleId: string; companyId: string; canManage: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const assignments = useQuery({ queryKey: assignmentsKey(vehicleId), queryFn: () => api<AssignmentView[]>(`/responsible-assignments${toQuery({ vehicleId })}`) });
  const [assignOpen, setAssignOpen] = useState(false);
  // Nouvelle instance du formulaire à chaque ouverture : aucune saisie précédente n'est réutilisée.
  const [assignKey, setAssignKey] = useState(0);
  const [ending, setEnding] = useState<AssignmentView | null>(null);
  const [editing, setEditing] = useState<AssignmentView | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['responsible-assignments'] });
    void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
  };

  const items = assignments.data ?? [];
  // Statut calculé par l'API : l'affectation EN_COURS (avec ou sans fin prévue) est celle que l'API clôture sur demande
  // explicite de remplacement ; une affectation à venir n'est jamais remplacée.
  const current = items.find((a) => a.status === 'EN_COURS') ?? null;

  return (
    <div className="space-y-4">
      <div role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        <p className="font-medium">{RESPONSIBLE_REMINDER}</p>
        <p className="text-muted-foreground">
          Il désigne la personne responsable du véhicule sur une période. La personne qui conduit est celle de l’utilisation en cours (remise puis restitution) ; une utilisation ponctuelle ne remplace jamais le responsable habituel.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Responsable habituel actuel</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {assignments.isPending ? (
              <LoadingState />
            ) : assignments.isError ? (
              <p className="text-muted-foreground">Indisponible : voir l’erreur ci-dessous.</p>
            ) : current ? (
              <p>
                <Link href={`/conducteurs/${current.driverId}`} className="font-medium underline-offset-4 hover:underline">
                  {current.driverName}
                </Link>
                <span className="block text-muted-foreground">
                  depuis le {formatDateTime(current.startsAt, session.timezone)}
                  {current.endsAt ? `, jusqu’au ${formatDateTime(current.endsAt, session.timezone)}` : ''}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">Aucun responsable habituel en cours.</p>
            )}
          </CardContent>
        </Card>
        {canManage ? (
          <div className="flex items-start md:justify-end">
            <Button
              className="w-full md:w-auto"
              onClick={() => {
                setAssignKey((k) => k + 1);
                setAssignOpen(true);
              }}
            >
              <UserPlus className="size-4" aria-hidden="true" /> Nommer un responsable habituel
            </Button>
          </div>
        ) : null}
      </div>

      <section aria-labelledby="assignments-history">
        <h2 id="assignments-history" className="mb-2 text-base font-semibold">
          Historique des affectations habituelles
        </h2>
        {assignments.isPending ? (
          <LoadingState label="Chargement de l’historique…" />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="Aucune affectation habituelle" description="Aucun responsable habituel n’a été nommé pour ce véhicule." />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Responsable habituel</TableHead>
                  <TableHead>Début</TableHead>
                  <TableHead>Fin</TableHead>
                  <TableHead>État</TableHead>
                  <TableHead>Notes et motif de fin</TableHead>
                  {canManage ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => {
                  const state = assignmentState(a);
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link href={`/conducteurs/${a.driverId}`} className="font-medium underline-offset-4 hover:underline">
                          {a.driverName}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateTime(a.startsAt, session.timezone)}</TableCell>
                      <TableCell>{a.endsAt ? formatDateTime(a.endsAt, session.timezone) : 'Sans fin prévue'}</TableCell>
                      <TableCell>
                        <StatusBadge label={state.label} tone={state.tone} />
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal">
                        {a.notes || a.endReason ? (
                          <ul className="space-y-0.5">
                            {a.notes ? <li>{a.notes}</li> : null}
                            {a.endReason ? (
                              <li>
                                <span className="text-muted-foreground">Motif de fin : </span>
                                {a.endReason}
                              </li>
                            ) : null}
                          </ul>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      {canManage ? (
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {a.editableFields.length > 0 ? (
                              <Button variant="outline" size="sm" onClick={() => setEditing(a)}>
                                Modifier<span className="sr-only"> l’affectation de {a.driverName}</span>
                              </Button>
                            ) : null}
                            {a.canEnd ? (
                              <Button variant="outline" size="sm" onClick={() => setEnding(a)}>
                                Terminer l’affectation<span className="sr-only"> de {a.driverName}</span>
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {canManage ? (
        <AssignDialog
          key={assignKey}
          open={assignOpen}
          onOpenChange={setAssignOpen}
          vehicleId={vehicleId}
          companyId={companyId}
          currentAssignment={current}
          onSaved={() => {
            setAssignOpen(false);
            refresh();
          }}
          onConflict={refresh}
        />
      ) : null}
      {editing ? (
        <EditAssignmentDialog
          key={editing.id}
          assignment={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onConflict={refresh}
        />
      ) : null}
      {ending ? (
        <EndAssignmentDialog
          key={ending.id}
          assignment={ending}
          onClose={() => setEnding(null)}
          onSaved={() => {
            setEnding(null);
            refresh();
          }}
          onConflict={refresh}
        />
      ) : null}
    </div>
  );
}

function ApiAlert({ error, extra }: { error: unknown; extra?: React.ReactNode }) {
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="text-destructive">{apiError ? apiError.message : 'Une erreur est survenue : rien n’a été enregistré.'}</p>
      {extra}
      {apiError?.requestId && apiError.status >= 500 ? <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p> : null}
    </div>
  );
}

function AssignDialog({
  open,
  onOpenChange,
  vehicleId,
  companyId,
  currentAssignment,
  onSaved,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: string;
  companyId: string;
  currentAssignment: AssignmentView | null;
  onSaved: () => void;
  onConflict: () => void;
}) {
  const session = useSession();
  const [driverId, setDriverId] = useState('');
  const [startsAt, setStartsAt] = useState(() => nowLocalInput(session.timezone));
  const [endsAt, setEndsAt] = useState('');
  const [notes, setNotes] = useState('');
  const [replaceCurrent, setReplaceCurrent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AssignmentView>('/responsible-assignments', { method: 'POST', body }),
    onSuccess: (created) => {
      toast.success(`Responsable habituel enregistré : ${created.driverName}.`);
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Chevauchement ou version obsolète : l'historique a pu changer, on le recharge.
        if (error.status === 409) onConflict();
        // Le responsable en cours a changé : le remplacement doit être reconfirmé sur l'affectation rechargée.
        if (error.code === 'VERSION_OBSOLETE') setReplaceCurrent(false);
      } else toast.error('Enregistrement impossible.');
    },
  });

  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    const startsIso = localInputToIso(startsAt, session.timezone);
    const endsIso = endsAt ? localInputToIso(endsAt, session.timezone) : null;
    if (!driverId) local.driverId = ['Choisissez le conducteur responsable.'];
    if (!startsIso) local.startsAt = ['Indiquez la date et l’heure de début.'];
    if (endsAt && !endsIso) local.endsAt = ['Date de fin invalide.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    const replacing = currentAssignment && replaceCurrent ? currentAssignment : null;
    save.mutate({
      vehicleId,
      driverId,
      startsAt: startsIso,
      endsAt: endsIso ?? undefined,
      notes: notes.trim() || undefined,
      // Remplacement explicite de l'affectation affichée, à sa version affichée : refusé (409) si elle a changé entre-temps.
      ...(replacing ? { replaceCurrent: true, replacedAssignmentId: replacing.id, replacedExpectedVersion: replacing.version } : {}),
    });
  }

  const overlap = isApiError(save.error) && save.error.code === 'RESPONSABLE_CHEVAUCHEMENT';
  const staleCurrent = isApiError(save.error) && save.error.code === 'VERSION_OBSOLETE';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nommer un responsable habituel</DialogTitle>
          <DialogDescription>{RESPONSIBLE_REMINDER} La nomination est journalisée ; deux responsables ne peuvent pas se chevaucher sur une même période.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="assignment-driver">Conducteur *</Label>
            <DriverSummaryPicker id="assignment-driver" value={driverId} onChange={setDriverId} companyId={companyId} invalid={invalid('driverId')} describedBy="assignment-driver-hint driverId-error" modal />
            <p id="assignment-driver-hint" className="text-xs text-muted-foreground">
              Conducteurs actifs de la société du véhicule.
            </p>
            <FieldError errors={fieldErrors} name="driverId" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="assignment-start">Début de la responsabilité *</Label>
              <Input id="assignment-start" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-invalid={invalid('startsAt')} aria-describedby="startsAt-error" />
              <FieldError errors={fieldErrors} name="startsAt" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignment-end">Fin (facultative)</Label>
              <Input id="assignment-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={invalid('endsAt')} aria-describedby="assignment-end-hint endsAt-error" />
              <p id="assignment-end-hint" className="text-xs text-muted-foreground">
                Laissez vide pour une responsabilité sans fin prévue.
              </p>
              <FieldError errors={fieldErrors} name="endsAt" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignment-notes">Notes</Label>
            <Textarea id="assignment-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={invalid('notes')} aria-describedby="notes-error" />
            <FieldError errors={fieldErrors} name="notes" />
          </div>
          {currentAssignment ? (
            <div className="space-y-1 rounded-md border p-3">
              <div className="flex items-start gap-2">
                <Checkbox id="assignment-replace" checked={replaceCurrent} onCheckedChange={(v) => setReplaceCurrent(v === true)} aria-describedby="assignment-replace-hint replaceCurrent-error" className="mt-0.5" />
                <Label htmlFor="assignment-replace" className="leading-snug font-normal">
                  Remplacer {currentAssignment.driverName} : son affectation en cours (début le {formatDateTime(currentAssignment.startsAt, session.timezone)}
                  {currentAssignment.endsAt ? `, fin prévue le ${formatDateTime(currentAssignment.endsAt, session.timezone)}` : ', sans fin prévue'}) sera clôturée à la date de début saisie.
                </Label>
              </div>
              <p id="assignment-replace-hint" className="text-xs text-muted-foreground">
                Sans cette case, la nomination est refusée si elle chevauche l’affectation en cours.
              </p>
              <FieldError errors={fieldErrors} name="replaceCurrent" />
            </div>
          ) : null}
          <ApiAlert
            error={save.error}
            extra={
              overlap && currentAssignment && !replaceCurrent ? (
                <p className="mt-1 text-muted-foreground">Pour remplacer explicitement {currentAssignment.driverName}, cochez la case de remplacement puis validez de nouveau.</p>
              ) : staleCurrent ? (
                <p className="mt-1 text-muted-foreground">L’historique a été rechargé : vérifiez le responsable en cours, cochez de nouveau la case de remplacement si besoin, puis validez.</p>
              ) : null
            }
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Nommer le responsable'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EndAssignmentDialog({ assignment, onClose, onSaved, onConflict }: { assignment: AssignmentView; onClose: () => void; onSaved: () => void; onConflict: () => void }) {
  const session = useSession();
  const [endsAt, setEndsAt] = useState(() => nowLocalInput(session.timezone));
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const end = useMutation({
    mutationFn: (body: { endsAt: string; reason: string; expectedVersion: number }) => api<AssignmentView>(`/responsible-assignments/${assignment.id}/end`, { method: 'POST', body }),
    onSuccess: (ended) => {
      toast.success(`Affectation de ${ended.driverName} terminée.`);
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète ou affectation déjà terminée : on recharge l'historique pour repartir de l'état courant.
        if (error.status === 409) onConflict();
      } else toast.error('Fin de l’affectation impossible.');
    },
  });

  const invalid = (name: string) => (fieldErrors[name]?.length ? true : undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    const endsIso = localInputToIso(endsAt, session.timezone);
    if (!endsIso) local.endsAt = ['Indiquez la date et l’heure de fin.'];
    if (reason.trim().length < 3) local.reason = ['Motif obligatoire (3 caractères minimum).'];
    setFieldErrors(local);
    if (!endsIso || Object.keys(local).length > 0) return;
    end.mutate({ endsAt: endsIso, reason: reason.trim(), expectedVersion: assignment.version });
  }

  const stale = isApiError(end.error) && end.error.code === 'VERSION_OBSOLETE';

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Terminer l’affectation de {assignment.driverName}</DialogTitle>
          <DialogDescription>
            Responsable habituel depuis le {formatDateTime(assignment.startsAt, session.timezone)}. La fin est journalisée avec son motif ; l’historique est conservé.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="assignment-end-at">Fin de la responsabilité *</Label>
            <Input id="assignment-end-at" type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={invalid('endsAt')} aria-describedby="endsAt-error" />
            <FieldError errors={fieldErrors} name="endsAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignment-end-reason">Motif (obligatoire, 3 caractères minimum) *</Label>
            <Textarea id="assignment-end-reason" required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid('reason')} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <ApiAlert error={end.error} extra={stale ? <p className="mt-1 text-muted-foreground">L’historique a été rechargé : fermez ce dialogue et recommencez sur l’affectation à jour.</p> : null} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={end.isPending || stale}>
              {end.isPending ? 'Enregistrement…' : 'Terminer l’affectation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
