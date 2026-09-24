'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompanyView, UserView } from '@/lib/admin-types';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime, fullName } from '@/lib/format';
import { useListParams } from '@/lib/use-list-params';
import { ALL, USER_STATUS_LABELS } from '../labels';
import { MembershipSummary } from './membership-summary';

/** Comptes utilisateurs de l'organisation (CDC 2.2). */
export function UsersAdmin() {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const { get, set, page } = useListParams();
  const q = get('q');
  const status = get('statut');
  // La société courante de l'en-tête sert de filtre par défaut ; « societe » dans l'URL la remplace
  // (valeur ALL : toutes les sociétés explicitement).
  const societe = get('societe');
  const companyId = societe === ALL ? '' : societe || scopeCompanyId || '';
  const query = toQuery({ q, status, companyId, page, pageSize: 25, sort: 'lastName' });

  const users = useQuery({ queryKey: ['users', query], queryFn: () => api<Page<UserView>>(`/users${query}`) });
  const companies = useQuery({ queryKey: ['companies', 'options'], queryFn: () => api<Page<CompanyView>>(`/companies${toQuery({ pageSize: 100, sort: 'code' })}`) });
  const filtered = Boolean(q || status || companyId);

  return (
    <div>
      <PageHeader
        title="Utilisateurs"
        description="Comptes, habilitations par société et permissions fines. Les comptes ne sont jamais supprimés : ils sont désactivés."
        actions={
          <Button asChild>
            <Link href="/administration/utilisateurs/nouveau">
              <Plus className="size-4" /> Nouvel utilisateur
            </Link>
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Rechercher un utilisateur" placeholder="Nom, prénom ou e-mail…" defaultValue={q} onChange={(e) => set({ q: e.target.value })} />
        <Select value={status || ALL} onValueChange={(v) => set({ statut: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Statut du compte">
            <SelectValue placeholder="Statut" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {Object.entries(USER_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={companyId || ALL} onValueChange={(v) => set({ societe: (v === ALL ? '' : v) === (scopeCompanyId ?? '') ? '' : v })}>
          <SelectTrigger aria-label="Société d’habilitation">
            <SelectValue placeholder="Société" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes les sociétés</SelectItem>
            {(companies.data?.items ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.code} · {c.legalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {users.isPending ? (
        <LoadingState />
      ) : users.isError ? (
        <ErrorState error={users.error} retry={() => void users.refetch()} />
      ) : users.data.total === 0 ? (
        <EmptyState title="Aucun utilisateur" description={filtered ? 'Aucun compte ne correspond aux filtres.' : 'Aucun compte n’est encore créé.'} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead className="hidden md:table-cell">E-mail</TableHead>
                <TableHead>Habilitations</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="hidden lg:table-cell">Dernière connexion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <Link href={`/administration/utilisateurs/${u.id}`} className="font-medium underline-offset-4 hover:underline">
                      {fullName(u)}
                    </Link>
                    <span className="block text-xs text-muted-foreground md:hidden">{u.email}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{u.email}</TableCell>
                  <TableCell className="whitespace-normal">
                    <MembershipSummary memberships={u.memberships} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge label={USER_STATUS_LABELS[u.status]} tone={u.status === 'ACTIF' ? 'success' : 'neutral'} />
                      {!u.hasPassword ? <StatusBadge label="Invitation en attente" tone="warning" /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{u.lastLoginAt ? formatDateTime(u.lastLoginAt, session.timezone) : 'Jamais'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={users.data.page} pageSize={users.data.pageSize} total={users.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
    </div>
  );
}
