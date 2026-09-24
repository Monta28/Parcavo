'use client';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { Gauge, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { readingKmLabel } from '@/components/odometer/reading-helpers';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { formatDateTime } from '@/lib/format';
import type { OdometerCurrentView } from '@/lib/odometer-types';
import type { ReservationView } from '@/lib/reservations-types';
import type { UsageDetailView } from '@/lib/usages-types';
import { useOnlineStatus } from '@/lib/use-online-status';
import type { VehicleView } from '@/lib/vehicles-types';
import { formatSlot, reservationStatusLabel, toneForReservation } from '../planning/planning-shared';
import { MySubmissions } from './my-submissions';
import { ReadingForm } from './reading-form';
import { ReportIncident } from './report-incident';

/**
 * Espace conducteur mobile (CDC 10.3, D-240, D-268) : utilisation en cours (GET /drivers/:id →
 * currentUsageId → GET /usages/:id), action « Ajouter un kilométrage », suivi des soumissions et
 * prochaines réservations. Les retards, statuts et kilométrages affichés sont ceux calculés par l'API.
 */
export function MyVehicle() {
  const session = useSession();
  const driverId = session.driverId;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Mon véhicule" description="Utilisation en cours, kilométrage et suivi de vos soumissions." />
      <OfflineNotice />
      {driverId ? (
        <DriverSpace driverId={driverId} />
      ) : (
        <EmptyState title="Aucune fiche conducteur liée" description="Votre compte n’est rattaché à aucune fiche conducteur. Contactez le gestionnaire du parc." />
      )}
    </div>
  );
}

function OfflineNotice() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <WifiOff className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <p>
        <span className="font-medium text-destructive">Vous êtes hors connexion.</span> Aucune saisie ne peut être envoyée : rien n’est enregistré tant que la connexion n’est pas rétablie. Les informations affichées peuvent ne pas être à jour.
      </p>
    </div>
  );
}

function DriverSpace({ driverId }: { driverId: string }) {
  const session = useSession();
  const driver = useQuery({ queryKey: ['driver', driverId], queryFn: () => api<DriverView>(`/drivers/${driverId}`) });
  const usageId = driver.data?.currentUsageId ?? null;
  const usage = useQuery({ queryKey: ['usage', usageId], queryFn: () => api<UsageDetailView>(`/usages/${usageId}`), enabled: usageId !== null });
  const current = usage.data && usage.data.status === 'EN_COURS' ? usage.data : null;
  const vehicleId = current?.vehicleId ?? null;
  const odometer = useQuery({ queryKey: ['vehicle', vehicleId, 'odometer'], queryFn: () => api<OdometerCurrentView>(`/vehicles/${vehicleId}/odometer`), enabled: vehicleId !== null });
  const [formOpen, setFormOpen] = useState(false);
  const usageLoading = usageId !== null && usage.isPending;
  // Nouvelle instance du formulaire à chaque ouverture (nouvelle clé d'idempotence, sauf brouillon non envoyé).
  const [formKey, setFormKey] = useState(0);

  if (driver.isPending) return <LoadingState />;
  if (driver.isError) return <ErrorState error={driver.error} retry={() => void driver.refetch()} />;

  const lastReading = odometer.data?.reading ?? null;
  const reference = lastReading ? `${readingKmLabel(lastReading)} le ${formatDateTime(lastReading.observedAt, session.timezone)}` : null;

  return (
    <div className="space-y-6">
      <section aria-label="Utilisation en cours">
        {usageId === null ? (
          <EmptyState title="Aucun véhicule remis" description="Aucune utilisation n’est en cours à votre nom. Le kilométrage se déclare pendant une utilisation en cours ; l’historique de vos soumissions reste consultable ci-dessous." />
        ) : usage.isPending ? (
          <LoadingState label="Chargement de l’utilisation…" />
        ) : usage.isError ? (
          <ErrorState error={usage.error} retry={() => void usage.refetch()} />
        ) : current ? (
          <CurrentUsageCard usage={current} odometer={odometer} />
        ) : (
          <EmptyState title="Aucun véhicule remis" description="Votre dernière utilisation est terminée." />
        )}
      </section>

      <section aria-label="Actions" className="space-y-2">
        {formOpen && current ? (
          <ReadingForm key={formKey} usage={current} reference={reference} onClose={() => setFormOpen(false)} />
        ) : (
          <>
            <Button
              size="lg"
              className="h-14 w-full text-base"
              disabled={!current}
              aria-describedby={current || usageLoading ? undefined : 'reading-unavailable'}
              onClick={() => {
                setFormKey((k) => k + 1);
                setFormOpen(true);
              }}
            >
              <Gauge className="size-5" aria-hidden="true" /> Ajouter un kilométrage
            </Button>
            {current || usageLoading ? null : (
              <p id="reading-unavailable" className="text-sm text-muted-foreground">
                Disponible uniquement pendant une utilisation en cours.
              </p>
            )}
          </>
        )}
      </section>

      <ReportIncident />
      <MySubmissions />
      <UpcomingReservations driverId={driverId} />
    </div>
  );
}

