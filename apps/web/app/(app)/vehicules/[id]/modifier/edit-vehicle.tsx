'use client';

import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { api } from '@/lib/api-client';
import type { VehicleView } from '@/lib/vehicles-types';
import { VehicleForm } from '../../vehicle-form';

export function EditVehicle({ id }: { id: string }) {
  const vehicle = useQuery({ queryKey: ['vehicle', id], queryFn: () => api<VehicleView>(`/vehicles/${id}`) });
  if (vehicle.isPending) return <LoadingState />;
  if (vehicle.isError) return <ErrorState error={vehicle.error} retry={() => void vehicle.refetch()} />;
  return (
    <div>
      <PageHeader title={`Modifier ${vehicle.data.code}`} description="Les modifications sont journalisées ; une version obsolète est refusée." />
      <VehicleForm vehicle={vehicle.data} />
    </div>
  );
}
