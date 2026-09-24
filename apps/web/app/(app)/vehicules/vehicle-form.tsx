'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ENERGY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { SiteView, VehicleCategory, VehicleView } from '@/lib/vehicles-types';

const NONE = '__none__';
const OWNERSHIP = { ACHAT: 'Achat', LOCATION: 'Location', LEASING: 'Leasing', AUTRE: 'Autre' } as const;

interface FormState {
  companyId: string;
  code: string;
  registration: string;
  provisionalRegistration: boolean;
  make: string;
  model: string;
  categoryId: string;
  vin: string;
  year: string;
  commissioningDate: string;
  energy: string;
  tankCapacityLiters: string;
  siteId: string;
  ownershipMode: string;
  contractEndDate: string;
  notes: string;
}

function initial(vehicle: VehicleView | undefined, defaultCompanyId: string): FormState {
  return {
    companyId: vehicle?.companyId ?? defaultCompanyId,
    code: vehicle?.code ?? '',
    registration: vehicle?.registration ?? '',
    provisionalRegistration: vehicle?.provisionalRegistration ?? false,
    make: vehicle?.make ?? '',
    model: vehicle?.model ?? '',
    categoryId: vehicle?.categoryId ?? '',
    vin: vehicle?.vin ?? '',
    year: vehicle?.year?.toString() ?? '',
    commissioningDate: vehicle?.commissioningDate ?? '',
    energy: vehicle?.energy ?? NONE,
    tankCapacityLiters: vehicle?.tankCapacityLiters ? String(Number(vehicle.tankCapacityLiters)) : '',
    siteId: vehicle?.siteId ?? NONE,
    ownershipMode: vehicle?.ownershipMode ?? NONE,
    contractEndDate: vehicle?.contractEndDate ?? '',
    notes: vehicle?.notes ?? '',
  };
}

export function VehicleForm({ vehicle }: { vehicle?: VehicleView }) {
  const router = useRouter();
  const { session, companyId } = useAppScope();
  const editableCompanies = session.companies.filter((c) => session.isAdmin || session.grants.some((g) => g.companyId === c.id && (g.role === 'CHEF_PARC' || g.role === 'OPERATEUR')));
  const [form, setForm] = useState<FormState>(() => initial(vehicle, companyId ?? editableCompanies[0]?.id ?? ''));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const categories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories') });
  const sites = useQuery({ queryKey: ['sites', form.companyId], queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: form.companyId, pageSize: 100, status: 'ACTIF' })}`), enabled: Boolean(form.companyId) });
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        registration: form.registration,
        provisionalRegistration: form.provisionalRegistration,
        make: form.make,
        model: form.model,
        categoryId: form.categoryId,
        vin: form.vin || (vehicle ? null : undefined),
        year: form.year ? Number(form.year) : vehicle ? null : undefined,
        commissioningDate: form.commissioningDate || (vehicle ? null : undefined),
        energy: form.energy === NONE ? (vehicle ? null : undefined) : form.energy,
        tankCapacityLiters: form.tankCapacityLiters || (vehicle ? null : undefined),
        siteId: form.siteId === NONE ? (vehicle ? null : undefined) : form.siteId,
        ownershipMode: form.ownershipMode === NONE ? (vehicle ? null : undefined) : form.ownershipMode,
        contractEndDate: form.contractEndDate || (vehicle ? null : undefined),
        notes: form.notes || (vehicle ? null : undefined),
      };
      return vehicle
        ? api<VehicleView>(`/vehicles/${vehicle.id}`, { method: 'PATCH', body: { ...payload, expectedVersion: vehicle.version } })
        : api<VehicleView>('/vehicles', { method: 'POST', body: { ...payload, companyId: form.companyId, code: form.code } });
    },
    onSuccess: (saved) => {
      toast.success(vehicle ? 'Véhicule mis à jour.' : 'Véhicule créé.');
      router.push(`/vehicules/${saved.id}`);
      router.refresh();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Enregistrement impossible.');
    },
  });

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
          {!vehicle ? (
            <div className="space-y-2">
              <Label htmlFor="companyId">Société *</Label>
              <Select value={form.companyId} onValueChange={(v) => update({ companyId: v, siteId: NONE })}>
                <SelectTrigger id="companyId">
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
          {!vehicle ? (
            <div className="space-y-2">
              <Label htmlFor="code">Code interne *</Label>
              <Input id="code" required value={form.code} onChange={(e) => update({ code: e.target.value })} aria-describedby="code-error" />
              <FieldError errors={fieldErrors} name="code" />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="registration">Immatriculation ou identifiant provisoire *</Label>
            <Input id="registration" required value={form.registration} onChange={(e) => update({ registration: e.target.value })} />
            <FieldError errors={fieldErrors} name="registration" />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.provisionalRegistration} onCheckedChange={(v) => update({ provisionalRegistration: v === true })} /> Identifiant provisoire
            </label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="categoryId">Catégorie *</Label>
            <Select value={form.categoryId} onValueChange={(v) => update({ categoryId: v })}>
              <SelectTrigger id="categoryId">
                <SelectValue placeholder="Catégorie" />
              </SelectTrigger>
              <SelectContent>
                {(categories.data ?? []).filter((c) => c.status === 'ACTIF').map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={fieldErrors} name="categoryId" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="make">Marque *</Label>
            <Input id="make" required value={form.make} onChange={(e) => update({ make: e.target.value })} />
            <FieldError errors={fieldErrors} name="make" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="model">Modèle *</Label>
            <Input id="model" required value={form.model} onChange={(e) => update({ model: e.target.value })} />
            <FieldError errors={fieldErrors} name="model" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vin">VIN</Label>
            <Input id="vin" value={form.vin} onChange={(e) => update({ vin: e.target.value })} />
            <FieldError errors={fieldErrors} name="vin" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="year">Année</Label>
            <Input id="year" type="number" min={1950} max={2100} value={form.year} onChange={(e) => update({ year: e.target.value })} />
            <FieldError errors={fieldErrors} name="year" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="commissioningDate">Mise en service</Label>
            <Input id="commissioningDate" type="date" value={form.commissioningDate} onChange={(e) => update({ commissioningDate: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="energy">Carburant / énergie</Label>
            <Select value={form.energy} onValueChange={(v) => update({ energy: v })}>
              <SelectTrigger id="energy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Non renseigné</SelectItem>
                {Object.entries(ENERGY_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tank">Capacité du réservoir (L)</Label>
            <Input id="tank" type="number" min={0} step="0.1" value={form.tankCapacityLiters} onChange={(e) => update({ tankCapacityLiters: e.target.value })} />
            <FieldError errors={fieldErrors} name="tankCapacityLiters" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="siteId">Site</Label>
            <Select value={form.siteId} onValueChange={(v) => update({ siteId: v })}>
              <SelectTrigger id="siteId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Aucun</SelectItem>
                {(sites.data?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ownership">Acquisition / location / leasing</Label>
            <Select value={form.ownershipMode} onValueChange={(v) => update({ ownershipMode: v })}>
              <SelectTrigger id="ownership">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Non renseigné</SelectItem>
                {Object.entries(OWNERSHIP).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="contractEnd">Fin de contrat</Label>
            <Input id="contractEnd" type="date" value={form.contractEndDate} onChange={(e) => update({ contractEndDate: e.target.value })} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => update({ notes: e.target.value })} />
          </div>
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : vehicle ? 'Enregistrer' : 'Créer le véhicule'}
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
