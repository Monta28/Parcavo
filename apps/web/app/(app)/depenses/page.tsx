import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ExpensesRegister } from './expenses-register';

export const metadata: Metadata = { title: 'Dépenses' };

export default function ExpensesPage() {
  return (
    <Suspense fallback={null}>
      <ExpensesRegister />
    </Suspense>
  );
}
