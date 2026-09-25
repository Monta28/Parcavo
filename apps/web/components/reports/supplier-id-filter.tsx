'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SUPPLIER_CATEGORY_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { SupplierView } from '@/lib/suppliers-types';
import { cn } from '@/lib/utils';

/**
 * Filtre par fournisseur conservé dans l'URL (identifiant) : recherche côté API (GET /suppliers?q=) parmi les
 * fournisseurs actifs et archivés de la société courante (ou de tout le périmètre) ; le libellé du
 * fournisseur choisi est relu par GET /suppliers/:id.
 */
export function SupplierIdFilter({ id, supplierId, companyId, onChange }: { id: string; supplierId: string; companyId: string | null; onChange: (supplierId: string) => void }) {
  const { session } = useAppScope();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const selected = useQuery({ queryKey: ['supplier', supplierId], queryFn: () => api<SupplierView>(`/suppliers/${supplierId}`), enabled: Boolean(supplierId) });
  const results = useQuery({
    queryKey: ['suppliers', 'report-filter', companyId, debounced],
    queryFn: async () => {
      const [active, archived] = await Promise.all(
        (['ACTIF', 'ARCHIVE'] as const).map((status) => api<Page<SupplierView>>(`/suppliers${toQuery({ companyId, q: debounced, status, pageSize: 20 })}`)),
      );
      return [...(active?.items ?? []), ...(archived?.items ?? [])];
    },
    enabled: open,
  });
  const companyCode = (cid: string) => session.companies.find((c) => c.id === cid)?.code ?? '';
  const triggerText = !supplierId ? 'Tous les fournisseurs' : selected.data ? selected.data.name : selected.isError ? 'Fournisseur introuvable ou hors périmètre' : 'Chargement…';

  return (
    <div className="flex min-w-0 gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-haspopup="listbox" className={cn('min-w-0 flex-1 justify-between font-normal', !supplierId && 'text-muted-foreground')}>
            <span className="truncate">{triggerText}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput value={term} onValueChange={setTerm} placeholder="Nom ou contact…" aria-label="Rechercher un fournisseur" />
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
                  <CommandEmpty>Aucun fournisseur trouvé.</CommandEmpty>
                  <CommandGroup>
                    {results.data.map((s) => (
                      <CommandItem
                        key={s.id}
                        value={s.id}
                        onSelect={() => {
                          onChange(s.id);
                          setOpen(false);
                          setTerm('');
                        }}
                      >
                        <Check className={cn('size-4', s.id === supplierId ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{s.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[SUPPLIER_CATEGORY_LABELS[s.category] ?? s.category, companyCode(s.companyId), s.status === 'ARCHIVE' ? 'archivé' : ''].filter(Boolean).join(' · ')}
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
      {supplierId ? (
        <Button type="button" variant="ghost" size="icon" onClick={() => onChange('')} aria-label="Retirer le filtre fournisseur" title="Retirer le filtre fournisseur">
          <X className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
