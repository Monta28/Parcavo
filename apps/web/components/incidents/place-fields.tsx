'use client';

import { useQuery } from '@tanstack/react-query';
import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { SupplierView } from '@/lib/suppliers-types';
import type { SiteView } from '@/lib/vehicles-types';
import { type FieldErrors, describedBy, invalid } from './ops-helpers';

export type PlaceMode = 'AUCUN' | 'SITE' | 'GARAGE' | 'LIBRE';

export interface PlaceValue {
  mode: PlaceMode;
  siteId: string;
  garageSupplierId: string;
  locationLabel: string;
}

export const EMPTY_PLACE: PlaceValue = { mode: 'AUCUN', siteId: '', garageSupplierId: '', locationLabel: '' };

export function placeFrom(current: { siteId: string | null; garageSupplierId: string | null; locationLabel: string | null }): PlaceValue {
  if (current.garageSupplierId) return { ...EMPTY_PLACE, mode: 'GARAGE', garageSupplierId: current.garageSupplierId };
  if (current.siteId) return { ...EMPTY_PLACE, mode: 'SITE', siteId: current.siteId };
  if (current.locationLabel) return { ...EMPTY_PLACE, mode: 'LIBRE', locationLabel: current.locationLabel };
  return EMPTY_PLACE;
}

/** Corps de création : seul le lieu choisi est transmis (garage, site ou lieu libre, exclusifs). */
export function placeCreateBody(place: PlaceValue): { siteId?: string; garageSupplierId?: string; locationLabel?: string } {
  if (place.mode === 'SITE' && place.siteId) return { siteId: place.siteId };
  if (place.mode === 'GARAGE' && place.garageSupplierId) return { garageSupplierId: place.garageSupplierId };
  if (place.mode === 'LIBRE' && place.locationLabel.trim()) return { locationLabel: place.locationLabel.trim() };
  return {};
}

/** Corps de modification : les trois champs sont envoyés pour remplacer le lieu enregistré (null = effacé). */
export function placeUpdateBody(place: PlaceValue): { siteId: string | null; garageSupplierId: string | null; locationLabel: string | null } {
  return {
    siteId: place.mode === 'SITE' && place.siteId ? place.siteId : null,
    garageSupplierId: place.mode === 'GARAGE' && place.garageSupplierId ? place.garageSupplierId : null,
    locationLabel: place.mode === 'LIBRE' && place.locationLabel.trim() ? place.locationLabel.trim() : null,
  };
}

export function placeLocalErrors(place: PlaceValue): FieldErrors {
  if (place.mode === 'SITE' && !place.siteId) return { siteId: ['Choisissez un site.'] };
  if (place.mode === 'GARAGE' && !place.garageSupplierId) return { garageSupplierId: ['Choisissez un garage.'] };
  if (place.mode === 'LIBRE' && !place.locationLabel.trim()) return { locationLabel: ['Indiquez le lieu.'] };
  return {};
}

const MODE_LABELS: Record<PlaceMode, string> = {
  AUCUN: 'Non précisé',
  SITE: 'Site de la société',
  GARAGE: 'Garage (fournisseur)',
  LIBRE: 'Lieu libre',
};

/**
 * Lieu d'immobilisation (CDC 7.4) : garage de la société, site de la société ou lieu libre, au choix.
 * Garages : GET /suppliers?category=GARAGE (actifs) ; sites : GET /sites (actifs) de la société du véhicule.
 */
