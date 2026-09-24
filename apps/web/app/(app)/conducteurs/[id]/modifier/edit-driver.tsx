'use client';

import { useQuery } from '@tanstack/react-query';
import { useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { api } from '@/lib/api-client';
import type { DriverView } from '@/lib/drivers-types';
import { DriverForm } from '../../driver-form';

export function EditDriver({ id }: { id: string }) {
  const driver = useQuery({ queryKey: ['driver', id], queryFn: () => api<DriverView>(`/drivers/${id}`) });
  const role = useRoleIn(driver.data?.companyId ?? null);
  if (driver.isPending) return <LoadingState />;
  if (driver.isError) return <ErrorState error={driver.error} retry={() => void driver.refetch()} />;
  // Même règle que l'API (PATCH /drivers/:id) : opérateurs, chefs de parc et administrateurs de la société.
  if (role !== 'ADMIN' && role !== 'CHEF_PARC' && role !== 'OPERATEUR') {
    return <EmptyState title="Modification non autorisée" description="La modification d’un conducteur est réservée aux opérateurs, chefs de parc et administrateurs de sa société." />;
  }
  return (
    <div>
      <PageHeader title={`Modifier ${driver.data.code} · ${driver.data.firstName} ${driver.data.lastName}`} description="L’identifiant interne et la société ne sont pas modifiables. Les modifications sont journalisées ; une version obsolète est refusée." />
      <DriverForm key={`${driver.data.id}-${driver.data.version}`} driver={driver.data} />
    </div>
  );
}
