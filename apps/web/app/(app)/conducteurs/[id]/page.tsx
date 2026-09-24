import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DriverDetail } from './driver-detail';

export const metadata: Metadata = { title: 'Conducteur' };

export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <DriverDetail id={id} />
    </Suspense>
  );
}
