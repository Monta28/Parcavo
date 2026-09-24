import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DocumentsView } from './documents-view';

export const metadata: Metadata = { title: 'Documents' };

export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsView />
    </Suspense>
  );
}
