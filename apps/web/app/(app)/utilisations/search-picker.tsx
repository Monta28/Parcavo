'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

export interface SearchPickerProps<T> {
  /** Identifiant du déclencheur (cible du <Label htmlFor>). */
  id: string;
  value: T | null;
  /** Sélection en cours de chargement (identifiant présent dans l'URL, fiche pas encore reçue). */
  loadingValue?: boolean;
  onChange: (item: T | null) => void;
  /** Clé de cache react-query de la recherche (le terme saisi est ajouté). */
  queryKey: readonly unknown[];
  search: (term: string) => Promise<T[]>;
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Libellé du bouton d'effacement ; absent : la sélection ne peut pas être effacée. */
  clearLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

/** Sélecteur avec recherche côté API (liste déroulante accessible au clavier). */
export function SearchPicker<T>({ id, value, loadingValue, onChange, queryKey, search, itemKey, itemLabel, renderItem, placeholder, searchPlaceholder, emptyText, clearLabel, invalid, describedBy, disabled, className }: SearchPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const results = useQuery({ queryKey: [...queryKey, debounced], queryFn: () => search(debounced), enabled: open });
  const selectedKey = value ? itemKey(value) : null;
  const triggerText = value ? itemLabel(value) : loadingValue ? 'Chargement…' : placeholder;

  return (
    <div className={cn('flex gap-2', className)}>
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
                    {results.data.map((item) => {
                      const key = itemKey(item);
                      return (
                        <CommandItem
                          key={key}
                          value={key}
                          onSelect={() => {
                            onChange(item);
                            setOpen(false);
                            setTerm('');
                          }}
                        >
                          <Check className={cn('size-4', key === selectedKey ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                          <span className="min-w-0 flex-1">{renderItem(item)}</span>
                        </CommandItem>
                      );
                    })}
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
