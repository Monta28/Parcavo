'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { fullName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { VehicleView } from '@/lib/vehicles-types';

/** Objet propriétaire d'un document (véhicule ou conducteur), avec sa société de rattachement. */
export interface OwnerOption {
  id: string;
  label: string;
  companyId: string;
}

export function vehicleOption(v: Pick<VehicleView, 'id' | 'code' | 'registration' | 'companyId'>): OwnerOption {
  return { id: v.id, label: `${v.code} · ${v.registration}`, companyId: v.companyId };
}

export function driverOption(d: Pick<DriverView, 'id' | 'firstName' | 'lastName' | 'code' | 'companyId'>): OwnerOption {
  return { id: d.id, label: `${fullName(d)} (${d.code})`, companyId: d.companyId };
}

interface PickerProps {
  /** Identifiant du déclencheur (cible du <Label htmlFor>). */
  id: string;
  value: OwnerOption | null;
  loadingValue?: boolean;
  onChange: (option: OwnerOption | null) => void;
  /** Société de recherche (null : toutes les sociétés du périmètre). */
  companyId: string | null;
  placeholder?: string;
  clearLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}

interface SearchResult {
  option: OwnerOption;
  title: string;
  subtitle: string;
}

/** Sélecteur avec recherche côté API, accessible au clavier (liste déroulante filtrée par le serveur). */
function OwnerSearchPicker({
  id,
  value,
  loadingValue,
  onChange,
  placeholder,
  clearLabel,
  invalid,
  describedBy,
  disabled,
  queryKey,
  search,
  searchPlaceholder,
  emptyText,
}: Omit<PickerProps, 'companyId' | 'placeholder'> & { placeholder: string; queryKey: readonly unknown[]; search: (term: string) => Promise<SearchResult[]>; searchPlaceholder: string; emptyText: string }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);
  const results = useQuery({ queryKey: [...queryKey, debounced], queryFn: () => search(debounced), enabled: open });
  const triggerText = value ? value.label : loadingValue ? 'Chargement…' : placeholder;

  return (
    <div className="flex min-w-0 gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            className={cn('min-w-0 flex-1 justify-between font-normal', !value && 'text-muted-foreground')}
          >
            <span className="truncate">{triggerText}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput value={term} onValueChange={setTerm} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
            <CommandList>
              {results.isPending ? (
                <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
                  Recherche…
                </p>
              ) : results.isError ? (
                <p role="alert" className="px-3 py-4 text-sm text-destructive">
                  {isApiError(results.error) ? results.error.message : 'Recherche impossible.'}
                </p>
              ) : (
                <>
                  <CommandEmpty>{emptyText}</CommandEmpty>
                  <CommandGroup>
                    {results.data.map((r) => (
                      <CommandItem
                        key={r.option.id}
                        value={r.option.id}
                        onSelect={() => {
                          onChange(r.option);
                          setOpen(false);
                          setTerm('');
                        }}
                      >
                        <Check className={cn('size-4', r.option.id === value?.id ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{r.title}</span>
                          <span className="block text-xs text-muted-foreground">{r.subtitle}</span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearLabel && value && !disabled ? (
        <Button type="button" variant="ghost" size="icon" onClick={() => onChange(null)} aria-label={clearLabel} title={clearLabel}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** Recherche de véhicule (GET /vehicles?q=) dans la société indiquée ou toutes celles du périmètre. */
export function VehicleOwnerPicker({ companyId, placeholder = 'Choisir un véhicule', ...props }: PickerProps) {
  const { session } = useAppScope();
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '';
  return (
    <OwnerSearchPicker
      {...props}
      placeholder={placeholder}
      queryKey={['vehicles', 'documents-picker', companyId]}
      search={async (term) =>
        (await api<Page<VehicleView>>(`/vehicles${toQuery({ companyId, q: term, pageSize: 20, sort: 'code' })}`)).items.map((v) => ({
          option: vehicleOption(v),
          title: `${v.code} · ${v.registration}`,
          subtitle: [`${v.make} ${v.model}`.trim(), companyCode(v.companyId)].filter(Boolean).join(' · '),
        }))
      }
      searchPlaceholder="Code, immatriculation, marque…"
      emptyText="Aucun véhicule trouvé."
    />
  );
}

/** Recherche de conducteur (GET /drivers?q=) dans la société indiquée ou toutes celles du périmètre. */
export function DriverOwnerPicker({ companyId, placeholder = 'Choisir un conducteur', ...props }: PickerProps) {
  const { session } = useAppScope();
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '';
  return (
    <OwnerSearchPicker
      {...props}
      placeholder={placeholder}
      queryKey={['drivers', 'documents-picker', companyId]}
      search={async (term) =>
        (await api<Page<DriverView>>(`/drivers${toQuery({ companyId, q: term, pageSize: 20, sort: 'lastName' })}`)).items.map((d) => ({
          option: driverOption(d),
          title: fullName(d),
          subtitle: [d.code, companyCode(d.companyId), d.status !== 'ACTIF' ? 'inactif' : ''].filter(Boolean).join(' · '),
        }))
      }
      searchPlaceholder="Code, nom ou prénom…"
      emptyText="Aucun conducteur trouvé."
    />
  );
}

/** Filtre par véhicule conservé dans l'URL (identifiant) ; la fiche est rechargée pour afficher son libellé. */
export function VehicleIdFilter({ id, vehicleId, companyId, onChange }: { id: string; vehicleId: string; companyId: string | null; onChange: (vehicleId: string) => void }) {
  const selected = useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`), enabled: Boolean(vehicleId) });
  const value: OwnerOption | null = !vehicleId ? null : selected.data ? vehicleOption(selected.data) : selected.isError ? { id: vehicleId, label: 'Véhicule introuvable ou hors périmètre', companyId: '' } : null;
  return (
    <VehicleOwnerPicker
      id={id}
      value={value}
      loadingValue={Boolean(vehicleId) && selected.isPending}
      onChange={(o) => onChange(o?.id ?? '')}
      companyId={companyId}
      placeholder="Tous les véhicules"
      clearLabel="Retirer le filtre véhicule"
    />
  );
}

/** Filtre par conducteur conservé dans l'URL (identifiant) ; la fiche est rechargée pour afficher son nom. */
export function DriverIdFilter({ id, driverId, companyId, onChange }: { id: string; driverId: string; companyId: string | null; onChange: (driverId: string) => void }) {
  const selected = useQuery({ queryKey: ['driver', driverId, 'view'], queryFn: () => api<DriverView>(`/drivers/${driverId}`), enabled: Boolean(driverId) });
  const value: OwnerOption | null = !driverId ? null : selected.data ? driverOption(selected.data) : selected.isError ? { id: driverId, label: 'Conducteur introuvable ou hors périmètre', companyId: '' } : null;
  return (
    <DriverOwnerPicker
      id={id}
      value={value}
      loadingValue={Boolean(driverId) && selected.isPending}
      onChange={(o) => onChange(o?.id ?? '')}
      companyId={companyId}
      placeholder="Tous les conducteurs"
      clearLabel="Retirer le filtre conducteur"
    />
  );
}
