import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VehiclesList } from './vehicles-list';

export const metadata: Metadata = { title: 'Véhicules' };

export default function VehiclesPage() {
  return (
    <Suspense fallback={null}>
      <VehiclesList />
    </Suspense>
  );
}
