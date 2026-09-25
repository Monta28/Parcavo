import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AlertsCenter } from './alerts-center';

export const metadata: Metadata = { title: 'Alertes' };

export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <AlertsCenter />
    </Suspense>
  );
}
