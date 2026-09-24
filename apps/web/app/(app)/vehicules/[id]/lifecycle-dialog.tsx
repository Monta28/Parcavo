'use client';

import { useState } from 'react';
import { VEHICLE_LIFECYCLE_LABELS } from '@parc-auto/contracts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export function LifecycleDialog({ open, onOpenChange, current, pending, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; current: string; pending: boolean; onSubmit: (input: { lifecycleStatus: string; reason: string }) => void }) {
  const [status, setStatus] = useState<string>('');
  const [reason, setReason] = useState('');
  const options = Object.entries(VEHICLE_LIFECYCLE_LABELS).filter(([k]) => k !== current);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Changer le cycle de vie</DialogTitle>
          <DialogDescription>Archivage et cession sont refusés tant que des utilisations, immobilisations, interventions ou réservations futures existent. Les dossiers ne sont jamais supprimés.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (status && reason.trim().length >= 3) onSubmit({ lifecycleStatus: status, reason: reason.trim() });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="lifecycle">Nouveau statut</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="lifecycle">
                <SelectValue placeholder="Choisir" />
              </SelectTrigger>
              <SelectContent>
                {options.map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reason">Motif (obligatoire)</Label>
            <Textarea id="reason" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={pending || !status || reason.trim().length < 3}>
              {pending ? 'Enregistrement…' : 'Confirmer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
