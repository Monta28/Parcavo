import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ImportsWorkspace } from './imports-workspace';

export const metadata: Metadata = { title: 'Imports' };

export default function ImportsPage() {
  return (
    <Suspense fallback={null}>
      <ImportsWorkspace />
    </Suspense>
  );
}
