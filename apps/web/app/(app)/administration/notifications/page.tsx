import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NotificationsAdmin } from './notifications-admin';

export const metadata: Metadata = { title: 'Notifications' };

export default function AdministrationNotificationsPage() {
  return (
    <Suspense fallback={null}>
      <NotificationsAdmin />
    </Suspense>
  );
}
