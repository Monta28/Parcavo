'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { DRIVER_STATUS_LABELS, type DriverView } from '@/lib/drivers-types';
import { formatDate } from '@/lib/format';
import { useListParams } from '@/lib/use-list-params';

const ALL = '__all__';

export function DriversList() {
  const { companyId, session } = useAppScope();
  const role = useRoleIn(companyId);
  const { get, set, page } = useListParams();
  const q = get('q');
  const status = get('statut');
  const query = toQuery({ companyId, q, status, page, pageSize: 25, sort: 'lastName' });

  const drivers = useQuery({ queryKey: ['drivers', query], queryFn: () => api<Page<DriverView>>(`/drivers${query}`) });
  const canCreate = session.isAdmin || role === 'CHEF_PARC' || role === 'OPERATEUR' || (companyId === null && session.grants.some((g) => g.role === 'CHEF_PARC' || g.role === 'OPERATEUR'));
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '—';

  return (
    <div>
      <PageHeader
        title="Conducteurs"
        description="Fiches conducteurs, permis et utilisation en cours sur les sociétés de votre périmètre."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/conducteurs/nouveau">
                <Plus className="size-4" /> Nouveau conducteur
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Rechercher" placeholder="Code, nom, prénom…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} className="lg:col-span-2" />
        <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Statut">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {Object.entries(DRIVER_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {drivers.isPending ? (
        <LoadingState />
      ) : drivers.isError ? (
        <ErrorState error={drivers.error} retry={() => void drivers.refetch()} />
      ) : drivers.data.total === 0 ? (
        <EmptyState title="Aucun conducteur" description="Aucun conducteur ne correspond aux filtres dans votre périmètre." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Nom</TableHead>
                <TableHead>Prénom</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Statut</TableHead>
                <TableHead>Téléphone</TableHead>
                <TableHead>Permis</TableHead>
                <TableHead>Utilisation en cours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drivers.data.items.map((d) => {
                const permit = d.permits[0];
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/conducteurs/${d.id}`} className="font-medium underline-offset-4 hover:underline">
                        {d.code}
                      </Link>
                    </TableCell>
                    <TableCell>{d.lastName}</TableCell>
                    <TableCell>{d.firstName}</TableCell>
                    {companyId === null ? <TableCell>{companyCode(d.companyId)}</TableCell> : null}
                    <TableCell>
                      <StatusBadge label={DRIVER_STATUS_LABELS[d.status] ?? d.status} tone={d.status === 'ACTIF' ? 'success' : 'neutral'} />
                    </TableCell>
                    <TableCell>{d.phone ?? '—'}</TableCell>
                    <TableCell>
                      {permit ? (
                        <span>
                          {permit.categories.length > 0 ? permit.categories.join(', ') : 'Catégories non renseignées'}
                          <span className="block text-xs text-muted-foreground">{permit.expiresOn ? `expire le ${formatDate(permit.expiresOn)}` : 'expiration non renseignée'}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Non renseigné</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.currentUsageId ? (
                        <Link href={`/utilisations/${d.currentUsageId}`} className="underline-offset-4 hover:underline">
                          Voir l’utilisation
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls page={drivers.data.page} pageSize={drivers.data.pageSize} total={drivers.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
