import type { Metadata } from 'next';
import { EditDriver } from './edit-driver';

export const metadata: Metadata = { title: 'Modifier le conducteur' };

export default async function EditDriverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditDriver id={id} />;
}
