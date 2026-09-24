import type { Metadata } from 'next';
import { Suspense } from 'react';
import { EditIntervention } from './edit-intervention';

export const metadata: Metadata = { title: 'Modifier l’intervention' };

export default async function EditInterventionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <EditIntervention id={id} />
    </Suspense>
  );
}
