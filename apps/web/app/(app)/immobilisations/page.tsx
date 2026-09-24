import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ImmobilizationsList } from './immobilizations-list';

export const metadata: Metadata = { title: 'Immobilisations' };

export default function ImmobilizationsPage() {
  return (
    <Suspense fallback={null}>
      <ImmobilizationsList />
    </Suspense>
  );
}
