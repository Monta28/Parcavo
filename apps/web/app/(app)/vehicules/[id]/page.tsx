import type { Metadata } from 'next';
import { VehicleDetail } from './vehicle-detail';

export const metadata: Metadata = { title: 'Véhicule' };

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VehicleDetail id={id} />;
}
