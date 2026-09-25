import type { Metadata } from 'next';
import { NotificationPreferencesView } from './notification-preferences';

export const metadata: Metadata = { title: 'Mes notifications' };

export default function NotificationPreferencesPage() {
  return <NotificationPreferencesView />;
}
