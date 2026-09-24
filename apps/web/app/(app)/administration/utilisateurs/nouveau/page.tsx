import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NewUser } from './new-user';

export const metadata: Metadata = { title: 'Nouvel utilisateur' };

export default function AdministrationNewUserPage() {
  return (
    <Suspense fallback={null}>
      <NewUser />
    </Suspense>
  );
}
