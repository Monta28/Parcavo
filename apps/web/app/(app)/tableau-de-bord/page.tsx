import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Dashboard } from './dashboard';

export const metadata: Metadata = { title: 'Tableau de bord' };

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}
