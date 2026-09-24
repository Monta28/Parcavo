'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { VehicleView } from '@/lib/vehicles-types';

/**
 * Filtre par véhicule avec recherche côté API (GET /vehicles?q=), accessible au clavier. La valeur est
 * l'identifiant conservé dans l'URL ; la fiche est rechargée pour afficher son code.
 */
export function VehicleFilter({
  id,
  vehicleId,
  onChange,
}: {
  id: string;
  vehicleId: string;
  onChange: (vehicleId: string) => void;
}) {
  const { companyId, session } = useAppScope();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const selected = useQuery({
    queryKey: ['vehicle', vehicleId, 'view'],
    queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`),
    enabled: Boolean(vehicleId),
  });
  const results = useQuery({
    queryKey: ['vehicles', 'odometer-filter', companyId, debounced],
    queryFn: () =>
      api<Page<VehicleView>>(
        `/vehicles${toQuery({ companyId, q: debounced, includeInactive: 'true', pageSize: 20, sort: 'code' })}`,
      ),
    enabled: open,
  });
  const companyCode = (cid: string) => session.companies.find((c) => c.id === cid)?.code ?? '';
  const triggerText = !vehicleId
    ? 'Tous les véhicules'
    : selected.data
      ? `${selected.data.code} · ${selected.data.registration}`
      : selected.isError
        ? 'Véhicule filtré introuvable'
        : 'Chargement…';

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            className={cn(
              'min-w-0 flex-1 justify-between font-normal',
              !vehicleId && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{triggerText}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={term}
              onValueChange={setTerm}
              placeholder="Code, immatriculation, marque…"
              aria-label="Rechercher un véhicule"
            />
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
                          onChange(v.id);
                          setOpen(false);
                          setTerm('');
                        }}
                      >
                        <Check
                          className={cn('size-4', v.id === vehicleId ? 'opacity-100' : 'opacity-0')}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{v.code}</span> · {v.registration}
                          <span className="block text-xs text-muted-foreground">
                            {v.make} {v.model}
                            {companyCode(v.companyId) ? ` · ${companyCode(v.companyId)}` : ''}
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
      {vehicleId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onChange('')}
          aria-label="Retirer le filtre véhicule"
          title="Retirer le filtre véhicule"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
