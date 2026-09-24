import type { Metadata } from 'next';
import { ImmobilizationDetail } from './immobilization-detail';

export const metadata: Metadata = { title: 'Immobilisation' };

export default async function ImmobilizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ImmobilizationDetail id={id} />;
}
