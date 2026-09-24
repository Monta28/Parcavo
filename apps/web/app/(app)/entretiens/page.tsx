import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MaintenanceView } from './maintenance-view';

export const metadata: Metadata = { title: 'Entretiens' };

export default function MaintenancePage() {
  return (
    <Suspense fallback={null}>
      <MaintenanceView />
    </Suspense>
  );
}
