import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DeclareIncident } from './declare-incident';

export const metadata: Metadata = { title: 'Déclarer un incident' };

export default function NewIncidentPage() {
  return (
    <Suspense fallback={null}>
      <DeclareIncident />
    </Suspense>
  );
}
