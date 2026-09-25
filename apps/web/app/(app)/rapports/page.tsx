import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReportsView } from './reports-view';

export const metadata: Metadata = { title: 'Rapports' };

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsView />
    </Suspense>
  );
}
