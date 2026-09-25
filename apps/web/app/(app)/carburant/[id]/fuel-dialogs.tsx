'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { AttachmentField, type UploadedFile } from '@/components/odometer/attachment-field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { FuelEntryView } from '@/lib/fuel-types';
import { energyLabel, formatFuelLiters, useMoney } from '../fuel-display';
import { DriverSelect, EnergySelect, FullTankField, SupplierSelect, isDecimal3, normalizeDecimal } from '../fuel-form-parts';

/** Mise à jour du cache après une décision ; rechargement du plein sur conflit (409). */
function useFuelCache(entry: FuelEntryView) {
  const queryClient = useQueryClient();
  return {
    saved(updated: FuelEntryView, message: string) {
      toast.success(message);
      queryClient.setQueryData(['fuel-entry', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['fuel-entry', entry.id] });
      void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', entry.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
    },
    /** Vrai si la fenêtre doit être fermée (version obsolète : le plein est rechargé). */
    failed(error: unknown, fallback: string): boolean {
      toast.error(isApiError(error) ? error.message : fallback);
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['fuel-entry', entry.id] });
        void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
        if (error.code === 'VERSION_OBSOLETE') {
          toast.info('Le plein a été rechargé avec sa version courante : vérifiez puis relancez l’action.');
          return true;
        }
      }
      return false;
    },
  };
}

function Summary({ entry }: { entry: FuelEntryView }) {
  const { session } = useAppScope();
  const money = useMoney();
  return (
    <p className="rounded-md border p-3 text-sm">
      <span className="font-medium">
        {entry.vehicleCode} · {entry.vehicleRegistration}
      </span>
      <span className="block text-muted-foreground">
        {formatDateTime(entry.filledAt, session.timezone)} · {formatFuelLiters(entry.liters)} · {energyLabel(entry.energy)}
        {entry.totalAmount !== null ? ` · ${money(entry.totalAmount)}` : ''}
        {entry.driverName ? ` · ${entry.driverName}` : ''}
      </span>
    </p>
  );
}

// Valider ---------------------------------------------------------------------------------------

/**
 * Validation d'une soumission (POST :id/validate) : clé d'idempotence propre à cette fenêtre, réutilisée
 * pour chaque nouvel essai, version attendue, confirmation explicite de l'écart signalé (D-224) et
 * station facultative à compléter. La dépense de synthèse est créée par le serveur.
 */
