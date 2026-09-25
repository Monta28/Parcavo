'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FUEL_MEASURE_KIND_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { SimulatorBadge } from '@/components/telemetry/telemetry-display';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { FUEL_KIND_HELP, MAPPING_ODOMETER_KIND_HELP, MAPPING_ODOMETER_KIND_LABELS, type FuelKind, type MappingOdometerKind, type UnitView, type UnitsPage } from '@/lib/telemetry-types';
import type { VehicleView } from '@/lib/vehicles-types';

const ODOMETER_KINDS: readonly MappingOdometerKind[] = ['COMPTEUR_CAN', 'DISTANCE_GPS', 'AUCUN'];
const FUEL_KINDS: readonly FuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];

/** Sociétés où l'utilisateur décide des associations (chef de parc) ; toutes pour l'administrateur. */
export function useManagedCompanies(): { isAdmin: boolean; canManage: (companyId: string | null | undefined) => boolean; managedIds: readonly string[] } {
  const { session } = useAppScope();
  return useMemo(() => {
    const managedIds = session.isAdmin ? session.companies.map((c) => c.id) : session.grants.filter((g) => g.role === 'CHEF_PARC').map((g) => g.companyId);
    return { isAdmin: session.isAdmin, managedIds, canManage: (companyId) => Boolean(companyId) && (session.isAdmin || managedIds.includes(companyId as string)) };
  }, [session]);
}

export interface Natures {
  odometerKind: MappingOdometerKind | '';
  fuelKinds: FuelKind[];
}

/**
 * Nature du kilométrage et du carburant d'une association (5.6, 8.5, annexe A) : choix explicite, jamais
 * présélectionné, d'après la réponse écrite du fournisseur pour ce véhicule.
 */
