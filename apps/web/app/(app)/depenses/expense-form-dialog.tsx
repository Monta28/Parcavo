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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { ExpenseIncidentOption, ExpenseKind, ExpenseSupplierOption, ExpenseView } from '@/lib/expenses-types';
import { formatDate, formatMoney } from '@/lib/format';
import type { VehicleView } from '@/lib/vehicles-types';
import { todayCivil } from '@/lib/zoned-time';
import { VehiclePicker } from '../interventions/vehicle-picker';
import { companiesWith, costRightsIn } from './expense-rights';

type Allocation = 'vehicule' | 'societe';
/** Inclusion au coût d'exploitation : DEFAUT laisse l'API appliquer le paramètre du groupe. */
export type OperatingChoice = 'DEFAUT' | 'INCLURE' | 'EXCLURE';

/** Montant saisi à la française (virgule, espaces) transmis en chaîne décimale ; l'API le valide sans arrondi. */
export function amountInput(value: string): string {
  return value.trim().replace(/[\s  ]/g, '').replace(',', '.');
}

/**
 * Saisie d'une dépense ou d'un avoir (POST /expenses, costs.write) : clé d'idempotence générée à
 * l'ouverture et conservée pour les nouvelles tentatives du même envoi. La société imputée est calculée
 * par l'API (société gestionnaire du véhicule à la date) ; le justificatif est un fichier privé téléversé
 * au préalable puis rattaché par l'API.
 */
