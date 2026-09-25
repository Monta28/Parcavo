'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { type FieldErrors, NONE, describedBy, invalid } from '@/components/incidents/ops-helpers';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { fullName } from '@/lib/format';
import { FUEL_ENERGIES } from '@/lib/fuel-types';
import type { SupplierView } from '@/lib/suppliers-types';
import { SearchPicker } from '../utilisations/search-picker';
import { energyLabel } from './fuel-display';

/** Saisie décimale : espaces retirés et virgule acceptée (aucun arrondi ; l'API valide et contrôle). */
export function normalizeDecimal(value: string): string {
  return value.replace(/[\s  ]/g, '').replace(',', '.');
}

/** Contrôle de format uniquement (nombre positif, 3 décimales au plus) avant l'envoi. */
export function isDecimal3(value: string): boolean {
  return /^\d+(\.\d{1,3})?$/.test(value);
}

/**
 * Station ou fournisseur actif de la société (GET /suppliers?companyId=&status=ACTIF). Le fournisseur actuel
 * reste affiché s'il n'est plus proposé (archivé) ; l'API refuse un fournisseur archivé ou d'une autre société.
 */
export function SupplierSelect({
  id,
  companyId,
  value,
  onChange,
  current,
  errors,
  errorName = 'supplierId',
  label = 'Station / fournisseur',
  noneLabel = 'Non précisée',
}: {
  id: string;
  companyId: string | null;
  value: string;
  onChange: (value: string) => void;
  current?: { id: string; name: string } | null;
  errors: FieldErrors;
  errorName?: string;
  label?: string;
  noneLabel?: string;
}) {
  const suppliers = useQuery({
    queryKey: ['suppliers', 'carburant', companyId],
    queryFn: () => api<Page<SupplierView>>(`/suppliers${toQuery({ companyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(companyId),
  });
  const items = [...(suppliers.data?.items ?? [])].sort((a, b) => Number(b.category === 'STATION') - Number(a.category === 'STATION') || a.name.localeCompare(b.name, 'fr'));
  const showCurrent = current && !items.some((s) => s.id === current.id);
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)} disabled={!companyId}>
        <SelectTrigger id={id} className="w-full" aria-invalid={invalid(errors, errorName)} aria-describedby={describedBy(errors, errorName, hintId)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {showCurrent ? <SelectItem value={current.id}>{current.name} (actuel)</SelectItem> : null}
          {items.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name} · {SUPPLIER_CATEGORY_LABELS[s.category] ?? s.category}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        {!companyId
          ? 'Choisissez d’abord le véhicule : seuls les fournisseurs de sa société sont proposés.'
          : suppliers.isPending
            ? 'Chargement des fournisseurs…'
            : suppliers.isError
              ? isApiError(suppliers.error)
                ? suppliers.error.message
                : 'Liste des fournisseurs indisponible.'
              : items.length === 0
                ? 'Aucun fournisseur actif enregistré pour la société du véhicule.'
                : 'Fournisseurs actifs de la société du véhicule (stations en premier).'}
      </p>
      <FieldError errors={errors} name={errorName} />
    </div>
  );
}

interface DriverOption {
  id: string;
  label: string;
  code: string | null;
}

/**
 * Conducteur facultatif : recherche côté API (GET /drivers?companyId=&status=ACTIF&q=), sans limite de
 * liste (un parc peut compter des centaines de conducteurs par société) ; l'API vérifie le périmètre.
 */
export function DriverSelect({
  id,
  companyId,
  value,
  onChange,
  current,
  errors,
}: {
  id: string;
  companyId: string | null;
  value: string;
  onChange: (value: string) => void;
  current?: { id: string; name: string } | null;
  errors: FieldErrors;
}) {
  const [picked, setPicked] = useState<DriverOption | null>(null);
  const currentOption: DriverOption | null = current ? { id: current.id, label: current.name, code: null } : null;
  const selected = !value ? null : picked?.id === value ? picked : currentOption?.id === value ? currentOption : null;
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Conducteur</Label>
      <SearchPicker<DriverOption>
        id={id}
        value={selected}
        onChange={(option) => {
          setPicked(option);
          onChange(option?.id ?? '');
        }}
        queryKey={['drivers', 'carburant', companyId]}
        search={async (term) =>
          (await api<Page<DriverView>>(`/drivers${toQuery({ companyId, status: 'ACTIF', q: term, pageSize: 20, sort: 'lastName' })}`)).items.map((d) => ({ id: d.id, label: fullName(d), code: d.code }))
        }
        itemKey={(d) => d.id}
        itemLabel={(d) => (d.code ? `${d.label} · ${d.code}` : d.label)}
        renderItem={(d) => (
          <>
            <span className="font-medium">{d.label}</span>
            {d.code ? <span className="block text-xs text-muted-foreground">{d.code}</span> : null}
          </>
        )}
        placeholder="Non précisé"
        searchPlaceholder="Code, nom ou prénom…"
        emptyText="Aucun conducteur actif trouvé."
        clearLabel="Retirer le conducteur"
        disabled={!companyId}
        invalid={invalid(errors, 'driverId')}
        describedBy={describedBy(errors, 'driverId', hintId)}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {!companyId ? 'Choisissez d’abord le véhicule.' : 'Facultatif : conducteur ayant fait le plein (conducteurs actifs de la société du véhicule).'}
      </p>
      <FieldError errors={errors} name="driverId" />
    </div>
  );
}

/**
 * Carburant du plein : par défaut, celui de la fiche véhicule (déterminé par le serveur). Pour un véhicule
 * hybride ou sans énergie renseignée, l'API demande de le préciser (erreur affichée sur ce champ).
 */
export function EnergySelect({ id, value, onChange, vehicleEnergy, errors, defaultLabel }: { id: string; value: string; onChange: (value: string) => void; vehicleEnergy: string | null; errors: FieldErrors; defaultLabel?: string }) {
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Carburant</Label>
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
        <SelectTrigger id={id} className="w-full" aria-invalid={invalid(errors, 'energy')} aria-describedby={describedBy(errors, 'energy', hintId)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{defaultLabel ?? `Selon la fiche du véhicule${vehicleEnergy ? ` (${energyLabel(vehicleEnergy)})` : ''}`}</SelectItem>
          {FUEL_ENERGIES.map((e) => (
            <SelectItem key={e} value={e}>
              {energyLabel(e)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        Énergie de la fiche : {vehicleEnergy ? energyLabel(vehicleEnergy) : 'non renseignée'}. Le serveur refuse un carburant incompatible avec le véhicule.
      </p>
      <FieldError errors={errors} name="energy" />
    </div>
  );
}

/** Plein complet ou partiel : choix explicite, sans valeur par défaut (D-226). */
export function FullTankField({ idPrefix, value, onChange, errors, large = false }: { idPrefix: string; value: boolean | null; onChange: (value: boolean) => void; errors: FieldErrors; large?: boolean }) {
  const labelId = `${idPrefix}-label`;
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm leading-none font-medium">
        Type de plein *
      </p>
      <RadioGroup
        aria-labelledby={labelId}
        aria-invalid={invalid(errors, 'isFullTank')}
        aria-describedby={describedBy(errors, 'isFullTank')}
        value={value === null ? '' : value ? 'complet' : 'partiel'}
        onValueChange={(v) => onChange(v === 'complet')}
        className={large ? 'grid-cols-1 gap-2 sm:grid-cols-2' : 'grid-cols-2'}
      >
        <div className={large ? 'flex items-center gap-3 rounded-md border p-3' : 'flex items-center gap-2'}>
          <RadioGroupItem id={`${idPrefix}-complet`} value="complet" />
          <Label htmlFor={`${idPrefix}-complet`} className="font-normal">
            Plein complet
          </Label>
        </div>
        <div className={large ? 'flex items-center gap-3 rounded-md border p-3' : 'flex items-center gap-2'}>
          <RadioGroupItem id={`${idPrefix}-partiel`} value="partiel" />
          <Label htmlFor={`${idPrefix}-partiel`} className="font-normal">
            Plein partiel
          </Label>
        </div>
      </RadioGroup>
      <FieldError errors={errors} name="isFullTank" />
    </div>
  );
}
