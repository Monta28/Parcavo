import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelemetryWorkspace } from './telemetry-workspace';

export const metadata: Metadata = { title: 'Télématique' };

export default function TelemetryPage() {
  return (
    <Suspense fallback={null}>
      <TelemetryWorkspace />
    </Suspense>
  );
}
