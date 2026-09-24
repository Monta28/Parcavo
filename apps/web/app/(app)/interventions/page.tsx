import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InterventionsList } from './interventions-list';

export const metadata: Metadata = { title: 'Interventions' };

export default function InterventionsPage() {
  return (
    <Suspense fallback={null}>
      <InterventionsList />
    </Suspense>
  );
}
