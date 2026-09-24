import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InterventionDetail } from './intervention-detail';

export const metadata: Metadata = { title: 'Intervention' };

export default async function InterventionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <InterventionDetail id={id} />
    </Suspense>
  );
}
