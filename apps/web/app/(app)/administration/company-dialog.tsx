'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { CompanyView } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

interface FormState {
  code: string;
  legalName: string;
  address: string;
  phone: string;
  email: string;
  taxIdentifier: string;
  telemetryEnabled: boolean;
}

function initial(company: CompanyView | undefined): FormState {
  return {
    code: company?.code ?? '',
    legalName: company?.legalName ?? '',
    address: company?.address ?? '',
    phone: company?.phone ?? '',
    email: company?.email ?? '',
    taxIdentifier: company?.taxIdentifier ?? '',
    telemetryEnabled: company?.telemetryEnabled ?? false,
  };
}

/** Création (POST /companies) ou modification (PATCH /companies/:id) d'une société. */
export function CompanyDialog({ company, onOpenChange, onSaved }: { company?: CompanyView; onOpenChange: (open: boolean) => void; onSaved: (saved: CompanyView) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initial(company));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () =>
      company
        ? api<CompanyView>(`/companies/${company.id}`, {
            method: 'PATCH',
            body: {
              legalName: form.legalName,
              address: form.address.trim() || null,
              phone: form.phone.trim() || null,
              email: form.email.trim() || null,
              taxIdentifier: form.taxIdentifier.trim() || null,
              telemetryEnabled: form.telemetryEnabled,
              expectedVersion: company.version,
            },
          })
        : api<CompanyView>('/companies', {
            method: 'POST',
            body: {
              code: form.code,
              legalName: form.legalName,
              address: form.address.trim() || undefined,
              phone: form.phone.trim() || undefined,
              email: form.email.trim() || undefined,
              taxIdentifier: form.taxIdentifier.trim() || undefined,
            },
          }),
    onSuccess: (saved) => {
      toast.success(company ? 'Société mise à jour.' : 'Société créée.');
      onSaved(saved);
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['companies'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{company ? `Modifier la société ${company.code}` : 'Nouvelle société'}</DialogTitle>
          <DialogDescription>
            {company ? 'Le code société n’est pas modifiable. Une version obsolète est refusée.' : 'Le code est unique dans l’organisation et ne pourra plus être modifié.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            save.mutate();
          }}
        >
          {company ? (
            <div className="space-y-2">
              <Label htmlFor="company-code">Code</Label>
              <Input id="company-code" value={company.code} readOnly disabled />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="company-code">Code *</Label>
              <Input
                id="company-code"
                required
                autoComplete="off"
                value={form.code}
                onChange={(e) => update({ code: e.target.value })}
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby="code-hint code-error"
              />
              <p id="code-hint" className="text-xs text-muted-foreground">
                Majuscules, chiffres, tirets ou soulignés ; 20 caractères maximum.
              </p>
              <FieldError errors={fieldErrors} name="code" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="company-legalName">Raison sociale *</Label>
            <Input
              id="company-legalName"
              required
              value={form.legalName}
              onChange={(e) => update({ legalName: e.target.value })}
              aria-invalid={fieldErrors.legalName ? true : undefined}
              aria-describedby="legalName-error"
            />
            <FieldError errors={fieldErrors} name="legalName" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="company-address">Adresse</Label>
            <Textarea id="company-address" rows={2} value={form.address} onChange={(e) => update({ address: e.target.value })} aria-describedby="address-error" />
            <FieldError errors={fieldErrors} name="address" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="company-phone">Téléphone</Label>
            <Input id="company-phone" type="tel" value={form.phone} onChange={(e) => update({ phone: e.target.value })} aria-describedby="phone-error" />
            <FieldError errors={fieldErrors} name="phone" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="company-email">E-mail</Label>
            <Input
              id="company-email"
              type="email"
              value={form.email}
              onChange={(e) => update({ email: e.target.value })}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby="email-error"
            />
            <FieldError errors={fieldErrors} name="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="company-taxIdentifier">Identifiant fiscal</Label>
            <Input id="company-taxIdentifier" value={form.taxIdentifier} onChange={(e) => update({ taxIdentifier: e.target.value })} aria-describedby="taxIdentifier-error" />
            <FieldError errors={fieldErrors} name="taxIdentifier" />
          </div>
          {company ? (
            <div className="space-y-2 sm:col-span-2">
              <div className="flex items-start gap-3 rounded-md border p-3">
                <Switch id="company-telemetry" checked={form.telemetryEnabled} onCheckedChange={(checked) => update({ telemetryEnabled: checked })} aria-describedby="telemetry-hint" />
                <div className="space-y-1">
                  <Label htmlFor="company-telemetry">Télématique activée</Label>
                  <p id="telemetry-hint" className="text-xs text-muted-foreground">
                    Active le module de télématique (F11) pour cette société.
                  </p>
                </div>
              </div>
              <FieldError errors={fieldErrors} name="telemetryEnabled" />
            </div>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : company ? 'Enregistrer' : 'Créer la société'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
