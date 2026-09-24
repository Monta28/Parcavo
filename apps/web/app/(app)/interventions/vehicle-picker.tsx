'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { VehicleView } from '@/lib/vehicles-types';

/**
 * Choix du véhicule d'une nouvelle intervention : recherche côté API (GET /vehicles?q=, véhicules actifs
 * et hors service), limitée à l'affichage aux sociétés où l'utilisateur a un rôle opérationnel.
 */
export function VehiclePicker({
  id,
  vehicle,
  allowedCompanyIds,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  vehicle: VehicleView | null;
  allowedCompanyIds: string[];
  onChange: (vehicle: VehicleView) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { companyId, session } = useAppScope();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const results = useQuery({
    queryKey: ['vehicles', 'intervention-picker', companyId, debounced],
    queryFn: () => api<Page<VehicleView>>(`/vehicles${toQuery({ companyId, q: debounced, pageSize: 20, sort: 'code' })}`),
    enabled: open,
  });
  const allowed = new Set(allowedCompanyIds);
  const items = (results.data?.items ?? []).filter((v) => allowed.has(v.companyId));
  const companyCode = (cid: string) => session.companies.find((c) => c.id === cid)?.code ?? '';

  return (
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
          className={cn('w-full min-w-0 justify-between font-normal', !vehicle && 'text-muted-foreground')}
        >
          <span className="truncate">{vehicle ? `${vehicle.code} · ${vehicle.registration} · ${vehicle.make} ${vehicle.model}` : 'Choisir un véhicule'}</span>
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
                  {items.map((v) => (
                    <CommandItem
                      key={v.id}
                      value={v.id}
                      onSelect={() => {
                        onChange(v);
                        setOpen(false);
                        setTerm('');
                      }}
                    >
                      <Check className={cn('size-4', v.id === vehicle?.id ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
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
  );
}
