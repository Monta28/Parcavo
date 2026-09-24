import type { Metadata } from 'next';
import { EditVehicle } from './edit-vehicle';

export const metadata: Metadata = { title: 'Modifier le véhicule' };

export default async function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditVehicle id={id} />;
}
