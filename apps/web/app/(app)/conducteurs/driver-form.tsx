'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DepartmentView, DriverView } from '@/lib/drivers-types';
import type { SiteView } from '@/lib/vehicles-types';

const NONE = '__none__';

interface FormState {
  companyId: string;
  code: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  siteId: string;
  departmentId: string;
  notes: string;
}

function initial(driver: DriverView | undefined, defaultCompanyId: string): FormState {
  return {
    companyId: driver?.companyId ?? defaultCompanyId,
    code: driver?.code ?? '',
    firstName: driver?.firstName ?? '',
    lastName: driver?.lastName ?? '',
    phone: driver?.phone ?? '',
    email: driver?.email ?? '',
    siteId: driver?.siteId ?? NONE,
    departmentId: driver?.departmentId ?? NONE,
    notes: driver?.notes ?? '',
  };
}

export function DriverForm({ driver }: { driver?: DriverView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, companyId } = useAppScope();
  const editableCompanies = session.companies.filter((c) => session.isAdmin || session.grants.some((g) => g.companyId === c.id && (g.role === 'CHEF_PARC' || g.role === 'OPERATEUR')));
  const [form, setForm] = useState<FormState>(() => initial(driver, companyId && editableCompanies.some((c) => c.id === companyId) ? companyId : (editableCompanies[0]?.id ?? '')));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const sites = useQuery({
    queryKey: ['sites', form.companyId, 'all'],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: form.companyId, pageSize: 100 })}`),
    enabled: Boolean(form.companyId),
  });
  const departments = useQuery({
    queryKey: ['departments', form.companyId],
    queryFn: () => api<DepartmentView[]>(`/departments${toQuery({ companyId: form.companyId })}`),
    enabled: Boolean(form.companyId),
  });
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  // Les éléments archivés restent visibles uniquement s'ils sont déjà rattachés au conducteur.
  const siteOptions = (sites.data?.items ?? []).filter((s) => s.status === 'ACTIF' || s.id === driver?.siteId);
  const departmentOptions = (departments.data ?? []).filter((d) => d.status === 'ACTIF' || d.id === driver?.departmentId);

  const save = useMutation({
    mutationFn: () => {
      const optional = (value: string) => (value.trim() ? value.trim() : driver ? null : undefined);
      const payload = {
        firstName: form.firstName,
        lastName: form.lastName,
        phone: optional(form.phone),
        email: optional(form.email),
        siteId: form.siteId === NONE ? (driver ? null : undefined) : form.siteId,
        departmentId: form.departmentId === NONE ? (driver ? null : undefined) : form.departmentId,
        notes: optional(form.notes),
      };
      return driver
        ? api<DriverView>(`/drivers/${driver.id}`, { method: 'PATCH', body: { ...payload, expectedVersion: driver.version } })
        : api<DriverView>('/drivers', { method: 'POST', body: { ...payload, companyId: form.companyId, code: form.code } });
    },
    onSuccess: (saved) => {
      toast.success(driver ? 'Conducteur mis à jour.' : 'Conducteur créé.');
      queryClient.setQueryData(['driver', saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      router.push(`/conducteurs/${saved.id}`);
      router.refresh();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la fiche est rechargée pour repartir de l'état enregistré.
        if (error.status === 409 && driver) void queryClient.invalidateQueries({ queryKey: ['driver', driver.id] });
      } else toast.error('Enregistrement impossible.');
    },
  });

  if (!driver && editableCompanies.length === 0) {
    return <EmptyState title="Création non autorisée" description="La création d’un conducteur est réservée aux opérateurs, chefs de parc et administrateurs des sociétés de votre périmètre." />;
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form
          className="grid gap-4 md:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            save.mutate();
          }}
        >
          {!driver ? (
            <div className="space-y-2">
              <Label htmlFor="companyId">Société *</Label>
              <Select value={form.companyId} onValueChange={(v) => update({ companyId: v, siteId: NONE, departmentId: NONE })}>
                <SelectTrigger id="companyId" aria-describedby="companyId-error">
                  <SelectValue placeholder="Société" />
                </SelectTrigger>
                <SelectContent>
                  {editableCompanies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={fieldErrors} name="companyId" />
            </div>
          ) : null}
          {!driver ? (
            <div className="space-y-2">
              <Label htmlFor="code">Identifiant interne *</Label>
              <Input id="code" required maxLength={30} value={form.code} onChange={(e) => update({ code: e.target.value })} aria-describedby="code-hint code-error" aria-invalid={Boolean(fieldErrors.code)} />
              <p id="code-hint" className="text-xs text-muted-foreground">
                Commence par une lettre ou un chiffre ; lettres, chiffres, « _ », « . » ou « - » ; 30 caractères maximum. Non modifiable ensuite.
              </p>
              <FieldError errors={fieldErrors} name="code" />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="lastName">Nom *</Label>
            <Input id="lastName" required maxLength={100} autoComplete="family-name" value={form.lastName} onChange={(e) => update({ lastName: e.target.value })} aria-describedby="lastName-error" aria-invalid={Boolean(fieldErrors.lastName)} />
            <FieldError errors={fieldErrors} name="lastName" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="firstName">Prénom *</Label>
            <Input id="firstName" required maxLength={100} autoComplete="given-name" value={form.firstName} onChange={(e) => update({ firstName: e.target.value })} aria-describedby="firstName-error" aria-invalid={Boolean(fieldErrors.firstName)} />
            <FieldError errors={fieldErrors} name="firstName" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Téléphone</Label>
            <Input id="phone" type="tel" maxLength={50} autoComplete="tel" value={form.phone} onChange={(e) => update({ phone: e.target.value })} aria-describedby="phone-error" aria-invalid={Boolean(fieldErrors.phone)} />
            <FieldError errors={fieldErrors} name="phone" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(e) => update({ email: e.target.value })} aria-describedby="email-error" aria-invalid={Boolean(fieldErrors.email)} />
            <FieldError errors={fieldErrors} name="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="siteId">Site</Label>
            <Select value={form.siteId} onValueChange={(v) => update({ siteId: v })} disabled={!form.companyId}>
              <SelectTrigger id="siteId" aria-describedby="siteId-error">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Aucun</SelectItem>
                {siteOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.status !== 'ACTIF' ? ' (archivé)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sites.isError ? <p className="text-sm text-destructive">Impossible de charger les sites.</p> : null}
            <FieldError errors={fieldErrors} name="siteId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="departmentId">Service</Label>
            <Select value={form.departmentId} onValueChange={(v) => update({ departmentId: v })} disabled={!form.companyId}>
              <SelectTrigger id="departmentId" aria-describedby="departmentId-error">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Aucun</SelectItem>
                {departmentOptions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.status !== 'ACTIF' ? ' (archivé)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {departments.isError ? <p className="text-sm text-destructive">Impossible de charger les services.</p> : null}
            <FieldError errors={fieldErrors} name="departmentId" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" maxLength={2000} value={form.notes} onChange={(e) => update({ notes: e.target.value })} aria-describedby="notes-error" aria-invalid={Boolean(fieldErrors.notes)} />
            <FieldError errors={fieldErrors} name="notes" />
          </div>
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={save.isPending || (!driver && !form.companyId)}>
              {save.isPending ? 'Enregistrement…' : driver ? 'Enregistrer' : 'Créer le conducteur'}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