export function ValidateDialog({ entry, onOpenChange }: { entry: FuelEntryView; onOpenChange: (open: boolean) => void }) {
  const cache = useFuelCache(entry);
  const money = useMoney();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const validate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>(`/fuel-entries/${entry.id}/validate`, { method: 'POST', body, idempotencyKey }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Plein validé : la dépense de synthèse est enregistrée.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Validation impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(validate.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !validate.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Valider le plein</DialogTitle>
          <DialogDescription>Le plein devient validé et sa dépense de synthèse est enregistrée au registre. Le relevé du compteur éventuel reste soumis à sa propre validation.</DialogDescription>
        </DialogHeader>
        <Summary entry={entry} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (entry.amountMismatch && !confirmMismatch) next.confirmAmountMismatch = ['Cochez la confirmation de l’écart signalé.'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            validate.mutate({ expectedVersion: entry.version, confirmAmountMismatch: entry.amountMismatch ? true : undefined, supplierId: supplierId || undefined });
          }}
        >
          {entry.amountMismatch ? (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-start gap-2">
                <Checkbox id="validate-confirm-mismatch" checked={confirmMismatch} onCheckedChange={(v) => setConfirmMismatch(v === true)} aria-invalid={invalid(errors, 'confirmAmountMismatch')} aria-describedby={describedBy(errors, 'confirmAmountMismatch')} />
                <Label htmlFor="validate-confirm-mismatch" className="leading-snug font-normal">
                  Je confirme l’écart signalé entre litres × prix unitaire et montant total{entry.amountMismatchValue ? ` (${money(entry.amountMismatchValue)})` : ''}
                </Label>
              </div>
              <FieldError errors={errors} name="confirmAmountMismatch" />
            </div>
          ) : null}
          {entry.supplierId ? (
            <p className="text-sm">
              <span className="text-muted-foreground">Station : </span>
              {entry.supplierName}
            </p>
          ) : (
            <SupplierSelect id="validate-supplier" companyId={entry.companyId} value={supplierId} onChange={setSupplierId} errors={errors} label="Station / fournisseur (à compléter)" />
          )}
          {validate.error ? <ApiErrorAlert error={validate.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={validate.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={validate.isPending}>
              {validate.isPending ? 'Validation…' : 'Valider le plein'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Rejeter ---------------------------------------------------------------------------------------

/** Rejet motivé d'une soumission (POST :id/reject) : le motif est visible par le conducteur. */
export function RejectDialog({ entry, onOpenChange }: { entry: FuelEntryView; onOpenChange: (open: boolean) => void }) {
  const cache = useFuelCache(entry);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const reject = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>(`/fuel-entries/${entry.id}/reject`, { method: 'POST', body }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Soumission rejetée : le motif est visible par le conducteur.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Rejet impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(reject.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !reject.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rejeter la soumission</DialogTitle>
          <DialogDescription>Aucune dépense n’est créée. Le conducteur voit le motif du rejet.</DialogDescription>
        </DialogHeader>
        <Summary entry={entry} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            reject.mutate({ reason: reason.trim(), expectedVersion: entry.version });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Motif du rejet *</Label>
            <Textarea id="reject-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. ticket illisible, plein déjà saisi" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          {reject.error ? <ApiErrorAlert error={reject.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={reject.isPending}>
              Fermer
            </Button>
            <Button type="submit" variant="destructive" disabled={reject.isPending}>
              {reject.isPending ? 'Rejet…' : 'Rejeter'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Annuler ---------------------------------------------------------------------------------------

/** Annulation motivée d'un plein validé (POST :id/cancel) : la dépense liée est annulée de façon traçable. */
export function CancelDialog({ entry, onOpenChange }: { entry: FuelEntryView; onOpenChange: (open: boolean) => void }) {
  const cache = useFuelCache(entry);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const cancel = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>(`/fuel-entries/${entry.id}/cancel`, { method: 'POST', body }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Plein annulé : sa dépense est annulée au registre.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Annulation impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(cancel.error), ...local };

  return (
    <Dialog open onOpenChange={(o) => !cancel.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Annuler le plein</DialogTitle>
          <DialogDescription>Le plein et sa dépense de synthèse sont annulés avec ce motif ; l’historique est conservé.</DialogDescription>
        </DialogHeader>
        <Summary entry={entry} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
            setLocal(next);
            if (Object.keys(next).length > 0) return;
            cancel.mutate({ reason: reason.trim(), expectedVersion: entry.version });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Motif de l’annulation *</Label>
            <Textarea id="cancel-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. plein saisi sur le mauvais véhicule" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          {cancel.error ? <ApiErrorAlert error={cancel.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
              Fermer
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending ? 'Annulation…' : 'Annuler le plein'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Confirmer la capacité ------------------------------------------------------------------------

/** Confirmation d'un dépassement de capacité du réservoir (POST :id/confirm-capacity, D-225). */
export function CapacityDialog({ entry, onOpenChange }: { entry: FuelEntryView; onOpenChange: (open: boolean) => void }) {
  const cache = useFuelCache(entry);
  const confirm = useMutation({
    mutationFn: () => api<FuelEntryView>(`/fuel-entries/${entry.id}/confirm-capacity`, { method: 'POST', body: { expectedVersion: entry.version } }),
    onSuccess: (updated) => {
      cache.saved(updated, 'Capacité confirmée.');
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Confirmation impossible.')) onOpenChange(false);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !confirm.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmer la capacité</DialogTitle>
          <DialogDescription>Les litres de ce plein dépassent la capacité du réservoir enregistrée sur la fiche du véhicule. Confirmez-les si le ticket est exact : le plein redevient admissible au calcul de consommation.</DialogDescription>
        </DialogHeader>
        <Summary entry={entry} />
        {confirm.error ? <ApiErrorAlert error={confirm.error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={confirm.isPending}>
            Fermer
          </Button>
          <Button type="button" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            {confirm.isPending ? 'Confirmation…' : 'Confirmer les litres'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Corriger --------------------------------------------------------------------------------------

/** Valeur décimale saisie : chaîne normalisée, ou message d'erreur de format. */
function decimalOrError(value: string, message: string): { value: string } | { error: string } {
  const v = normalizeDecimal(value);
  return isDecimal3(v) ? { value: v } : { error: message };
}

/**
 * Correction d'un plein validé (POST :id/correct, D-222, D-229) : seules les valeurs modifiées sont envoyées
 * (le véhicule, la date et le compteur ne se corrigent pas ici). Le serveur crée une nouvelle version et
 * remplace la dépense ; la page s'ouvre sur la version corrigée.
 */
export function CorrectDialog({ entry, onOpenChange }: { entry: FuelEntryView; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const cache = useFuelCache(entry);
  const { session } = useAppScope();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [liters, setLiters] = useState(entry.liters);
  const [unitPrice, setUnitPrice] = useState(entry.unitPrice ?? '');
  const [totalAmount, setTotalAmount] = useState(entry.totalAmount ?? '');
  const [energy, setEnergy] = useState('');
  const [isFullTank, setIsFullTank] = useState<boolean | null>(entry.isFullTank);
  const [supplierId, setSupplierId] = useState(entry.supplierId ?? '');
  const [driverId, setDriverId] = useState(entry.driverId ?? '');
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [ticket, setTicket] = useState<UploadedFile | null>(null);
  const [local, setLocal] = useState<FieldErrors>({});
  // Montants masqués par l'API (sans costs.read) : ils ne sont ni affichés ni corrigeables ici.
  const amountsVisible = entry.totalAmount !== null;
  const correct = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>(`/fuel-entries/${entry.id}/correct`, { method: 'POST', body, idempotencyKey }),
    onSuccess: (created) => {
      cache.saved(created, 'Plein corrigé : une nouvelle version remplace l’ancienne et sa dépense.');
      onOpenChange(false);
      router.push(`/carburant/${created.id}`);
    },
    onError: (error) => {
      if (cache.failed(error, 'Correction impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(correct.error), ...local };

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    const body: Record<string, unknown> = { reason: reason.trim(), expectedVersion: entry.version };
    if (reason.trim().length < 3) next.reason = ['Indiquez le motif de la correction (3 caractères au moins).'];
    const l = decimalOrError(liters, 'Nombre positif attendu, 3 décimales au plus.');
    if ('error' in l) next.liters = [l.error];
    else if (l.value !== entry.liters) body.liters = l.value;
    if (amountsVisible) {
      const t = decimalOrError(totalAmount, 'Montant positif attendu, 3 décimales au plus.');
      if ('error' in t) next.totalAmount = [t.error];
      else if (t.value !== entry.totalAmount) body.totalAmount = t.value;
      const u = normalizeDecimal(unitPrice);
      if (!u) {
        if (entry.unitPrice !== null) body.unitPrice = null;
      } else if (!isDecimal3(u)) next.unitPrice = ['Prix positif attendu, 3 décimales au plus.'];
      else if (u !== entry.unitPrice) body.unitPrice = u;
    }
    if (energy && energy !== entry.energy) body.energy = energy;
    if (isFullTank !== null && isFullTank !== entry.isFullTank) body.isFullTank = isFullTank;
    if (supplierId !== (entry.supplierId ?? '')) body.supplierId = supplierId || null;
    if (driverId !== (entry.driverId ?? '')) body.driverId = driverId || null;
    if (notes.trim() !== (entry.notes ?? '')) body.notes = notes.trim() || null;
    if (ticket) body.ticketAttachmentId = ticket.id;
    setLocal(next);
    if (Object.keys(next).length > 0) return;
    correct.mutate(body);
  }

  return (
    <Dialog open onOpenChange={(o) => !correct.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Corriger le plein</DialogTitle>
          <DialogDescription>Une nouvelle version remplace ce plein et sa dépense ; l’original reste consultable. Pour changer de véhicule ou de date, annulez le plein puis saisissez-le à nouveau.</DialogDescription>
        </DialogHeader>
        <Summary entry={entry} />
        <form className="space-y-4" noValidate onSubmit={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="correct-liters">Litres *</Label>
              <Input id="correct-liters" inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value)} aria-invalid={invalid(errors, 'liters')} aria-describedby={describedBy(errors, 'liters')} />
              <FieldError errors={errors} name="liters" />
            </div>
            {amountsVisible ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="correct-unit-price">Prix unitaire TTC ({session.currency})</Label>
                  <Input id="correct-unit-price" inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} aria-invalid={invalid(errors, 'unitPrice')} aria-describedby={describedBy(errors, 'unitPrice')} />
                  <FieldError errors={errors} name="unitPrice" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="correct-total">Montant total TTC ({session.currency}) *</Label>
                  <Input id="correct-total" inputMode="decimal" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} aria-invalid={invalid(errors, 'totalAmount')} aria-describedby={describedBy(errors, 'totalAmount')} />
                  <FieldError errors={errors} name="totalAmount" />
                </div>
              </>
            ) : null}
          </div>
          <FullTankField idPrefix="correct-full" value={isFullTank} onChange={setIsFullTank} errors={errors} />
          <div className="grid gap-4 sm:grid-cols-2">
            <EnergySelect id="correct-energy" value={energy} onChange={setEnergy} vehicleEnergy={null} errors={errors} defaultLabel={`Inchangé (${energyLabel(entry.energy)})`} />
            <SupplierSelect id="correct-supplier" companyId={entry.companyId} value={supplierId} onChange={setSupplierId} current={entry.supplierId && entry.supplierName ? { id: entry.supplierId, name: entry.supplierName } : null} errors={errors} />
          </div>
          <DriverSelect id="correct-driver" companyId={entry.companyId} value={driverId} onChange={setDriverId} current={entry.driverId && entry.driverName ? { id: entry.driverId, name: entry.driverName } : null} errors={errors} />
          <AttachmentField
            id="correct-ticket"
            label="Nouveau ticket (facultatif)"
            hint="Sans nouveau fichier, le ticket actuel est conservé."
            companyId={entry.companyId}
            accept="image/*,application/pdf"
            capture
            value={ticket}
            onChange={setTicket}
            errors={errors}
            errorName="ticketAttachmentId"
          />
          <div className="space-y-2">
            <Label htmlFor="correct-notes">Remarques</Label>
            <Textarea id="correct-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
            <FieldError errors={errors} name="notes" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="correct-reason">Motif de la correction *</Label>
            <Textarea id="correct-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. erreur de saisie du ticket" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          {correct.error ? <ApiErrorAlert error={correct.error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={correct.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={correct.isPending}>
              {correct.isPending ? 'Correction…' : 'Enregistrer la correction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
