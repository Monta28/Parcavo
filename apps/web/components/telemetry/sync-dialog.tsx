'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { ManualSyncResult, ProviderView } from '@/lib/telemetry-types';

const ALL = '__toutes__';

/**
 * Synchronisation manuelle (POST /telemetry/providers/:id/sync, D-296) : lancée en arrière-plan, la
 * réponse donne l'exécution créée, l'exécution déjà en cours ou une exécution ignorée (coupe-circuit).
 */
export function SyncDialog({ provider, onClose, allowReprise = true }: { provider: Pick<ProviderView, 'id' | 'name' | 'companyIds'>; onClose: () => void; allowReprise?: boolean }) {
  const queryClient = useQueryClient();
  const companyCode = useCompanyCodes();
  const [companyId, setCompanyId] = useState(ALL);
  const [reprise, setReprise] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api<ManualSyncResult>(`/telemetry/providers/${provider.id}/sync`, { method: 'POST', body: { companyId: companyId === ALL ? undefined : companyId, reprise: allowReprise && reprise ? true : undefined } }),
    onSuccess: (result) => {
      for (const run of result.runs) {
        const who = companyCode(run.companyId);
        const text = run.message ?? (run.alreadyRunning ? 'exécution déjà en cours' : run.status === 'IGNORE' ? 'ignorée' : 'lancée en arrière-plan');
        if (run.status === 'IGNORE') toast.warning(`${who} : ${text}`);
        else toast.success(`${who} : ${text}`);
      }
      if (result.runs.length === 0) toast.info('Aucune société à synchroniser.');
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      onClose();
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Synchronisation impossible.'),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Synchroniser {provider.name}</DialogTitle>
          <DialogDescription>
            La synchronisation s’exécute en arrière-plan et suit son état dans les exécutions. Seules les sociétés couvertes où le module est activé sont synchronisées ; aucun parcours manuel n’en dépend.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="sync-company">Société</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger id="sync-company">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Toutes les sociétés couvertes</SelectItem>
                {provider.companyIds.map((c) => (
                  <SelectItem key={c} value={c}>
                    {companyCode(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {allowReprise ? (
            <div className="flex items-start gap-2">
              <Checkbox id="sync-reprise" checked={reprise} onCheckedChange={(v) => setReprise(v === true)} aria-describedby="sync-reprise-hint" />
              <div className="space-y-1">
                <Label htmlFor="sync-reprise" className="font-normal">
                  Reprise d’historique
                </Label>
                <p id="sync-reprise-hint" className="text-xs text-muted-foreground">
                  Relit l’historique sur la période de reprise du fournisseur, bornée à la dernière désactivation du module (administrateur).
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Lancement…' : 'Lancer la synchronisation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
