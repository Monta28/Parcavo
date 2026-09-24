'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { MaintenancePlanView } from '@/lib/maintenance-types';

/**
 * Réactivation motivée d'un plan désactivé (POST /maintenance-plans/:id/reactivate, chef de parc ou
 * administrateur). L'API refuse si un autre plan actif suit déjà cette opération sur le véhicule, si
 * l'opération est archivée ou si le véhicule est cédé ou archivé ; l'échéance est recalculée.
 */
export function PlanReactivateDialog({ plan, onOpenChange, onDone }: { plan: MaintenancePlanView; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
    void queryClient.invalidateQueries({ queryKey: ['maintenance-plan', plan.id] });
  };

  const reactivate = useMutation({
    mutationFn: () => api<MaintenancePlanView>(`/maintenance-plans/${plan.id}/reactivate`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: plan.version } }),
    onSuccess: () => {
      toast.success('Plan réactivé : échéance et statut recalculés.');
      refresh();
      onDone();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Réactivation impossible.');
        return;
      }
      toast.error(error.message);
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);
      if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        refresh();
        onOpenChange(false);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !reactivate.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Réactiver le plan {plan.maintenanceTypeLabel} · {plan.vehicleCode} ?
          </DialogTitle>
          <DialogDescription>Le plan produira de nouveau échéances et alertes, recalculées depuis les opérations réalisées. Impossible si un autre plan actif suit déjà cette opération sur ce véhicule. Cette action est tracée dans l’audit.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (reason.trim().length < 3) {
              setFieldErrors({ reason: ['Indiquez le motif de la réactivation (3 caractères minimum).'] });
              return;
            }
            setFieldErrors({});
            reactivate.mutate();
          }}
        >
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          {plan.deactivationReason ? <p className="text-sm text-muted-foreground">Motif de la désactivation : {plan.deactivationReason}</p> : null}
          <div className="space-y-2">
            <Label htmlFor="plan-reactivate-reason">Motif *</Label>
            <Textarea id="plan-reactivate-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={reactivate.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={reactivate.isPending}>
              {reactivate.isPending ? 'Réactivation…' : 'Réactiver le plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
