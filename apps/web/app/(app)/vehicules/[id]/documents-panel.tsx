'use client';

import { useQuery } from '@tanstack/react-query';
import { OwnerDocumentsPanel } from '@/components/documents/owner-documents-panel';
import { vehicleOption } from '@/components/documents/owner-pickers';
import { api } from '@/lib/api-client';
import type { VehicleView } from '@/lib/vehicles-types';

/**
 * Onglet « Documents » de la fiche véhicule (CDC 7.1, 7.2) : conformité du véhicule
 * (GET /documents/compliance?vehicleId=) et versions (GET /documents?vehicleId=), avec enregistrement,
 * renouvellement, correction et archivage. Composant autonome, à intégrer dans vehicle-detail.
 */
export function VehicleDocumentsPanel({ vehicleId, companyId }: { vehicleId: string; companyId: string }) {
  const vehicle = useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`) });
  return <OwnerDocumentsPanel ownerType="VEHICULE" ownerId={vehicleId} companyId={companyId} owner={vehicle.data ? vehicleOption(vehicle.data) : null} />;
}
