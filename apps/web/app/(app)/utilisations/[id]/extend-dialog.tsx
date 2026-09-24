'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { UsageDetailView } from '@/lib/usages-types';
import { ApiErrorAlert } from '../usage-form-parts';
import { isoToLocalInput, localInputToIso } from '../usage-helpers';

/** Prolongation du retour prévu (POST /usages/:id/extend) : motif obligatoire, version attendue. */
export function ExtendDialog({ usage, open, onOpenChange }: { usage: UsageDetailView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [expectedReturnAt, setExpectedReturnAt] = useState(() => isoToLocalInput(usage.expectedReturnAt, session.timezone));
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<unknown>(null);

  const extend = useMutation({
    mutationFn: () =>
      api<UsageDetailView>(`/usages/${usage.id}/extend`, {
        method: 'POST',
        body: { expectedReturnAt: localInputToIso(expectedReturnAt, session.timezone), reason: reason.trim(), expectedVersion: usage.version },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['usage', usage.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['usages'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', usage.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['planning'] });
      toast.success(`Retour prévu prolongé au ${formatDateTime(updated.expectedReturnAt, session.timezone)}.`);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err);
      if (isApiError(err)) {
        setFieldErrors(err.fieldErrors);
        toast.error(err.message);
        // Version obsolète : la fiche est rechargée, la nouvelle version sera utilisée au prochain envoi.
        if (err.status === 409) void queryClient.invalidateQueries({ queryKey: ['usage', usage.id] });
      } else toast.error('Prolongation impossible.');
    },
  });

  const reasonErrors = fieldErrors.reason;
  return (
    <Dialog open={open} onOpenChange={(o) => !extend.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Prolonger le retour prévu</DialogTitle>
          <DialogDescription>
            Retour prévu actuel : {formatDateTime(usage.expectedReturnAt, session.timezone)}. La prolongation ne clôture rien et reste tracée avec son motif ; elle est refusée si elle chevauche une réservation confirmée.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setFieldErrors({});
            extend.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="extend-expectedReturnAt">Nouveau retour prévu *</Label>
            <Input
              id="extend-expectedReturnAt"
              type="datetime-local"
              value={expectedReturnAt}
              onChange={(e) => setExpectedReturnAt(e.target.value)}
              aria-invalid={Boolean(fieldErrors.expectedReturnAt?.length) || undefined}
              aria-describedby={fieldErrors.expectedReturnAt?.length ? 'expectedReturnAt-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="expectedReturnAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="extend-reason">Motif * (3 caractères minimum)</Label>
            <Textarea
              id="extend-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={Boolean(reasonErrors?.length) || undefined}
              aria-describedby={reasonErrors?.length ? 'reason-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          {error && !Object.keys(fieldErrors).length ? <ApiErrorAlert error={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={extend.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={extend.isPending || reason.trim().length < 3 || !expectedReturnAt}>
              {extend.isPending ? 'Enregistrement…' : 'Prolonger'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
