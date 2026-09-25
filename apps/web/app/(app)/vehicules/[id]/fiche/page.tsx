import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VehicleSheet } from './vehicle-sheet';

export const metadata: Metadata = { title: 'Fiche véhicule' };

export default async function VehicleSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <VehicleSheet id={id} />
    </Suspense>
  );
}
