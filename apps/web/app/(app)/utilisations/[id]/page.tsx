import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsageDetail } from './usage-detail';

export const metadata: Metadata = { title: 'Utilisation' };

export default async function UsagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <UsageDetail id={id} />
    </Suspense>
  );
}
