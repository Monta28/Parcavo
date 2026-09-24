import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlanningView } from './planning-view';

export const metadata: Metadata = { title: 'Planning' };

export default function PlanningPage() {
  return (
    <Suspense fallback={null}>
      <PlanningView />
    </Suspense>
  );
}
