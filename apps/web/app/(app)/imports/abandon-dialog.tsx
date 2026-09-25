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
import type { ImportBatchView } from '@/lib/imports-types';

/** Abandon confirmé d'un lot non confirmé (POST /imports/:id/abandon) : rien n'est importé, action auditée. */
export function AbandonImportDialog({ batch, onOpenChange }: { batch: ImportBatchView; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const abandon = useMutation({
    mutationFn: () => {
      const trimmed = reason.trim();
      return api<ImportBatchView>(`/imports/${batch.id}/abandon`, { method: 'POST', body: { ...(trimmed ? { reason: trimmed } : {}), expectedVersion: batch.version } });
    },
    onSuccess: (updated) => {
      toast.success('Lot abandonné : aucune ligne n’a été importée.');
      queryClient.setQueryData(['import', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      onOpenChange(false);
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Abandon impossible.');
        return;
      }
      toast.error(error.message);
      // Lot modifié, confirmé ou déjà abandonné entre-temps : données rechargées.
      if (error.status === 409 || error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ['import', batch.id] });
        void queryClient.invalidateQueries({ queryKey: ['imports'] });
        onOpenChange(false);
      }
    },
  });
  const fieldErrors = isApiError(abandon.error) ? abandon.error.fieldErrors : {};

  return (
    <Dialog open onOpenChange={(open) => !abandon.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Abandonner le lot « {batch.fileName} » ?</DialogTitle>
          <DialogDescription>Aucune ligne n’est importée et le lot ne pourra plus être contrôlé ni confirmé. Pour réessayer, téléversez à nouveau le fichier. L’abandon est tracé dans l’audit.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            abandon.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="import-abandon-reason">Motif (facultatif)</Label>
            <Textarea
              id="import-abandon-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={fieldErrors.reason ? true : undefined}
              aria-describedby={fieldErrors.reason ? 'reason-error' : undefined}
            />
            <FieldError errors={fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={abandon.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={abandon.isPending}>
              {abandon.isPending ? 'Abandon…' : 'Abandonner le lot'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
