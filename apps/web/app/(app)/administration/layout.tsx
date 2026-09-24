import type { Metadata } from 'next';
import { AdminShell } from './admin-shell';

export const metadata: Metadata = { title: { default: 'Administration', template: '%s · Administration · Parc Auto' } };

export default function AdministrationLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
