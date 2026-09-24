import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CompaniesAdmin } from './companies-admin';

export const metadata: Metadata = { title: 'Sociétés' };

export default function AdministrationCompaniesPage() {
  return (
    <Suspense fallback={null}>
      <CompaniesAdmin />
    </Suspense>
  );
}
