'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { EXPENSE_CATEGORY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, NONE, describedBy, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { AttachmentField, type UploadedFile } from '@/components/odometer/attachment-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { ExpenseSupplierOption, ExpenseView } from '@/lib/expenses-types';
import { formatDate, formatMoney } from '@/lib/format';
import { amountInput } from './expense-form-dialog';

/** Rafraîchit le registre et la synthèse ; sur version obsolète (409), la liste est rechargée. */
function useExpenseCache() {
  const queryClient = useQueryClient();
  return {
    saved(message: string) {
      toast.success(message);
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
    failed(error: unknown) {
      if (isApiError(error) && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  };
}

function ExpenseRecap({ expense }: { expense: ExpenseView }) {
  const { session } = useAppScope();
  return (
    <p className="rounded-md border p-3 text-sm">
      <span className="font-medium">
        {formatDate(expense.occurredOn)} · {expense.categoryLabel} · {formatMoney(expense.signedAmount, expense.currency, session.currencyDecimals)}
      </span>
      <span className="block text-xs text-muted-foreground">
        {expense.allocationLabel}
        {expense.supplierName ? ` · ${expense.supplierName}` : ''}
        {expense.reference ? ` · réf. ${expense.reference}` : ''}
      </span>
    </p>
  );
}

// Correction ------------------------------------------------------------------------------------

/**
 * Correction d'une dépense validée (POST :id/correct ; chef de parc ou administrateur, costs.read et
 * costs.write) : nouvelle version, l'ancienne passe « remplacée ». Seuls les champs modifiés sont
 * transmis ; motif, version attendue et clé d'idempotence obligatoires.
 */
export function CorrectExpenseDialog({ expense, onClose }: { expense: ExpenseView; onClose: () => void }) {
  const { session } = useAppScope();
  const cache = useExpenseCache();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [occurredOn, setOccurredOn] = useState(expense.occurredOn);
  const [category, setCategory] = useState<string>(expense.category);
  const [amount, setAmount] = useState(expense.amount);
  const [supplierId, setSupplierId] = useState(expense.supplierId ?? NONE);
  const [reference, setReference] = useState(expense.reference ?? '');
  const [notes, setNotes] = useState(expense.notes ?? '');
  const [attachment, setAttachment] = useState<UploadedFile | null>(null);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  const suppliers = useQuery({
    queryKey: ['suppliers', 'expense-form', expense.companyId],
    queryFn: () => api<Page<ExpenseSupplierOption>>(`/suppliers${toQuery({ companyId: expense.companyId, status: 'ACTIF', pageSize: 100 })}`),
  });
  const supplierItems = suppliers.data?.items ?? [];
  const showCurrentSupplier = expense.supplierId && !supplierItems.some((s) => s.id === expense.supplierId);

  const correct = useMutation({
    mutationFn: (confirmDuplicateAttachment: boolean) => {
      const body: Record<string, unknown> = { reason: reason.trim(), expectedVersion: expense.version };
      if (occurredOn !== expense.occurredOn) body.occurredOn = occurredOn;
      if (category !== expense.category) body.category = category;
      if (amountInput(amount) !== expense.amount) body.amount = amountInput(amount);
      const nextSupplier = supplierId === NONE ? null : supplierId;
      if (nextSupplier !== expense.supplierId) body.supplierId = nextSupplier;
      const nextReference = reference.trim() || null;
      if (nextReference !== expense.reference) body.reference = nextReference;
      const nextNotes = notes.trim() || null;
      if (nextNotes !== expense.notes) body.notes = nextNotes;
      if (attachment) body.attachmentId = attachment.id;
      if (confirmDuplicateAttachment) body.confirmDuplicateAttachment = true;
      return api<ExpenseView>(`/expenses/${expense.id}/correct`, { method: 'POST', body, idempotencyKey });
    },
    onSuccess: (created) => {
      cache.saved(`Dépense corrigée : nouvelle version de ${formatMoney(created.signedAmount, created.currency, session.currencyDecimals)} ; l’ancienne est conservée comme remplacée.`);
      onClose();
    },
    onError: (error) => cache.failed(error),
  });
  const duplicate = isApiError(correct.error) && correct.error.code === 'JUSTIFICATIF_DEJA_UTILISE';
  const errors: FieldErrors = { ...(isApiError(correct.error) ? correct.error.fieldErrors : {}), ...local };

  const submit = (confirmDuplicate: boolean) => {
    const next: FieldErrors = {};
    if (reason.trim().length < 3) next.reason = ['Indiquez le motif de la correction (3 caractères au moins).'];
    if (!amount.trim()) next.amount = ['Indiquez le montant TTC.'];
    if (!occurredOn) next.occurredOn = ['Indiquez la date de la dépense.'];
    setLocal(next);
    if (Object.keys(next).length === 0) correct.mutate(confirmDuplicate);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !correct.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Corriger la dépense</DialogTitle>
          <DialogDescription>Une dépense validée n’est jamais modifiée : la correction crée une nouvelle version, l’ancienne reste consultable comme « remplacée ». La société imputée ne change pas.</DialogDescription>
        </DialogHeader>
        <ExpenseRecap expense={expense} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="correct-date">Date de la dépense *</Label>
              <Input id="correct-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} aria-invalid={invalid(errors, 'occurredOn')} aria-describedby={describedBy(errors, 'occurredOn')} />
              <FieldError errors={errors} name="occurredOn" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="correct-category">Catégorie *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="correct-category" className="w-full" aria-invalid={invalid(errors, 'category')} aria-describedby={describedBy(errors, 'category')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPENSE_CATEGORY_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="category" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="correct-amount">Montant TTC ({expense.currency}) *</Label>
              <Input id="correct-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={invalid(errors, 'amount')} aria-describedby={describedBy(errors, 'amount')} />
              <FieldError errors={errors} name="amount" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="correct-supplier">Fournisseur</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger id="correct-supplier" className="w-full" aria-invalid={invalid(errors, 'supplierId')} aria-describedby={describedBy(errors, 'supplierId')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Aucun fournisseur</SelectItem>
                  {showCurrentSupplier && expense.supplierId ? <SelectItem value={expense.supplierId}>{expense.supplierName ?? 'Fournisseur actuel'} (actuel)</SelectItem> : null}
                  {supplierItems.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="supplierId" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="correct-reference">Référence (facture, ticket)</Label>
              <Input id="correct-reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} aria-invalid={invalid(errors, 'reference')} aria-describedby={describedBy(errors, 'reference')} />
              <FieldError errors={errors} name="reference" />
            </div>
          </div>
          <AttachmentField
            id="correct-attachment"
            label="Nouveau justificatif"
            hint={expense.attachmentId ? 'Facultatif : sans nouveau fichier, le justificatif actuel est conservé.' : 'Facultatif : PDF, JPEG ou PNG.'}
            companyId={expense.companyId}
            accept="application/pdf,image/jpeg,image/png"
            value={attachment}
            onChange={setAttachment}
            errors={errors}
            errorName="attachmentId"
          />
          <div className="space-y-2">
            <Label htmlFor="correct-notes">Notes</Label>
            <Textarea id="correct-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
            <FieldError errors={errors} name="notes" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="correct-reason">Motif de la correction *</Label>
            <Textarea id="correct-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <ApiErrorAlert error={correct.error}>
            {duplicate ? (
              <Button type="button" variant="outline" size="sm" className="mt-2" disabled={correct.isPending} onClick={() => submit(true)}>
                Enregistrer malgré le justificatif déjà utilisé
              </Button>
            ) : null}
          </ApiErrorAlert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={correct.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={correct.isPending}>
              {correct.isPending ? 'Enregistrement…' : 'Enregistrer la correction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Annulation ------------------------------------------------------------------------------------

/** Annulation motivée (POST :id/cancel) : le coût disparaît de sa période d'origine ; refusée si des avoirs validés s'y rattachent. */
export function CancelExpenseDialog({ expense, onClose }: { expense: ExpenseView; onClose: () => void }) {
  const cache = useExpenseCache();
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const cancel = useMutation({
    mutationFn: () => api<ExpenseView>(`/expenses/${expense.id}/cancel`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: expense.version } }),
    onSuccess: () => {
      cache.saved('Dépense annulée : elle n’est plus comptée dans les totaux de sa période.');
      onClose();
    },
    onError: (error) => cache.failed(error),
  });
  const errors: FieldErrors = { ...(isApiError(cancel.error) ? cancel.error.fieldErrors : {}), ...local };
  return (
    <Dialog open onOpenChange={(open) => !open && !cancel.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Annuler la dépense</DialogTitle>
          <DialogDescription>L’annulation est définitive et tracée (auteur, date, motif). La dépense reste consultable avec le filtre « Annulées ».</DialogDescription>
        </DialogHeader>
        <ExpenseRecap expense={expense} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = reason.trim().length < 3 ? { reason: ['Indiquez le motif de l’annulation (3 caractères au moins).'] } : {};
            setLocal(next);
            if (Object.keys(next).length === 0) cancel.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Motif de l’annulation *</Label>
            <Textarea id="cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <ApiErrorAlert error={cancel.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={cancel.isPending}>
              Fermer
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending ? 'Enregistrement…' : 'Confirmer l’annulation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Coût d'exploitation ---------------------------------------------------------------------------

/** Inclusion ou exclusion du coût d'exploitation (PATCH :id/operating-cost, costs.write et costs.read, auditée). */
export function OperatingCostDialog({ expense, onClose }: { expense: ExpenseView; onClose: () => void }) {
  const cache = useExpenseCache();
  const exclude = !expense.excludedFromOperatingCost;
  const [reason, setReason] = useState('');
  const toggle = useMutation({
    mutationFn: () => api<ExpenseView>(`/expenses/${expense.id}/operating-cost`, { method: 'PATCH', body: { excludedFromOperatingCost: exclude, reason: reason.trim() || undefined, expectedVersion: expense.version } }),
    onSuccess: (updated) => {
      cache.saved(updated.excludedFromOperatingCost ? 'Dépense exclue du coût d’exploitation : elle reste affichée à titre informatif.' : 'Dépense incluse dans le coût d’exploitation.');
      onClose();
    },
    onError: (error) => cache.failed(error),
  });
  const errors: FieldErrors = isApiError(toggle.error) ? toggle.error.fieldErrors : {};
  const title = exclude ? 'Exclure du coût d’exploitation' : 'Inclure dans le coût d’exploitation';
  return (
    <Dialog open onOpenChange={(open) => !open && !toggle.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {exclude
              ? 'La dépense reste au registre et dans la ligne « Hors coût d’exploitation (informatif) », mais ne compte plus dans le coût d’exploitation.'
              : 'La dépense sera comptée dans le coût d’exploitation de sa période et de sa société.'}
          </DialogDescription>
        </DialogHeader>
        <ExpenseRecap expense={expense} />
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            toggle.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="operating-reason">Motif (journal d’audit)</Label>
            <Textarea id="operating-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
            <FieldError errors={errors} name="reason" />
          </div>
          <ApiErrorAlert error={toggle.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={toggle.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={toggle.isPending}>
              {toggle.isPending ? 'Enregistrement…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
