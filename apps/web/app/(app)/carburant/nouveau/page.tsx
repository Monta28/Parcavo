import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewFuelEntry } from './new-fuel-entry';

export const metadata: Metadata = { title: 'Saisir un plein' };

export default function NewFuelEntryPage() {
  return (
    <Suspense fallback={null}>
      <NewFuelEntry />
    </Suspense>
  );
}
