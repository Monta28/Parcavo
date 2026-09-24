'use client';

import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { api } from '@/lib/api-client';
import type { DriverView } from '@/lib/drivers-types';
import type { ReservationView } from '@/lib/reservations-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { useOperationalIn } from '../usage-helpers';
import { CheckoutForm } from './checkout-form';

/**
 * Remise d'un véhicule (CDC 4.3). Préremplissage facultatif depuis l'URL : ?reservationId= ou ?reservation=
 * (réservation confirmée à convertir, lien « Convertir en remise » du planning), ?vehicule= et ?conducteur=.
 */
export function NewCheckout() {
  const params = useSearchParams();
  const { session, companyId } = useAppScope();
  const canCheckout = useOperationalIn(companyId) && !session.isDriverOnly;
  const reservationId = params.get('reservationId') ?? params.get('reservation');
  const reservation = useQuery({
    queryKey: ['reservation', reservationId],
    queryFn: () => api<ReservationView>(`/reservations/${reservationId}`),
    enabled: canCheckout && Boolean(reservationId),
  });
  const reservationReady = !reservationId || reservation.isSuccess;
  const vehicleId = reservation.data?.vehicleId ?? params.get('vehicule');
  const driverId = reservation.data?.driverId ?? params.get('conducteur');
  const vehicle = useQuery({ queryKey: ['vehicle', vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${vehicleId}`), enabled: canCheckout && reservationReady && Boolean(vehicleId) });
  const driver = useQuery({ queryKey: ['driver', driverId], queryFn: () => api<DriverView>(`/drivers/${driverId}`), enabled: canCheckout && reservationReady && Boolean(driverId) });

  const header = <PageHeader title="Nouvelle remise" description="Remise réelle d’un véhicule à un conducteur : les contrôles sont refaits par le serveur au moment de l’enregistrement." />;

  if (!canCheckout) {
    return (
      <div>
        {header}
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 py-10 text-center">
          <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Accès refusé</p>
          <p className="max-w-md text-sm text-muted-foreground">La remise d’un véhicule est réservée aux opérateurs, chefs de parc et administrateurs de la société.</p>
        </div>
      </div>
    );
  }
  // Seul le premier chargement conditionne l'affichage : un rafraîchissement ultérieur ne démonte pas le formulaire.
  if (reservationId && reservation.data === undefined) {
    return reservation.isError ? <ErrorState error={reservation.error} retry={() => void reservation.refetch()} /> : <LoadingState label="Chargement de la réservation…" />;
  }
  if (vehicleId && vehicle.data === undefined) {
    return vehicle.isError ? <ErrorState error={vehicle.error} retry={() => void vehicle.refetch()} /> : <LoadingState label="Chargement du véhicule…" />;
  }
  if (driverId && driver.data === undefined) {
    return driver.isError ? <ErrorState error={driver.error} retry={() => void driver.refetch()} /> : <LoadingState label="Chargement du conducteur…" />;
  }

  return (
    <div>
      {header}
      <CheckoutForm initialVehicle={vehicle.data ?? null} initialDriver={driver.data ?? null} initialReservation={reservation.data ?? null} />
    </div>
  );
}
