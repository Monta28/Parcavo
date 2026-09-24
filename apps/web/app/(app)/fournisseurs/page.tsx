import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SuppliersList } from './suppliers-list';

export const metadata: Metadata = { title: 'Fournisseurs' };

export default function SuppliersPage() {
  return (
    <Suspense fallback={null}>
      <SuppliersList />
    </Suspense>
  );
}
