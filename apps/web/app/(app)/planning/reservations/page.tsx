import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReservationsList } from './reservations-list';

export const metadata: Metadata = { title: 'Réservations' };

export default function ReservationsPage() {
  return (
    <Suspense fallback={null}>
      <ReservationsList />
    </Suspense>
  );
}
