import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TelemetryAdmin } from './telemetry-admin';

export const metadata: Metadata = { title: 'Télématique' };

export default function AdministrationTelemetryPage() {
  return (
    <Suspense fallback={null}>
      <TelemetryAdmin />
    </Suspense>
  );
}
