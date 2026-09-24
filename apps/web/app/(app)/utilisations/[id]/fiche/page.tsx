import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsageSheet } from './usage-sheet';

export const metadata: Metadata = { title: 'Fiche de remise et de restitution' };

export default async function UsageSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <UsageSheet id={id} />
    </Suspense>
  );
}
