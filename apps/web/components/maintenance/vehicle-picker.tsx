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
import { cn } from '@/lib/utils';
import type { VehicleView } from '@/lib/vehicles-types';

export function vehicleLabel(v: Pick<VehicleView, 'code' | 'registration'>): string {
  return `${v.code} · ${v.registration}`;
}

/**
 * Sélecteur de véhicule avec recherche côté API (GET /vehicles?q=), restreint à la société indiquée
 * (toutes les sociétés du périmètre si null). Navigable au clavier ; cible d'un <Label htmlFor>.
 */
export function MaintenanceVehiclePicker({
  id,
  value,
  onChange,
  companyId,
  placeholder = 'Choisir un véhicule',
  clearLabel,
  invalid,
  describedBy,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (vehicle: VehicleView | null) => void;
  companyId: string | null;
  placeholder?: string;
  clearLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const selected = useQuery({ queryKey: ['vehicle', value, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${value}`), enabled: Boolean(value) });
  const query = toQuery({ companyId, q: debounced, pageSize: 20, sort: 'code' });
  const results = useQuery({ queryKey: ['vehicles', 'maintenance-picker', query], queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`), enabled: open });
  const triggerText = !value ? placeholder : selected.data ? vehicleLabel(selected.data) : selected.isError ? 'Véhicule introuvable ou hors périmètre' : 'Chargement…';

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
            <CommandInput value={term} onValueChange={setTerm} placeholder="Code, immatriculation, marque…" aria-label="Rechercher un véhicule" />
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
                  <CommandEmpty>Aucun véhicule trouvé.</CommandEmpty>
                  <CommandGroup>
                    {results.data.items.map((v) => (
                      <CommandItem
                        key={v.id}
                        value={v.id}
                        onSelect={() => {
                          onChange(v);
                          setOpen(false);
                          setTerm('');
                        }}
                      >
                        <Check className={cn('size-4', v.id === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{v.code}</span> · {v.registration}
                          <span className="block text-xs text-muted-foreground">
                            {v.make} {v.model} · {v.companyCode}
                          </span>
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
