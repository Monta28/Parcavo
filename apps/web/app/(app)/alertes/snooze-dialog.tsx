'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, invalid } from '@/components/incidents/ops-helpers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AlertView } from '@/lib/alerts-types';
import { formatDate } from '@/lib/format';

/**
 * Report motivé d'une alerte (POST /alerts/:id/snooze, D-252) : propre à l'utilisateur, jusqu'à une date
 * civile incluse, motif obligatoire visible des autres destinataires. L'alerte reste active et le retard
 * de l'objet persiste ; la date et la durée sont contrôlées par l'API.
 */
export function SnoozeDialog({ alert, onClose }: { alert: AlertView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [until, setUntil] = useState(alert.snoozedUntil ?? '');
  const [reason, setReason] = useState(alert.snoozeReason ?? '');
  const [local, setLocal] = useState<FieldErrors>({});
  const snooze = useMutation({
    mutationFn: () => api<AlertView>(`/alerts/${alert.id}/snooze`, { method: 'POST', body: { until, reason: reason.trim() } }),
    onSuccess: (updated) => {
      toast.success(`Alerte reportée pour vous jusqu’au ${formatDate(updated.snoozedUntil)} inclus : elle reste active.`);
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      onClose();
    },
  });
  const errors: FieldErrors = { ...(isApiError(snooze.error) ? snooze.error.fieldErrors : {}), ...local };

  return (
    <Dialog open onOpenChange={(open) => !open && !snooze.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reporter l’alerte</DialogTitle>
          <DialogDescription>
            Le report ne vaut que pour vous : l’alerte reste active, garde sa gravité et le retard de l’objet persiste. Votre motif est visible des autres destinataires.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md border p-3 text-sm">
          <span className="font-medium">{alert.title}</span>
          <span className="block text-xs text-muted-foreground">
            {alert.severityLabel} · {alert.typeLabel}
          </span>
        </p>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (!until) next.until = ['Indiquez la date de fin du report.'];
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif du report (3 caractères au moins).'];
            setLocal(next);
            if (Object.keys(next).length === 0) snooze.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="snooze-until">Reporter jusqu’au *</Label>
            <Input id="snooze-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-invalid={invalid(errors, 'until')} aria-describedby={describedBy(errors, 'until', 'snooze-until-hint')} />
            <p id="snooze-until-hint" className="text-xs text-muted-foreground">
              Date future, incluse (fin de journée locale) ; la durée maximale est contrôlée par le serveur.
            </p>
            <FieldError errors={errors} name="until" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="snooze-reason">Motif du report *</Label>
            <Textarea id="snooze-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <ApiErrorAlert error={snooze.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={snooze.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={snooze.isPending}>
              {snooze.isPending ? 'Enregistrement…' : 'Confirmer le report'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
