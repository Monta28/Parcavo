import type { Metadata } from 'next';
import { Suspense } from 'react';
import { OdometerWorkspace } from './odometer-workspace';

export const metadata: Metadata = { title: 'Kilométrage' };

export default function OdometerPage() {
  return (
    <Suspense fallback={null}>
      <OdometerWorkspace />
    </Suspense>
  );
}
