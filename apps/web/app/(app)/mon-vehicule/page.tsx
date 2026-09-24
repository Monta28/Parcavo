import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MyVehicle } from './my-vehicle';

export const metadata: Metadata = { title: 'Mon véhicule' };

export default function MyVehiclePage() {
  return (
    <Suspense fallback={null}>
      <MyVehicle />
    </Suspense>
  );
}
