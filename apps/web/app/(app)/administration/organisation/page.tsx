import type { Metadata } from 'next';
import { Suspense } from 'react';
import { OrganizationAdmin } from './organization-admin';

export const metadata: Metadata = { title: 'Organisation' };

export default function AdministrationOrganizationPage() {
  return (
    <Suspense fallback={null}>
      <OrganizationAdmin />
    </Suspense>
  );
}
