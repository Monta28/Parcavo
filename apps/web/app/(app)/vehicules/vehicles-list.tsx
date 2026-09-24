'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge, toneForOperational } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { useListParams } from '@/lib/use-list-params';
import type { VehicleCategory, VehicleView } from '@/lib/vehicles-types';

const ALL = '__all__';

export function VehiclesList() {
  const { companyId, session } = useAppScope();
  const role = useRoleIn(companyId);
  const { get, set, page } = useListParams();
  const q = get('q');
  const lifecycle = get('lifecycle');
  const operational = get('statut');
  const categoryId = get('categorie');
  const query = toQuery({ companyId, q, lifecycleStatus: lifecycle, operationalStatus: operational, categoryId, page, pageSize: 25, sort: 'code' });

  const vehicles = useQuery({ queryKey: ['vehicles', query], queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`) });
  const categories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories') });
  const canCreate = session.isAdmin || role === 'CHEF_PARC' || role === 'OPERATEUR' || (companyId === null && session.grants.some((g) => g.role === 'CHEF_PARC' || g.role === 'OPERATEUR'));

  return (
    <div>
      <PageHeader
        title="Véhicules"
        description="Recherche multicritère sur les sociétés de votre périmètre."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/vehicules/nouveau">
                <Plus className="size-4" /> Nouveau véhicule
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Rechercher" placeholder="Code, immatriculation, marque, VIN…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        <Select value={operational || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Statut opérationnel">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {Object.entries(VEHICLE_OPERATIONAL_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={lifecycle || ALL} onValueChange={(v) => set({ lifecycle: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Cycle de vie">
            <SelectValue placeholder="Cycle de vie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Actifs et hors service</SelectItem>
            {Object.entries(VEHICLE_LIFECYCLE_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={categoryId || ALL} onValueChange={(v) => set({ categorie: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Catégorie">
            <SelectValue placeholder="Catégorie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes les catégories</SelectItem>
            {(categories.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {vehicles.isPending ? (
        <LoadingState />
      ) : vehicles.isError ? (
        <ErrorState error={vehicles.error} retry={() => void vehicles.refetch()} />
      ) : vehicles.data.total === 0 ? (
        <EmptyState title="Aucun véhicule" description="Aucun véhicule ne correspond aux filtres dans votre périmètre." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Immatriculation</TableHead>
                <TableHead>Marque / modèle</TableHead>
                <TableHead>Catégorie</TableHead>
                {companyId === null ? <TableHead>Société</TableHead> : null}
                <TableHead>Statut</TableHead>
                <TableHead>Utilisateur actuel</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicles.data.items.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <Link href={`/vehicules/${v.id}`} className="font-medium underline-offset-4 hover:underline">
                      {v.code}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {v.registration}
                    {v.provisionalRegistration ? <span className="ml-1 text-xs text-muted-foreground">(provisoire)</span> : null}
                  </TableCell>
                  <TableCell>
                    {v.make} {v.model}
                  </TableCell>
                  <TableCell>{v.categoryLabel}</TableCell>
                  {companyId === null ? <TableCell>{v.companyCode}</TableCell> : null}
                  <TableCell>
                    {v.operationalStatus ? (
                      <StatusBadge label={VEHICLE_OPERATIONAL_STATUS_LABELS[v.operationalStatus]} tone={toneForOperational(v.operationalStatus)} />
                    ) : (
                      <StatusBadge label={VEHICLE_LIFECYCLE_LABELS[v.lifecycleStatus]} tone="neutral" />
                    )}
                  </TableCell>
                  <TableCell>{v.currentUsage ? v.currentUsage.driverName : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={vehicles.data.page} pageSize={vehicles.data.pageSize} total={vehicles.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
