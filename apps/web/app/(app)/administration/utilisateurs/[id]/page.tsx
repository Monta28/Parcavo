import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UserDetail } from './user-detail';

export const metadata: Metadata = { title: 'Utilisateur' };

export default async function AdministrationUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <UserDetail id={id} />
    </Suspense>
  );
}
