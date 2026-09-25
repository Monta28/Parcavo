import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FuelList } from './fuel-list';

export const metadata: Metadata = { title: 'Carburant' };

export default function FuelPage() {
  return (
    <Suspense fallback={null}>
      <FuelList />
    </Suspense>
  );
}
