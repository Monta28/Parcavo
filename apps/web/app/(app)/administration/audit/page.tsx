import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuditJournal } from './audit-journal';

export const metadata: Metadata = { title: 'Journal d’audit' };

export default function AdministrationAuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditJournal />
    </Suspense>
  );
}
