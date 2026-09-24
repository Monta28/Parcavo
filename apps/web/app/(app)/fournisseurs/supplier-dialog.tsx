'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid, useOperationalCompanies } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { SupplierCategory, SupplierView } from '@/lib/suppliers-types';

interface FormState {
  companyId: string;
  name: string;
  category: SupplierCategory | '';
  contactName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

function initial(supplier: SupplierView | undefined, companyId: string): FormState {
  return {
    companyId: supplier?.companyId ?? companyId,
    name: supplier?.name ?? '',
    category: supplier?.category ?? '',
    contactName: supplier?.contactName ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    notes: supplier?.notes ?? '',
  };
}

/** Création (POST /suppliers) ou modification (PATCH /suppliers/:id, expectedVersion) d'un fournisseur. */
export function SupplierDialog({ supplier, onOpenChange }: { supplier?: SupplierView; onOpenChange: (open: boolean) => void }) {
  const { companyId, session } = useAppScope();
  const companies = useOperationalCompanies();
  const queryClient = useQueryClient();
  const defaultCompany = companyId ?? (companies.length === 1 ? (companies[0]?.id ?? '') : '');
  const [form, setForm] = useState<FormState>(() => initial(supplier, defaultCompany));
  const [local, setLocal] = useState<FieldErrors>({});
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () =>
      supplier
        ? api<SupplierView>(`/suppliers/${supplier.id}`, {
            method: 'PATCH',
            body: {
              name: form.name.trim(),
              category: form.category,
              contactName: form.contactName.trim() || null,
              phone: form.phone.trim() || null,
              email: form.email.trim() || null,
              address: form.address.trim() || null,
              notes: form.notes.trim() || null,
              expectedVersion: supplier.version,
            },
          })
        : api<SupplierView>('/suppliers', {
            method: 'POST',
            body: {
              companyId: form.companyId,
              name: form.name.trim(),
              category: form.category,
              contactName: form.contactName.trim() || undefined,
              phone: form.phone.trim() || undefined,
              email: form.email.trim() || undefined,
              address: form.address.trim() || undefined,
              notes: form.notes.trim() || undefined,
            },
          }),
    onSuccess: (saved) => {
      toast.success(supplier ? `Fournisseur « ${saved.name} » mis à jour.` : `Fournisseur « ${saved.name} » créé.`);
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(isApiError(error) ? error.message : 'Enregistrement impossible.');
      // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
      if (isApiError(error) && error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
        onOpenChange(false);
      }
    },
  });
  const errors = { ...errorsOf(save.error), ...local };
  const companyLabel = (id: string) => {
    const c = session.companies.find((x) => x.id === id);
    return c ? `${c.code} · ${c.name}` : '—';
  };

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{supplier ? `Modifier le fournisseur ${supplier.name}` : 'Nouveau fournisseur'}</DialogTitle>
          <DialogDescription>
            {supplier ? 'La société de rattachement n’est pas modifiable. Une version obsolète est refusée.' : 'Le répertoire est tenu par société : le fournisseur ne sera proposé que pour les véhicules de cette société.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (!supplier && !form.companyId) next.companyId = ['Choisissez la société.'];
            if (form.name.trim().length < 2) next.name = ['Indiquez le nom (2 caractères au moins).'];
            if (!form.category) next.category = ['Choisissez la catégorie.'];
            setLocal(next);
            if (Object.keys(next).length === 0) save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="supplier-company">Société {supplier ? '' : '*'}</Label>
            {supplier ? (
              <Input id="supplier-company" value={companyLabel(supplier.companyId)} readOnly disabled />
            ) : (
              <Select value={form.companyId} onValueChange={(v) => update({ companyId: v })}>
                <SelectTrigger id="supplier-company" className="w-full" aria-invalid={invalid(errors, 'companyId')} aria-describedby={describedBy(errors, 'companyId')}>
                  <SelectValue placeholder="Choisir une société" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <FieldError errors={errors} name="companyId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-category">Catégorie *</Label>
            <Select value={form.category} onValueChange={(v) => update({ category: v as SupplierCategory })}>
              <SelectTrigger id="supplier-category" className="w-full" aria-invalid={invalid(errors, 'category')} aria-describedby={describedBy(errors, 'category')}>
                <SelectValue placeholder="Choisir une catégorie" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SUPPLIER_CATEGORY_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={errors} name="category" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="supplier-name">Nom *</Label>
            <Input id="supplier-name" maxLength={160} value={form.name} onChange={(e) => update({ name: e.target.value })} aria-invalid={invalid(errors, 'name')} aria-describedby={describedBy(errors, 'name')} />
            <FieldError errors={errors} name="name" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-contact">Contact</Label>
            <Input id="supplier-contact" maxLength={160} value={form.contactName} onChange={(e) => update({ contactName: e.target.value })} aria-invalid={invalid(errors, 'contactName')} aria-describedby={describedBy(errors, 'contactName')} />
            <FieldError errors={errors} name="contactName" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-phone">Téléphone</Label>
            <Input id="supplier-phone" type="tel" maxLength={40} value={form.phone} onChange={(e) => update({ phone: e.target.value })} aria-invalid={invalid(errors, 'phone')} aria-describedby={describedBy(errors, 'phone')} />
            <FieldError errors={errors} name="phone" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="supplier-email">E-mail</Label>
            <Input id="supplier-email" type="email" maxLength={200} value={form.email} onChange={(e) => update({ email: e.target.value })} aria-invalid={invalid(errors, 'email')} aria-describedby={describedBy(errors, 'email')} />
            <FieldError errors={errors} name="email" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="supplier-address">Adresse</Label>
            <Textarea id="supplier-address" rows={2} maxLength={500} value={form.address} onChange={(e) => update({ address: e.target.value })} aria-invalid={invalid(errors, 'address')} aria-describedby={describedBy(errors, 'address')} />
            <FieldError errors={errors} name="address" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="supplier-notes">Notes</Label>
            <Textarea id="supplier-notes" rows={3} maxLength={2000} value={form.notes} onChange={(e) => update({ notes: e.target.value })} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
            <FieldError errors={errors} name="notes" />
          </div>
          {save.error ? (
            <div className="sm:col-span-2">
              <ApiErrorAlert error={save.error} />
            </div>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : supplier ? 'Enregistrer' : 'Créer le fournisseur'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
