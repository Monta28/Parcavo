import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsersAdmin } from './users-admin';

export const metadata: Metadata = { title: 'Utilisateurs' };

export default function AdministrationUsersPage() {
  return (
    <Suspense fallback={null}>
      <UsersAdmin />
    </Suspense>
  );
}