export function ExpenseFormDialog({ defaultCompanyId, onClose }: { defaultCompanyId: string | null; onClose: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const writable = companiesWith(session, 'costs.write');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [kind, setKind] = useState<ExpenseKind>('DEPENSE');
  const [allocation, setAllocation] = useState<Allocation>('vehicule');
  const [vehicle, setVehicle] = useState<VehicleView | null>(null);
  const [companyId, setCompanyId] = useState(() => (defaultCompanyId && writable.some((c) => c.id === defaultCompanyId) ? defaultCompanyId : writable.length === 1 ? (writable[0]?.id ?? '') : ''));
  const [occurredOn, setOccurredOn] = useState(() => todayCivil(session.timezone));
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [supplierId, setSupplierId] = useState(NONE);
  const [reference, setReference] = useState('');
  const [attachment, setAttachment] = useState<UploadedFile | null>(null);
  const [relatedExpenseId, setRelatedExpenseId] = useState(NONE);
  const [relatedIncidentId, setRelatedIncidentId] = useState(NONE);
  const [operating, setOperating] = useState<OperatingChoice>('DEFAUT');
  const [notes, setNotes] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  const targetCompanyId = allocation === 'vehicule' ? (vehicle?.companyId ?? null) : companyId || null;
  const canReadTarget = targetCompanyId ? costRightsIn(session, targetCompanyId).read : false;

  const suppliers = useQuery({
    queryKey: ['suppliers', 'expense-form', targetCompanyId],
    queryFn: () => api<Page<ExpenseSupplierOption>>(`/suppliers${toQuery({ companyId: targetCompanyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(targetCompanyId),
  });
  const originQuery = toQuery({
    companyId: targetCompanyId,
    vehicleId: allocation === 'vehicule' ? vehicle?.id : undefined,
    unallocated: allocation === 'societe' ? 'true' : undefined,
    kind: 'DEPENSE',
    status: 'VALIDEE',
    pageSize: 50,
  });
  const origins = useQuery({
    queryKey: ['expenses', 'origins', originQuery],
    queryFn: () => api<Page<ExpenseView>>(`/expenses${originQuery}`),
    enabled: kind === 'AVOIR' && Boolean(targetCompanyId) && canReadTarget && (allocation === 'societe' || Boolean(vehicle)),
  });
  const incidents = useQuery({
    queryKey: ['incidents', 'expense-form', vehicle?.id],
    queryFn: () => api<Page<ExpenseIncidentOption>>(`/incidents${toQuery({ vehicleId: vehicle?.id, pageSize: 50 })}`),
    enabled: allocation === 'vehicule' && Boolean(vehicle),
  });

  const create = useMutation({
    mutationFn: (confirmDuplicateAttachment: boolean) =>
      api<ExpenseView>('/expenses', {
        method: 'POST',
        idempotencyKey,
        body: {
          kind,
          vehicleId: allocation === 'vehicule' ? vehicle?.id : undefined,
          companyId: allocation === 'societe' ? companyId : undefined,
          occurredOn,
          category,
          amount: amountInput(amount),
          supplierId: supplierId !== NONE ? supplierId : undefined,
          reference: reference.trim() || undefined,
          attachmentId: attachment?.id,
          confirmDuplicateAttachment: confirmDuplicateAttachment || undefined,
          notes: notes.trim() || undefined,
          relatedIncidentId: allocation === 'vehicule' && relatedIncidentId !== NONE ? relatedIncidentId : undefined,
          relatedExpenseId: kind === 'AVOIR' && relatedExpenseId !== NONE ? relatedExpenseId : undefined,
          excludedFromOperatingCost: operating === 'DEFAUT' ? undefined : operating === 'EXCLURE',
        },
      }),
    onSuccess: (created) => {
      const company = session.companies.find((c) => c.id === created.companyId);
      toast.success(`${created.kind === 'AVOIR' ? 'Avoir' : 'Dépense'} enregistré${created.kind === 'AVOIR' ? '' : 'e'} : ${formatMoney(created.signedAmount, created.currency, session.currencyDecimals)} · ${created.allocationLabel}${company ? ` · société ${company.code}` : ''}.`);
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    },
  });
  const duplicate = isApiError(create.error) && create.error.code === 'JUSTIFICATIF_DEJA_UTILISE';
  const errors: FieldErrors = { ...(isApiError(create.error) ? create.error.fieldErrors : {}), ...local };

  const resetLinked = () => {
    setSupplierId(NONE);
    setRelatedExpenseId(NONE);
    setRelatedIncidentId(NONE);
    setAttachment(null);
  };

  const submit = (confirmDuplicate: boolean) => {
    const next: FieldErrors = {};
    if (allocation === 'vehicule' && !vehicle) next.vehicleId = ['Choisissez le véhicule, ou « sans véhicule » pour une dépense société.'];
    if (allocation === 'societe' && !companyId) next.companyId = ['Choisissez la société imputée.'];
    if (!occurredOn) next.occurredOn = ['Indiquez la date de la dépense.'];
    if (!category) next.category = ['Choisissez la catégorie.'];
    if (!amount.trim()) next.amount = ['Indiquez le montant TTC.'];
    setLocal(next);
    if (Object.keys(next).length === 0) create.mutate(confirmDuplicate);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Saisir une dépense ou un avoir</DialogTitle>
          <DialogDescription>
            La société imputée est celle qui gérait le véhicule à la date de la dépense (historique des transferts) ; elle n’est jamais réimputée ensuite. Montant TTC en {session.currency}, {session.currencyDecimals} décimales au plus.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <span id="expense-kind-label" className="text-sm font-medium">
                Nature *
              </span>
              <RadioGroup aria-labelledby="expense-kind-label" value={kind} onValueChange={(v) => setKind(v === 'AVOIR' ? 'AVOIR' : 'DEPENSE')} className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="expense-kind-depense" value="DEPENSE" />
                  <Label htmlFor="expense-kind-depense">Dépense</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="expense-kind-avoir" value="AVOIR" />
                  <Label htmlFor="expense-kind-avoir">Avoir</Label>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground">Un avoir est saisi en montant positif et réduit le coût ; ce n’est pas un paiement.</p>
            </div>
            <div className="space-y-2">
              <span id="expense-allocation-label" className="text-sm font-medium">
                Rattachement *
              </span>
              <RadioGroup
                aria-labelledby="expense-allocation-label"
                value={allocation}
                onValueChange={(v) => {
                  setAllocation(v === 'societe' ? 'societe' : 'vehicule');
                  resetLinked();
                }}
                className="flex flex-wrap gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="expense-allocation-vehicle" value="vehicule" />
                  <Label htmlFor="expense-allocation-vehicle">Un véhicule</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="expense-allocation-company" value="societe" />
                  <Label htmlFor="expense-allocation-company">Sans véhicule</Label>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground">Sans véhicule : assurance, taxes, location ou autre uniquement (ligne « Non ventilé »).</p>
            </div>
          </div>

          {allocation === 'vehicule' ? (
            <div className="space-y-2">
              <Label htmlFor="expense-vehicle">Véhicule *</Label>
              <VehiclePicker
                id="expense-vehicle"
                vehicle={vehicle}
                allowedCompanyIds={writable.map((c) => c.id)}
                onChange={(v) => {
                  setVehicle(v);
                  resetLinked();
                }}
                invalid={invalid(errors, 'vehicleId')}
                describedBy={describedBy(errors, 'vehicleId')}
              />
              <FieldError errors={errors} name="vehicleId" />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="expense-company">Société imputée *</Label>
              <Select
                value={companyId}
                onValueChange={(v) => {
                  setCompanyId(v);
                  resetLinked();
                }}
              >
                <SelectTrigger id="expense-company" className="w-full" aria-invalid={invalid(errors, 'companyId')} aria-describedby={describedBy(errors, 'companyId')}>
                  <SelectValue placeholder="Choisir la société" />
                </SelectTrigger>
                <SelectContent>
                  {writable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="companyId" />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="expense-date">Date de la dépense *</Label>
              <Input id="expense-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} aria-invalid={invalid(errors, 'occurredOn')} aria-describedby={describedBy(errors, 'occurredOn')} />
              <FieldError errors={errors} name="occurredOn" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expense-category">Catégorie *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="expense-category" className="w-full" aria-invalid={invalid(errors, 'category')} aria-describedby={describedBy(errors, 'category')}>
                  <SelectValue placeholder="Choisir" />
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
              <Label htmlFor="expense-amount">Montant TTC ({session.currency}) *</Label>
              <Input id="expense-amount" inputMode="decimal" autoComplete="off" placeholder="0,000" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={invalid(errors, 'amount')} aria-describedby={describedBy(errors, 'amount')} />
              <FieldError errors={errors} name="amount" />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expense-supplier">Fournisseur</Label>
              <Select value={supplierId} onValueChange={setSupplierId} disabled={!targetCompanyId}>
                <SelectTrigger id="expense-supplier" className="w-full" aria-invalid={invalid(errors, 'supplierId')} aria-describedby={describedBy(errors, 'supplierId', 'expense-supplier-hint')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Aucun fournisseur</SelectItem>
                  {(suppliers.data?.items ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="expense-supplier-hint" className="text-xs text-muted-foreground">
                {!targetCompanyId
                  ? 'Choisissez d’abord le véhicule ou la société : seuls ses fournisseurs actifs sont proposés.'
                  : suppliers.isError
                    ? isApiError(suppliers.error)
                      ? suppliers.error.message
                      : 'Liste des fournisseurs indisponible.'
                    : 'Fournisseurs actifs de la société du véhicule.'}
              </p>
              <FieldError errors={errors} name="supplierId" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expense-reference">Référence (facture, ticket)</Label>
              <Input id="expense-reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} aria-invalid={invalid(errors, 'reference')} aria-describedby={describedBy(errors, 'reference')} />
              <FieldError errors={errors} name="reference" />
            </div>
          </div>

          {targetCompanyId ? (
            <AttachmentField
              id="expense-attachment"
              label="Justificatif (facture, ticket)"
              hint="PDF, JPEG ou PNG ; fichier privé, lisible seulement avec la permission de consulter les coûts."
              companyId={targetCompanyId}
              accept="application/pdf,image/jpeg,image/png"
              value={attachment}
              onChange={setAttachment}
              errors={errors}
              errorName="attachmentId"
            />
          ) : (
            <p className="text-sm text-muted-foreground">Justificatif : choisissez d’abord le véhicule ou la société.</p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {kind === 'AVOIR' ? (
              <div className="space-y-2">
                <Label htmlFor="expense-origin">Dépense d’origine</Label>
                <Select value={relatedExpenseId} onValueChange={setRelatedExpenseId} disabled={!origins.data}>
                  <SelectTrigger id="expense-origin" className="w-full" aria-invalid={invalid(errors, 'relatedExpenseId')} aria-describedby={describedBy(errors, 'relatedExpenseId')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Aucune (avoir non rattaché)</SelectItem>
                    {(origins.data?.items ?? []).map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {formatDate(e.occurredOn)} · {e.categoryLabel} · {formatMoney(e.amount, e.currency, session.currencyDecimals)}
                        {e.reference ? ` · ${e.reference}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {targetCompanyId && !canReadTarget ? <p className="text-xs text-muted-foreground">Rattachement indisponible sans la permission de consulter les coûts.</p> : null}
                <FieldError errors={errors} name="relatedExpenseId" />
              </div>
            ) : null}
            {allocation === 'vehicule' ? (
              <div className="space-y-2">
                <Label htmlFor="expense-incident">Incident lié</Label>
                <Select value={relatedIncidentId} onValueChange={setRelatedIncidentId} disabled={!incidents.data}>
                  <SelectTrigger id="expense-incident" className="w-full" aria-invalid={invalid(errors, 'relatedIncidentId')} aria-describedby={describedBy(errors, 'relatedIncidentId')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Aucun incident</SelectItem>
                    {(incidents.data?.items ?? []).map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.reference} · {formatDate(i.occurredAt, session.timezone)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={errors} name="relatedIncidentId" />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="expense-operating">Coût d’exploitation</Label>
              <Select value={operating} onValueChange={(v) => setOperating(v === 'INCLURE' || v === 'EXCLURE' ? v : 'DEFAUT')}>
                <SelectTrigger id="expense-operating" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEFAUT">Selon le paramétrage du groupe</SelectItem>
                  <SelectItem value="INCLURE">Inclure dans le coût d’exploitation</SelectItem>
                  <SelectItem value="EXCLURE">Exclure (conservée à titre informatif)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Par défaut, un achat de véhicule est exclu du coût d’exploitation (paramètre du groupe).</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-notes">Notes</Label>
            <Textarea id="expense-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
            <FieldError errors={errors} name="notes" />
          </div>

          <ApiErrorAlert error={create.error}>
            {duplicate ? (
              <Button type="button" variant="outline" size="sm" className="mt-2" disabled={create.isPending} onClick={() => submit(true)}>
                Enregistrer malgré le justificatif déjà utilisé
              </Button>
            ) : null}
          </ApiErrorAlert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Fermer
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Enregistrement…' : 'Enregistrer la dépense'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