export function NaturesFields({ idPrefix, value, onChange, errors }: { idPrefix: string; value: Natures; onChange: (next: Natures) => void; errors: Record<string, string[]> }) {
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Nature du kilométrage *</legend>
        <RadioGroup value={value.odometerKind} onValueChange={(v) => onChange({ ...value, odometerKind: v as MappingOdometerKind })} aria-label="Nature du kilométrage" className="gap-2">
          {ODOMETER_KINDS.map((kind) => (
            <div key={kind} className="flex items-start gap-2">
              <RadioGroupItem id={`${idPrefix}-odo-${kind}`} value={kind} className="mt-0.5" />
              <div>
                <Label htmlFor={`${idPrefix}-odo-${kind}`} className="font-normal">
                  {MAPPING_ODOMETER_KIND_LABELS[kind]}
                </Label>
                <p className="text-xs text-muted-foreground">{MAPPING_ODOMETER_KIND_HELP[kind]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
        <FieldError errors={errors} name="odometerKind" />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Carburant collecté</legend>
        <p className="text-xs text-muted-foreground">Seulement si le fournisseur l’expose pour ce véhicule ; une consommation théorique n’est jamais importée.</p>
        {FUEL_KINDS.map((kind) => (
          <div key={kind} className="flex items-start gap-2">
            <Checkbox
              id={`${idPrefix}-fuel-${kind}`}
              checked={value.fuelKinds.includes(kind)}
              onCheckedChange={(v) => onChange({ ...value, fuelKinds: v === true ? [...value.fuelKinds, kind] : value.fuelKinds.filter((k) => k !== kind) })}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor={`${idPrefix}-fuel-${kind}`} className="font-normal">
                {FUEL_MEASURE_KIND_LABELS[kind]}
              </Label>
              <p className="text-xs text-muted-foreground">{FUEL_KIND_HELP[kind]}</p>
            </div>
          </div>
        ))}
        <FieldError errors={errors} name="fuelKinds" />
      </fieldset>
    </div>
  );
}

/** Date d'effet (D-301) en heure locale de l'organisation ; vide = valeur par défaut calculée par l'API. */
export function ValidFromField({ id, value, onChange, errors, label = 'Date d’effet' }: { id: string; value: string; onChange: (v: string) => void; errors: Record<string, string[]>; label?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={errors.validFrom ? true : undefined} aria-describedby={`${id}-hint validFrom-error`} />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Facultative. Par défaut : la plus tardive de maintenant moins la reprise initiale, du début du compteur ouvert, de l’entrée du véhicule dans sa société et de la fin de la précédente association. Jamais dans le futur.
      </p>
      <FieldError errors={errors} name="validFrom" />
    </div>
  );
}

/** Choix d'une unité non associée (GET /telemetry/units?category=NON_ASSOCIEES). */
export function UnitPicker({ value, onChange, excludeUnitId, errors }: { value: string; onChange: (unitId: string) => void; excludeUnitId?: string; errors: Record<string, string[]> }) {
  const { session } = useAppScope();
  const [q, setQ] = useState('');
  const query = toQuery({ category: 'NON_ASSOCIEES', q: q.trim(), pageSize: 20 });
  const units = useQuery({ queryKey: ['telemetry', 'units', 'picker', query], queryFn: () => api<UnitsPage>(`/telemetry/units${query}`) });
  const items = (units.data?.items ?? []).map((r) => r.unit).filter((u): u is UnitView => u !== null && u.id !== excludeUnitId);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Unité (boîtier) *</legend>
      <Input aria-label="Rechercher une unité non associée" placeholder="Libellé, identifiant ou immatriculation déclarée…" value={q} onChange={(e) => setQ(e.target.value)} />
      {units.isPending ? (
        <LoadingState />
      ) : units.isError ? (
        <ErrorState error={units.error} retry={() => void units.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune unité non associée ne correspond. Lancez une découverte des unités si le boîtier vient d’être installé.</p>
      ) : (
        <RadioGroup value={value} onValueChange={onChange} aria-label="Unité" className="max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
          {items.map((u) => (
            <div key={u.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/50">
              <RadioGroupItem id={`unit-${u.id}`} value={u.id} className="mt-0.5" />
              <Label htmlFor={`unit-${u.id}`} className="block font-normal">
                <span className="font-medium">{u.label}</span> <span className="text-muted-foreground">({u.externalId})</span>
                <span className="block text-xs text-muted-foreground">
                  {u.providerName} · immatriculation déclarée : {u.declaredRegistration ?? 'aucune'} · vue le {formatDateTime(u.lastSeenAt, session.timezone)}
                </span>
                {u.isSimulator ? <SimulatorBadge className="mt-1" /> : null}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
      {units.data && units.data.total > items.length ? <p className="text-xs text-muted-foreground">Affinez la recherche : {units.data.total} unités correspondent.</p> : null}
      <FieldError errors={errors} name="unitId" />
    </fieldset>
  );
}

/** Choix d'un véhicule actif d'une société gérée par l'utilisateur (GET /vehicles). */
export function VehiclePicker({ value, onChange, errors }: { value: string; onChange: (vehicleId: string) => void; errors: Record<string, string[]> }) {
  const { companyId } = useAppScope();
  const { canManage } = useManagedCompanies();
  const [q, setQ] = useState('');
  const query = toQuery({ companyId, q: q.trim(), lifecycleStatus: 'ACTIF', pageSize: 20, sort: 'code' });
  const vehicles = useQuery({ queryKey: ['vehicles', 'telemetry-picker', query], queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`) });
  const items = (vehicles.data?.items ?? []).filter((v) => canManage(v.companyId));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Véhicule *</legend>
      <Input aria-label="Rechercher un véhicule" placeholder="Code ou immatriculation…" value={q} onChange={(e) => setQ(e.target.value)} />
      {vehicles.isPending ? (
        <LoadingState />
      ) : vehicles.isError ? (
        <ErrorState error={vehicles.error} retry={() => void vehicles.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun véhicule actif de vos sociétés ne correspond.</p>
      ) : (
        <RadioGroup value={value} onValueChange={onChange} aria-label="Véhicule" className="max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
          {items.map((v) => (
            <div key={v.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/50">
              <RadioGroupItem id={`vehicle-${v.id}`} value={v.id} className="mt-0.5" />
              <Label htmlFor={`vehicle-${v.id}`} className="block font-normal">
                <span className="font-medium">{v.code}</span> · {v.registration}
                <span className="block text-xs text-muted-foreground">
                  {v.make} {v.model} · {v.companyCode}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
      <FieldError errors={errors} name="vehicleId" />
    </fieldset>
  );
}