function CurrentUsageCard({ usage: u, odometer }: { usage: UsageDetailView; odometer: UseQueryResult<OdometerCurrentView> }) {
  const session = useSession();
  const vehicle = useQuery({ queryKey: ['vehicle', u.vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${u.vehicleId}`) });
  const lastReading = odometer.data?.reading ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h2 className="text-xl font-semibold">
            {u.vehicleCode} · {u.vehicleRegistration}
          </h2>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={`Utilisation ${(USAGE_STATUS_LABELS[u.status as keyof typeof USAGE_STATUS_LABELS] ?? u.status).toLowerCase()}`} tone="info" />
          {u.isLate ? <StatusBadge label="Retour dépassé" tone="danger" /> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {u.isLate ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            Le retour était prévu le {formatDateTime(u.expectedReturnAt, session.timezone)}. Rapportez le véhicule ou contactez le gestionnaire du parc.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Marque et modèle" value={vehicle.data ? `${vehicle.data.make} ${vehicle.data.model}` : vehicle.isError ? (isApiError(vehicle.error) ? vehicle.error.message : 'Indisponible') : 'Chargement…'} />
          <Field label="Motif" value={u.purpose} />
          <Field label="Remis le" value={formatDateTime(u.checkedOutAt, session.timezone)} />
          <Field label="Retour prévu le" value={formatDateTime(u.expectedReturnAt, session.timezone)} />
          {u.checkoutLocation ? <Field label="Lieu de remise" value={u.checkoutLocation} /> : null}
          <Field
            label="Dernier kilométrage validé"
            value={odometer.isPending ? 'Chargement…' : odometer.isError ? (isApiError(odometer.error) ? odometer.error.message : 'Indisponible') : lastReading ? `${readingKmLabel(lastReading)} le ${formatDateTime(lastReading.observedAt, session.timezone)}` : 'Aucun kilométrage validé'}
          />
        </dl>
        <p>
          <Link href={`/utilisations/${u.id}`} className="underline underline-offset-4">
            Voir le détail de l’utilisation
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/** Prochaines réservations confirmées du conducteur (D-240) : véhicule et créneau. */
function UpcomingReservations({ driverId }: { driverId: string }) {
  const session = useSession();
  const [now] = useState(() => new Date().toISOString());
  // Compte conducteur : l'API restreint d'office à ses réservations ; personnel avec fiche : filtre explicite.
  const query = toQuery({ driverId: session.isDriverOnly ? undefined : driverId, status: 'CONFIRMEE', from: now, order: 'asc', pageSize: 5 });
  const reservations = useQuery({ queryKey: ['reservations', 'mon-vehicule', query], queryFn: () => api<Page<ReservationView>>(`/reservations${query}`) });
  const allHref = session.isDriverOnly ? '/planning/reservations' : `/planning/reservations?conducteur=${encodeURIComponent(driverId)}`;

  return (
    <section aria-labelledby="reservations-title" className="space-y-3">
      <h2 id="reservations-title" className="text-lg font-semibold">
        Mes prochaines réservations
      </h2>
      {reservations.isPending ? (
        <LoadingState label="Chargement des réservations…" />
      ) : reservations.isError ? (
        <ErrorState error={reservations.error} retry={() => void reservations.refetch()} />
      ) : reservations.data.total === 0 ? (
        <EmptyState title="Aucune réservation à venir" />
      ) : (
        <div className="space-y-2">
          <ul className="space-y-2">
            {reservations.data.items.map((r) => (
              <li key={r.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {r.vehicleCode} · {r.vehicleRegistration}
                    </p>
                    <p className="text-muted-foreground">{formatSlot(r.startAt, r.endAt, session.timezone)}</p>
                    <p>{r.purpose}</p>
                  </div>
                  <StatusBadge label={reservationStatusLabel(r.status)} tone={toneForReservation(r.status)} />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <Link href={allHref} className="underline underline-offset-4">
              Toutes mes réservations{reservations.data.total > reservations.data.items.length ? ` (${reservations.data.total})` : ''}
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || '—'}</dd>
    </div>
  );
}
