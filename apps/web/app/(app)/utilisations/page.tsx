import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsagesList } from './usages-list';

export const metadata: Metadata = { title: 'Utilisations' };

export default function UsagesPage() {
  return (
    <Suspense fallback={null}>
      <UsagesList />
    </Suspense>
  );
}
