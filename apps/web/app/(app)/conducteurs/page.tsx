import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DriversList } from './drivers-list';

export const metadata: Metadata = { title: 'Conducteurs' };

export default function DriversPage() {
  return (
    <Suspense fallback={null}>
      <DriversList />
    </Suspense>
  );
}
