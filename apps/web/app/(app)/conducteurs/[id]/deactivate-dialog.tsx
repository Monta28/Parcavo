'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api-error';

/** Désactivation d'un conducteur : motif obligatoire, refus explicite de l'API affiché dans le dialogue. */
export function DeactivateDialog({ open, onOpenChange, driverName, pending, error, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; driverName: string; pending: boolean; error: unknown; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const apiError = isApiError(error) ? error : null;
  const usageId = typeof apiError?.details?.usageId === 'string' ? apiError.details.usageId : null;
  const reasonErrors = apiError?.fieldErrors.reason;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Désactiver {driverName}</DialogTitle>
          <DialogDescription>Un conducteur inactif ne peut plus recevoir de véhicule. La désactivation est refusée tant qu’une utilisation est en cours ; ses réservations confirmées à venir sont annulées. La fiche est conservée et peut être réactivée.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= 3) onSubmit(reason.trim());
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="deactivate-reason">Motif (obligatoire, 3 caractères minimum)</Label>
            <Textarea id="deactivate-reason" required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="reason-error" aria-invalid={Boolean(reasonErrors?.length)} />
            {reasonErrors?.length ? (
              <p id="reason-error" role="alert" className="text-sm text-destructive">
                {reasonErrors.join(' ')}
              </p>
            ) : null}
          </div>
          {apiError && !reasonErrors?.length ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">{apiError.message}</p>
              {usageId ? (
                <Link href={`/utilisations/${usageId}`} className="mt-1 inline-block underline underline-offset-4">
                  Ouvrir l’utilisation en cours
                </Link>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || reason.trim().length < 3}>
              {pending ? 'Désactivation…' : 'Désactiver'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
