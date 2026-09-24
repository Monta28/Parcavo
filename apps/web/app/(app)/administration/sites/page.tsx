import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SitesAdmin } from './sites-admin';

export const metadata: Metadata = { title: 'Sites et services' };

export default function AdministrationSitesPage() {
  return (
    <Suspense fallback={null}>
      <SitesAdmin />
    </Suspense>
  );
}
