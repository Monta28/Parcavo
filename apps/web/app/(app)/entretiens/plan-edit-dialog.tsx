'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { PlanStatusBadge, formatBase, formatIntervals, formatNotices, formatRemainingDays, formatRemainingKm } from '@/components/maintenance/plan-display';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDate, formatKm } from '@/lib/format';
import { ACCEPTED_SOURCES_LABELS, type AcceptedSources, type MaintenancePlanUpdateResult, type MaintenancePlanView } from '@/lib/maintenance-types';
import { IntervalFields, intervalsFrom, intervalsPayload, type IntervalsForm } from './interval-fields';
import { BaseFields, EMPTY_BASE, RESPONSIBLE_NONE, ResponsibleField, SourcesField, basePayload, responsiblePayload, type BaseForm } from './plan-form-parts';

/**
 * Modification d'un plan (PATCH /maintenance-plans/:id) : prévisualisation de l'impact (preview=true,
 * rien n'est enregistré), puis confirmation motivée avec verrou optimiste (D-198, 17.1). La modification
 * affecte les échéances futures, jamais les travaux historiques.
 */
export function PlanEditDialog({ plan, onOpenChange, onSaved }: { plan: MaintenancePlanView; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [intervals, setIntervals] = useState<IntervalsForm>(() => intervalsFrom(plan));
  const [resetBase, setResetBase] = useState(false);
  const [base, setBase] = useState<BaseForm>({ ...EMPTY_BASE, baseMode: 'BASE_TECHNIQUE' });
  const [acceptedSources, setAcceptedSources] = useState<AcceptedSources>(plan.acceptedSources);
  const [responsible, setResponsible] = useState(plan.responsibleUserId ?? RESPONSIBLE_NONE);
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MaintenancePlanUpdateResult | null>(null);

  const body = (isPreview: boolean) => ({
    ...intervalsPayload(intervals),
    acceptedSources,
    responsibleUserId: responsiblePayload(responsible),
    ...(resetBase ? { base: basePayload(base) } : {}),
    reason: reason.trim(),
    expectedVersion: plan.version,
    preview: isPreview,
  });

  const handleError = (error: unknown) => {
    if (!isApiError(error)) {
      toast.error('Opération impossible.');
      return;
    }
    toast.error(error.message);
    // Version obsolète : le plan est rechargé et la fenêtre fermée pour repartir de la version courante.
    if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plan', plan.id] });
      onOpenChange(false);
      return;
    }
    setFieldErrors(error.fieldErrors);
    setFormError(error.message);
    setPreview(null);
  };

  const previewMutation = useMutation({
    mutationFn: () => api<MaintenancePlanUpdateResult>(`/maintenance-plans/${plan.id}`, { method: 'PATCH', body: body(true) }),
    onSuccess: (result) => setPreview(result),
    onError: handleError,
  });

  const save = useMutation({
    mutationFn: () => api<MaintenancePlanUpdateResult>(`/maintenance-plans/${plan.id}`, { method: 'PATCH', body: body(false) }),
    onSuccess: () => {
      toast.success('Plan modifié : les échéances futures sont recalculées, l’historique est inchangé.');
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plan', plan.id] });
      onSaved();
    },
    onError: handleError,
  });

  const pending = previewMutation.isPending || save.isPending;
  const before = preview?.before ?? plan;

  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Modifier le plan {plan.maintenanceTypeLabel} · {plan.vehicleCode}
          </DialogTitle>
          <DialogDescription>{preview ? 'Vérifiez l’impact calculé par le serveur avant de confirmer. Rien n’est encore enregistré.' : 'Étape 1 sur 2 : saisissez les changements et leur motif, puis prévisualisez l’impact.'}</DialogDescription>
        </DialogHeader>

        {formError && !preview ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        {preview ? (
          <div className="space-y-4">
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Élément</TableHead>
                    <TableHead scope="col">Avant</TableHead>
                    <TableHead scope="col">Après</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <CompareRow label="Intervalles" before={formatIntervals(before)} after={formatIntervals(preview)} />
                  <CompareRow label="Préavis" before={formatNotices(before)} after={formatNotices(preview)} />
                  <CompareRow label="Base" before={formatBase(before, session.timezone)} after={formatBase(preview, session.timezone)} />
                  <CompareRow label="Échéance km" before={formatKm(before.nextDueKm)} after={formatKm(preview.nextDueKm)} />
                  <CompareRow label="Échéance date" before={formatDate(before.nextDueDate, session.timezone)} after={formatDate(preview.nextDueDate, session.timezone)} />
                  <CompareRow label="Reste km" before={formatRemainingKm(before.remainingKm)} after={formatRemainingKm(preview.remainingKm)} />
                  <CompareRow label="Reste jours" before={formatRemainingDays(before.remainingDays)} after={formatRemainingDays(preview.remainingDays)} />
                  <CompareRow label="Relevés admis" before={ACCEPTED_SOURCES_LABELS[before.acceptedSources]} after={ACCEPTED_SOURCES_LABELS[preview.acceptedSources]} />
                  <TableRow>
                    <TableCell className="font-medium">Statut</TableCell>
                    <TableCell>
                      <PlanStatusBadge status={before.status} />
                    </TableCell>
                    <TableCell>
                      <PlanStatusBadge status={preview.status} />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-edit-reason-confirm">Motif de la modification *</Label>
              <Textarea
                id="plan-edit-reason-confirm"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={fieldErrors.reason ? true : undefined}
                aria-describedby="reason-error"
              />
              <FieldError errors={fieldErrors} name="reason" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setPreview(null)}>
                Revenir au formulaire
              </Button>
              <Button type="button" disabled={pending || reason.trim().length < 3} onClick={() => save.mutate()}>
                {save.isPending ? 'Enregistrement…' : 'Confirmer la modification'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setFormError(null);
              if (reason.trim().length < 3) {
                setFieldErrors({ reason: ['Indiquez le motif de la modification (3 caractères minimum).'] });
                return;
              }
              setFieldErrors({});
              previewMutation.mutate();
            }}
          >
            <IntervalFields value={intervals} onChange={(patch) => setIntervals((f) => ({ ...f, ...patch }))} errors={fieldErrors} idPrefix="plan-edit" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SourcesField id="plan-edit-sources" value={acceptedSources} onChange={setAcceptedSources} errors={fieldErrors} />
              <ResponsibleField id="plan-edit-responsible" value={responsible} onChange={setResponsible} current={plan.responsibleUserId} currentName={plan.responsibleUserName} errors={fieldErrors} />
            </div>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox id="plan-edit-reset-base" checked={resetBase} onCheckedChange={(checked) => setResetBase(checked === true)} aria-describedby="plan-edit-reset-base-hint" />
                <div className="space-y-0.5">
                  <Label htmlFor="plan-edit-reset-base">Réinitialiser la base de calcul</Label>
                  <p id="plan-edit-reset-base-hint" className="text-xs text-muted-foreground">
                    Base actuelle : {formatBase(plan, session.timezone)}. Une opération réalisée plus récente reste prioritaire.
                  </p>
                </div>
              </div>
              {resetBase ? <BaseFields value={base} onChange={(patch) => setBase((f) => ({ ...f, ...patch }))} errors={fieldErrors} idPrefix="plan-edit" /> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-edit-reason">Motif de la modification *</Label>
              <Textarea id="plan-edit-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
              <FieldError errors={fieldErrors} name="reason" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={pending}>
                {previewMutation.isPending ? 'Calcul de l’impact…' : 'Prévisualiser l’impact'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompareRow({ label, before, after }: { label: string; before: string; after: string }) {
  const changed = before !== after;
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="whitespace-normal">{before}</TableCell>
      <TableCell className={changed ? 'whitespace-normal font-semibold' : 'whitespace-normal'}>
        {after}
        {changed ? <span className="sr-only"> (modifié)</span> : null}
      </TableCell>
    </TableRow>
  );
}
