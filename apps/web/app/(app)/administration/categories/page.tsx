import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CategoriesAdmin } from './categories-admin';

export const metadata: Metadata = { title: 'Catégories de véhicules' };

export default function AdministrationCategoriesPage() {
  return (
    <Suspense fallback={null}>
      <CategoriesAdmin />
    </Suspense>
  );
}
