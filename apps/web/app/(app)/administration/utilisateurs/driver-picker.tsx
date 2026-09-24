'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { LinkableDriver } from '@/lib/admin-types';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';

/** Liaison facultative du compte à une fiche conducteur (recherche GET /drivers). */
export function DriverPicker({ value, onChange, userId, errorId }: { value: string | null; onChange: (driverId: string | null) => void; userId: string | null; errorId?: string }) {
  const { session } = useAppScope();
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term]);

  const companyCode = (companyId: string) => session.companies.find((c) => c.id === companyId)?.code ?? '';
  const current = useQuery({ queryKey: ['admin', 'driver', value], queryFn: () => api<LinkableDriver>(`/drivers/${value}`), enabled: Boolean(value) });
  const query = toQuery({ q: search, pageSize: 10, sort: 'lastName' });
  const results = useQuery({ queryKey: ['admin', 'drivers', query], queryFn: () => api<Page<LinkableDriver>>(`/drivers${query}`), enabled: search.length >= 2 });

  return (
    <div className="space-y-2">
      <Label htmlFor="user-driver-search">Conducteur lié</Label>
      {value ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          {current.isPending ? (
            <span className="text-muted-foreground">Chargement du conducteur…</span>
          ) : current.isError ? (
            <span className="text-destructive">Conducteur introuvable ou hors périmètre.</span>
          ) : (
            <span>
              <Link href={`/conducteurs/${current.data.id}`} className="font-medium underline-offset-4 hover:underline">
                {current.data.firstName} {current.data.lastName}
              </Link>
              <span className="ml-1 text-muted-foreground">
                · {current.data.code}
                {companyCode(current.data.companyId) ? ` · ${companyCode(current.data.companyId)}` : ''}
              </span>
            </span>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            Retirer le lien
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Aucun conducteur lié.</p>
      )}
      <Input
        id="user-driver-search"
        type="search"
        placeholder="Rechercher un conducteur par code ou nom…"
        autoComplete="off"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        aria-describedby={['user-driver-hint', errorId].filter(Boolean).join(' ')}
      />
      <p id="user-driver-hint" className="text-xs text-muted-foreground">
        Facultatif : un compte lié à un conducteur lui donne accès à son espace « Mon véhicule ». Saisissez au moins 2 caractères.
      </p>
      {search.length >= 2 ? (
        results.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Recherche…
          </p>
        ) : results.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Recherche impossible.
          </p>
        ) : results.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun conducteur trouvé.</p>
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Conducteurs trouvés">
            {results.data.items.map((d) => {
              const linkedElsewhere = d.userId !== null && d.userId !== userId;
              const selected = d.id === value;
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">
                      {d.firstName} {d.lastName}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      · {d.code}
                      {companyCode(d.companyId) ? ` · ${companyCode(d.companyId)}` : ''}
                      {d.status !== 'ACTIF' ? ' · inactif' : ''}
                    </span>
                    {linkedElsewhere ? <span className="block text-xs text-muted-foreground">Déjà lié à un autre compte</span> : null}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={linkedElsewhere || selected}
                    onClick={() => {
                      onChange(d.id);
                      setTerm('');
                      setSearch('');
                    }}
                    aria-label={`Lier le conducteur ${d.firstName} ${d.lastName}`}
                  >
                    {selected ? 'Lié' : 'Lier'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
