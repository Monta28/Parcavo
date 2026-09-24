import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SettingsAdmin } from './settings-admin';

export const metadata: Metadata = { title: 'Paramètres' };

export default function AdministrationSettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsAdmin />
    </Suspense>
  );
}
