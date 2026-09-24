import type { Metadata } from 'next';
import { Suspense } from 'react';
import { IncidentsList } from './incidents-list';

export const metadata: Metadata = { title: 'Incidents' };

export default function IncidentsPage() {
  return (
    <Suspense fallback={null}>
      <IncidentsList />
    </Suspense>
  );
}
