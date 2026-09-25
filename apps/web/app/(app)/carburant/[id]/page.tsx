import type { Metadata } from 'next';
import { FuelDetail } from './fuel-detail';

export const metadata: Metadata = { title: 'Plein' };

export default async function FuelEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FuelDetail id={id} />;
}
