import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewIntervention } from './new-intervention';

export const metadata: Metadata = { title: 'Nouvelle intervention' };

export default function NewInterventionPage() {
  return (
    <Suspense fallback={null}>
      <NewIntervention />
    </Suspense>
  );
}