export function PlaceFields({
  idPrefix,
  companyId,
  value,
  onChange,
  errors,
  current,
}: {
  idPrefix: string;
  companyId: string | null;
  value: PlaceValue;
  onChange: (value: PlaceValue) => void;
  errors: FieldErrors;
  current?: { siteId: string | null; siteName: string | null; garageSupplierId: string | null; garageName: string | null };
}) {
  const sites = useQuery({
    queryKey: ['sites', 'actifs', companyId],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(companyId) && value.mode === 'SITE',
  });
  const garages = useQuery({
    queryKey: ['suppliers', 'garages', companyId],
    queryFn: () => api<Page<SupplierView>>(`/suppliers${toQuery({ companyId, category: 'GARAGE', status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(companyId) && value.mode === 'GARAGE',
  });
  const siteOptions = [...(sites.data?.items ?? []).map((s) => ({ id: s.id, label: s.name }))];
  if (current?.siteId && current.siteName && !siteOptions.some((s) => s.id === current.siteId)) siteOptions.push({ id: current.siteId, label: `${current.siteName} (actuel)` });
  const garageOptions = [...(garages.data?.items ?? []).map((g) => ({ id: g.id, label: `${g.name} · ${SUPPLIER_CATEGORY_LABELS[g.category] ?? g.category}` }))];
  if (current?.garageSupplierId && current.garageName && !garageOptions.some((g) => g.id === current.garageSupplierId)) garageOptions.push({ id: current.garageSupplierId, label: `${current.garageName} (actuel)` });

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Lieu d’immobilisation</legend>
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode: mode as PlaceMode })}
        className="grid gap-2 sm:grid-cols-2"
        aria-describedby={`${idPrefix}-place-hint`}
      >
        {(Object.keys(MODE_LABELS) as PlaceMode[]).map((mode) => (
          <div key={mode} className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-place-${mode}`} value={mode} disabled={mode !== 'AUCUN' && mode !== 'LIBRE' && !companyId} />
            <Label htmlFor={`${idPrefix}-place-${mode}`} className="font-normal">
              {MODE_LABELS[mode]}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <p id={`${idPrefix}-place-hint`} className="text-xs text-muted-foreground">
        Un seul lieu : garage, site ou lieu libre.{companyId ? '' : ' Choisissez d’abord le véhicule pour proposer ses sites et garages.'}
      </p>
      {value.mode === 'SITE' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-site`}>Site *</Label>
          <Select value={value.siteId} onValueChange={(siteId) => onChange({ ...value, siteId })}>
            <SelectTrigger id={`${idPrefix}-site`} className="w-full" aria-invalid={invalid(errors, 'siteId')} aria-describedby={describedBy(errors, 'siteId')}>
              <SelectValue placeholder={sites.isPending ? 'Chargement…' : sites.isError ? 'Sites indisponibles' : 'Choisir un site'} />
            </SelectTrigger>
            <SelectContent>
              {siteOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sites.isSuccess && siteOptions.length === 0 ? <p className="text-xs text-muted-foreground">Aucun site actif pour cette société.</p> : null}
          <FieldError errors={errors} name="siteId" />
        </div>
      ) : null}
      {value.mode === 'GARAGE' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-garage`}>Garage *</Label>
          <Select value={value.garageSupplierId} onValueChange={(garageSupplierId) => onChange({ ...value, garageSupplierId })}>
            <SelectTrigger id={`${idPrefix}-garage`} className="w-full" aria-invalid={invalid(errors, 'garageSupplierId')} aria-describedby={describedBy(errors, 'garageSupplierId')}>
              <SelectValue placeholder={garages.isPending ? 'Chargement…' : garages.isError ? 'Garages indisponibles' : 'Choisir un garage'} />
            </SelectTrigger>
            <SelectContent>
              {garageOptions.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {garages.isSuccess && garageOptions.length === 0 ? <p className="text-xs text-muted-foreground">Aucun garage actif dans le répertoire des fournisseurs de cette société.</p> : null}
          <FieldError errors={errors} name="garageSupplierId" />
        </div>
      ) : null}
      {value.mode === 'LIBRE' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-location`}>Lieu *</Label>
          <Input
            id={`${idPrefix}-location`}
            maxLength={200}
            value={value.locationLabel}
            onChange={(e) => onChange({ ...value, locationLabel: e.target.value })}
            placeholder="Ex. dépanneuse, parking client"
            aria-invalid={invalid(errors, 'locationLabel')}
            aria-describedby={describedBy(errors, 'locationLabel')}
          />
          <FieldError errors={errors} name="locationLabel" />
        </div>
      ) : null}
    </fieldset>
  );
}

/** Libellé du lieu enregistré (valeurs de l'API). */
export function placeLabel(i: { siteName: string | null; garageName: string | null; locationLabel: string | null }): string {
  if (i.garageName) return `Garage ${i.garageName}`;
  if (i.siteName) return `Site ${i.siteName}`;
  return i.locationLabel ?? '—';
}
