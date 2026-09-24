'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortOrder = 'asc' | 'desc';

/**
 * En-tête de colonne triable (CDC 10.1) : bouton accessible au clavier, sens annoncé par aria-sort et
 * par le libellé (pas seulement par l'icône). Le tri est calculé par l'API ; ce composant ne fait que
 * choisir la clé et le sens.
 */
export function SortableHead<K extends string>({
  label,
  sortKey,
  current,
  order,
  onSort,
  defaultOrder = 'asc',
  descLabel,
  ascLabel,
  className,
}: {
  label: string;
  sortKey: K;
  current: K;
  order: SortOrder;
  onSort: (key: K, order: SortOrder) => void;
  /** Sens appliqué au premier clic sur une colonne (ex. desc pour l'urgence : le plus urgent d'abord). */
  defaultOrder?: SortOrder;
  /** Description du sens décroissant / croissant pour les lecteurs d'écran. */
  descLabel?: string;
  ascLabel?: string;
  className?: string;
}) {
  const active = current === sortKey;
  const next: SortOrder = active ? (order === 'asc' ? 'desc' : 'asc') : defaultOrder;
  const describe = (o: SortOrder) => (o === 'asc' ? (ascLabel ?? 'ordre croissant') : (descLabel ?? 'ordre décroissant'));
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey, next)}
        className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring', active && 'text-foreground')}
        title={`Trier par ${label.toLowerCase()} (${describe(next)})`}
      >
        <span>{label}</span>
        <Icon className={cn('size-3.5 shrink-0', active ? 'opacity-100' : 'opacity-50')} aria-hidden="true" />
        <span className="sr-only">{active ? `, trié par ${describe(order)} ; activer pour ${describe(next)}` : `, activer pour trier (${describe(next)})`}</span>
      </button>
    </TableHead>
  );
}
