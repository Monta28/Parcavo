'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { MaintenancePlanView } from '@/lib/maintenance-types';

/** Désactivation motivée d'un plan (POST /maintenance-plans/:id/deactivate) : ses alertes sont résolues. */
export function PlanDeactivateDialog({ plan, onOpenChange, onDone }: { plan: MaintenancePlanView; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const deactivate = useMutation({
    mutationFn: () => api<MaintenancePlanView>(`/maintenance-plans/${plan.id}/deactivate`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: plan.version } }),
    onSuccess: () => {
      toast.success('Plan désactivé.');
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plan', plan.id] });
      onDone();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Désactivation impossible.');
        return;
      }
      toast.error(error.message);
      setFieldErrors(error.fieldErrors);
      // Version obsolète ou plan déjà désactivé entre-temps : données rechargées.
      if (error.status === 409 && (error.code === 'VERSION_OBSOLETE' || error.code === 'ETAT_INVALIDE')) {
        void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
        void queryClient.invalidateQueries({ queryKey: ['maintenance-plan', plan.id] });
        onOpenChange(false);
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !deactivate.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Désactiver le plan {plan.maintenanceTypeLabel} · {plan.vehicleCode} ?
          </DialogTitle>
          <DialogDescription>Le plan ne produira plus d’échéance ni d’alerte. L’historique des interventions est conservé. Cette action est tracée dans l’audit.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length < 3) {
              setFieldErrors({ reason: ['Indiquez le motif de la désactivation (3 caractères minimum).'] });
              return;
            }
            setFieldErrors({});
            deactivate.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="plan-deactivate-reason">Motif *</Label>
            <Textarea id="plan-deactivate-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={fieldErrors.reason ? true : undefined} aria-describedby="reason-error" />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deactivate.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={deactivate.isPending}>
              {deactivate.isPending ? 'Désactivation…' : 'Désactiver le plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
