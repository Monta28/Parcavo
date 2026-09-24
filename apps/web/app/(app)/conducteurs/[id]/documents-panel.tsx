'use client';

import { useQuery } from '@tanstack/react-query';
import { OwnerDocumentsPanel } from '@/components/documents/owner-documents-panel';
import { driverOption } from '@/components/documents/owner-pickers';
import { api } from '@/lib/api-client';
import type { DriverView } from '@/lib/drivers-types';

/**
 * Onglet « Documents » de la fiche conducteur (CDC 7.1, 7.2) : conformité du conducteur
 * (GET /documents/compliance?driverId=) et versions (GET /documents?driverId=), avec enregistrement,
 * renouvellement, correction et archivage. Composant autonome, à intégrer dans driver-detail.
 */
export function DriverDocumentsPanel({ driverId, companyId }: { driverId: string; companyId: string }) {
  const driver = useQuery({ queryKey: ['driver', driverId, 'view'], queryFn: () => api<DriverView>(`/drivers/${driverId}`) });
  return <OwnerDocumentsPanel ownerType="CONDUCTEUR" ownerId={driverId} companyId={companyId} owner={driver.data ? driverOption(driver.data) : null} />;
}
