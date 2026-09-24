'use client';

import { useCallback } from 'react';
import { parseListSort, type SortOrder } from './list-sort';
import { useListParams } from './use-list-params';

/** Tri persistant dans l'URL (« tri », « sens ») ; changer de tri revient à la première page. */
export function useListSort<K extends string>(allowed: readonly K[], fallback: K) {
  const { get, set } = useListParams();
  const { sort, order } = parseListSort(get('tri'), get('sens'), allowed, fallback);
  const onSort = useCallback((key: K, next: SortOrder) => set({ tri: key, sens: next }), [set]);
  return { sort, order, onSort };
}
