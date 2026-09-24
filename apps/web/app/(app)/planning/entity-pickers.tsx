'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import type { DriverSummary } from '@/lib/reservations-types';
import { cn } from '@/lib/utils';
import type { VehicleView } from '@/lib/vehicles-types';

interface Option {
  value: string;
  label: string;
  description?: string;
}

interface ComboboxProps {
  id: string;
  value: string;
  /** Libellé de la valeur sélectionnée (chargé par l'appelant). */
  selectedLabel: string | null;
  options: Option[];
  loading: boolean;
  error: unknown;
  /** Recherche côté serveur : le terme est remonté (avec délai) et les options ne sont pas filtrées localement. */
  onSearch?: (term: string) => void;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  clearLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  modal?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Liste de choix avec recherche (Popover + Command), utilisable au clavier. */
function Combobox({ id, value, selectedLabel, options, loading, error, onSearch, onChange, placeholder, searchPlaceholder, emptyText, clearLabel, disabled, invalid, describedBy, modal, onOpenChange }: ComboboxProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [term, setTerm] = useState('');
  useEffect(() => {
    if (!onSearch) return;
    const timer = setTimeout(() => onSearch(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term, onSearch]);

  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    setTerm('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? (selectedLabel ?? 'Chargement…') : placeholder}</span>
          <ChevronsUpDown className="size-4 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command shouldFilter={!onSearch}>
          <CommandInput placeholder={searchPlaceholder} value={term} onValueChange={setTerm} aria-label={searchPlaceholder} />
          <CommandList>
            {loading ? (
              <div role="status" className="py-6 text-center text-sm text-muted-foreground">
                Recherche…
              </div>
            ) : error ? (
              <div role="alert" className="px-3 py-6 text-center text-sm text-destructive">
                {isApiError(error) ? error.message : 'Chargement impossible.'}
              </div>
            ) : (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {clearLabel && value ? (
              <CommandGroup>
                <CommandItem value="__effacer__" keywords={[clearLabel]} onSelect={() => select('')}>
                  <X className="size-4" aria-hidden="true" />
                  {clearLabel}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {!loading && !error ? (
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.value} value={o.value} keywords={[o.label, o.description ?? '']} onSelect={() => select(o.value)}>
                    <Check className={cn('size-4', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                    <span className="flex flex-col">
                      <span>{o.label}</span>
                      {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Véhicule par identifiant (GET /vehicles/:id), partagé entre sélecteurs et formulaires. */
export function useVehicleView(vehicleId: string) {
  return useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`), enabled: Boolean(vehicleId) });
}

function vehicleLabel(v: Pick<VehicleView, 'code' | 'registration'>): string {
  return `${v.code} · ${v.registration}`;
}

/** Sélection d'un véhicule du périmètre (recherche GET /vehicles?q=). */
export function VehiclePicker({
  id,
  value,
  onChange,
  companyId,
  activeOnly = false,
  allowCompany,
  clearLabel,
  invalid,
  describedBy,
  modal,
}: {
  id: string;
  value: string;
  onChange: (vehicleId: string) => void;
  companyId: string | null;
  activeOnly?: boolean;
  /** Restreint les choix aux véhicules des sociétés où l'action est permise (masquage ; l'API reste juge). */
  allowCompany?: (companyId: string) => boolean;
  clearLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  modal?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState(false);
  const selected = useVehicleView(value);
  const query = toQuery({ companyId, q: search, lifecycleStatus: activeOnly ? 'ACTIF' : undefined, pageSize: 20, sort: 'code' });
  const results = useQuery({ queryKey: ['vehicles', 'picker', query], queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`), enabled: opened });
  return (
    <Combobox
      id={id}
      value={value}
      selectedLabel={selected.data ? vehicleLabel(selected.data) : selected.isError ? 'Véhicule introuvable ou hors périmètre' : null}
      options={(results.data?.items ?? []).filter((v) => !allowCompany || allowCompany(v.companyId)).map((v) => ({ value: v.id, label: vehicleLabel(v), description: `${v.make} ${v.model} · ${v.companyCode}` }))}
      loading={results.isPending}
      error={results.error}
      onSearch={setSearch}
      onChange={onChange}
      placeholder="Choisir un véhicule"
      searchPlaceholder="Code, immatriculation, marque…"
      emptyText="Aucun véhicule trouvé."
      clearLabel={clearLabel}
      invalid={invalid}
      describedBy={describedBy}
      modal={modal}
      onOpenChange={(o) => o && setOpened(true)}
    />
  );
}

/** Filtre par conducteur du périmètre (recherche GET /drivers?q=). */
export function DriverSearchPicker({ id, value, onChange, companyId, clearLabel }: { id: string; value: string; onChange: (driverId: string) => void; companyId: string | null; clearLabel?: string }) {
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState(false);
  const selected = useQuery({ queryKey: ['driver', value, 'view'], queryFn: () => api<DriverView>(`/drivers/${value}`), enabled: Boolean(value) });
  const query = toQuery({ companyId, q: search, pageSize: 20, sort: 'lastName' });
  const results = useQuery({ queryKey: ['drivers', 'picker', query], queryFn: () => api<Page<DriverView>>(`/drivers${query}`), enabled: opened });
  return (
    <Combobox
      id={id}
      value={value}
      selectedLabel={selected.data ? `${selected.data.firstName} ${selected.data.lastName}` : selected.isError ? 'Conducteur introuvable ou hors périmètre' : null}
      options={(results.data?.items ?? []).map((d) => ({ value: d.id, label: `${d.firstName} ${d.lastName}`, description: `${d.code}${d.status !== 'ACTIF' ? ' · inactif' : ''}` }))}
      loading={results.isPending}
      error={results.error}
      onSearch={setSearch}
      onChange={onChange}
      placeholder="Tous les conducteurs"
      searchPlaceholder="Code ou nom…"
      emptyText="Aucun conducteur trouvé."
      clearLabel={clearLabel}
      onOpenChange={(o) => o && setOpened(true)}
    />
  );
}

/** Conducteurs actifs de la société du véhicule (GET /drivers/summaries?companyId=), filtrés localement. */
export function DriverSummaryPicker({ id, value, onChange, companyId, invalid, describedBy, modal }: { id: string; value: string; onChange: (driverId: string) => void; companyId: string | null; invalid?: boolean; describedBy?: string; modal?: boolean }) {
  const drivers = useQuery({ queryKey: ['drivers', 'summaries', companyId], queryFn: () => api<DriverSummary[]>(`/drivers/summaries${toQuery({ companyId })}`), enabled: Boolean(companyId) });
  const options = (drivers.data ?? []).map((d) => ({ value: d.id, label: `${d.firstName} ${d.lastName}`, description: d.code }));
  const selected = options.find((o) => o.value === value);
  return (
    <Combobox
      id={id}
      value={value}
      selectedLabel={selected?.label ?? (drivers.isPending ? null : 'Conducteur non proposé')}
      options={options}
      loading={Boolean(companyId) && drivers.isPending}
      error={drivers.error}
      onChange={onChange}
      placeholder={companyId ? 'Choisir un conducteur' : 'Choisissez d’abord le véhicule'}
      searchPlaceholder="Code ou nom…"
      emptyText="Aucun conducteur actif trouvé."
      disabled={!companyId}
      invalid={invalid}
      describedBy={describedBy}
      modal={modal}
    />
  );
}
