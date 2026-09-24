'use client';

import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DISTANCE_STATUS_LABELS, FUEL_GAUGE_LABELS, READING_STATUS_LABELS, RESERVATION_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { OverrideLegalNotice } from '@/components/documents/override-notice';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ReservationView } from '@/lib/reservations-types';
import type { UsageChecklistEntry, UsageDetailView, UsageReadingRef } from '@/lib/usages-types';
import { parseChecklist, toneForDistance, toneForReading, useCanIn, useOperationalIn } from '../usage-helpers';
import { ExtendDialog } from './extend-dialog';
import { RegularizeDialog } from './regularize-dialog';
import { ReturnForm } from './return-form';

/** Détail d'une utilisation (CDC 4.3 à 4.5) : remise, restitution, distance, photos et actions. */
export function UsageDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const usage = useQuery({ queryKey: ['usage', id], queryFn: () => api<UsageDetailView>(`/usages/${id}`) });
  const canOperate = useOperationalIn(usage.data?.companyId ?? null) && !session.isDriverOnly;
  // Validation des relevés en attente : permission readings.approve sur la société de l'utilisation.
  const canApprove = useCanIn(usage.data?.companyId ?? null, 'readings.approve') && !session.isDriverOnly;
  // Régularisation de la distance : permission exceptions.override (chef, administrateur) ; l'état est jugé par l'API.
  const canOverride = useCanIn(usage.data?.companyId ?? null, 'exceptions.override') && !session.isDriverOnly;
  const [regularizeOpen, setRegularizeOpen] = useState(false);
  const [regularizeKey, setRegularizeKey] = useState(0);
  const [returnOpen, setReturnOpen] = useState(false);
  // Nouvelle instance à chaque ouverture : nouvelle clé d'idempotence et champs vierges.
  const [returnKey, setReturnKey] = useState(0);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendKey, setExtendKey] = useState(0);

  // Un rafraîchissement en échec conserve la fiche affichée (et un éventuel formulaire de retour en cours de saisie).
  if (usage.data === undefined) {
    return usage.isError ? <ErrorState error={usage.error} retry={() => void usage.refetch()} /> : <LoadingState label="Chargement de l’utilisation…" />;
  }
  const u = usage.data;
  const staff = !session.isDriverOnly;
  const open = u.status === 'EN_COURS';
  const companyCode = session.companies.find((c) => c.id === u.companyId)?.code ?? null;
  const canRegularize = canOverride && u.returnReadingRegularizable;
  const openRegularize = () => {
    setRegularizeKey((k) => k + 1);
    setRegularizeOpen(true);
  };

  const openReturn = () => {
    setReturnKey((k) => k + 1);
    setReturnOpen(true);
    requestAnimationFrame(() => {
      const heading = document.getElementById('retour-titre');
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      heading?.focus();
    });
  };

  return (
    <div>
      <PageHeader
        title={`${u.vehicleCode} · ${u.vehicleRegistration}`}
        description={`Utilisation par ${u.driverName}${companyCode ? ` · Société ${companyCode}` : ''} · Motif : ${u.purpose}`}
        actions={
          <>
            {canOperate && open && !returnOpen ? <Button onClick={openReturn}>Enregistrer le retour</Button> : null}
            {canOperate && open ? (
              <Button
                variant="outline"
                onClick={() => {
                  setExtendKey((k) => k + 1);
                  setExtendOpen(true);
                }}
              >
                Prolonger le retour prévu
              </Button>
            ) : null}
            {canRegularize ? (
              <Button variant="outline" onClick={openRegularize}>
                Régulariser la distance
              </Button>
            ) : null}
            <Button variant="outline" asChild>
              <Link href={`/utilisations/${u.id}/fiche`}>
                <Printer className="size-4" aria-hidden="true" /> Fiche imprimable
              </Link>
            </Button>
          </>
        }
      />

      {usage.isError ? (
        <p role="alert" className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          Actualisation impossible : {isApiError(usage.error) ? usage.error.message : 'erreur inconnue'} Les informations affichées peuvent être dépassées.{' '}
          <button type="button" className="underline underline-offset-4" onClick={() => void usage.refetch()}>
            Réessayer
          </button>
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={USAGE_STATUS_LABELS[u.status] ?? u.status} tone={open ? 'info' : 'neutral'} />
        {u.isLate ? <StatusBadge label="Retour dépassé" tone="danger" /> : null}
        <StatusBadge label={DISTANCE_STATUS_LABELS[u.distanceStatus] ?? u.distanceStatus} tone={toneForDistance(u.distanceStatus)} />
        {u.checkoutWithoutReading ? <StatusBadge label="Départ sans relevé" tone="warning" /> : null}
        {u.returnWithoutReading ? <StatusBadge label="Retour constaté sans relevé" tone="warning" /> : null}
        {u.documentOverrideReason ? <StatusBadge label="Départ avec dérogation" tone="warning" /> : null}
      </div>

      {open && u.isLate ? (
        <p role="status" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          Le retour prévu du {formatDateTime(u.expectedReturnAt, session.timezone)} est dépassé. L’utilisation reste ouverte tant que le retour n’est pas enregistré.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Véhicule et conducteur</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Véhicule">
                {staff ? (
                  <Link href={`/vehicules/${u.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                    {u.vehicleCode} · {u.vehicleRegistration}
                  </Link>
                ) : (
                  `${u.vehicleCode} · ${u.vehicleRegistration}`
                )}
              </Field>
              <Field label="Conducteur">
                {staff ? (
                  <Link href={`/conducteurs/${u.driverId}`} className="font-medium underline-offset-4 hover:underline">
                    {u.driverName}
                  </Link>
                ) : (
                  u.driverName
                )}
              </Field>
              <Field label="Motif">{u.purpose}</Field>
              <Field label="Retour prévu">{formatDateTime(u.expectedReturnAt, session.timezone)}</Field>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Distance</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-2xl font-semibold">{formatKm(u.distanceKm)}</p>
            <StatusBadge label={DISTANCE_STATUS_LABELS[u.distanceStatus] ?? u.distanceStatus} tone={toneForDistance(u.distanceStatus)} />
            <p className="text-muted-foreground">Distance calculée par le serveur ; elle n’est validée qu’à partir de deux relevés acceptés (départ et retour).</p>
            {u.returnReadingRegularizable ? (
              <div role="status" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2">
                <p>Distance non validée : {u.returnWithoutReading ? 'le retour a été constaté sans relevé' : 'le relevé de retour a été rejeté'}. Elle le restera jusqu’à la régularisation par un relevé accepté.</p>
                {canRegularize ? (
                  <Button type="button" size="sm" variant="outline" onClick={openRegularize}>
                    Régulariser la distance
                  </Button>
                ) : (
                  <p className="text-muted-foreground">La régularisation est réservée au chef de parc ou à l’administrateur.</p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Réservation</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{u.reservationId ? <ReservationSummary reservationId={u.reservationId} timezone={session.timezone} /> : <p className="text-muted-foreground">Remise effectuée sans réservation.</p>}</CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SideCard
          title="Remise"
          timezone={session.timezone}
          at={u.checkedOutAt}
          by={u.checkedOutByName}
          location={u.checkoutLocation}
          reading={u.checkoutReading}
          withoutReading={u.checkoutWithoutReading}
          withoutReadingLabel="Départ sans relevé"
          exceptionReason={u.checkoutExceptionReason}
          fuel={u.checkoutFuelGauge}
          confirmedBy={u.checkoutConfirmedBy}
          notes={u.checkoutNotes}
          checklist={parseChecklist(u.checkoutChecklist)}
          readingAction={canApprove && u.checkoutReading?.status === 'EN_ATTENTE' ? <PendingReadingLink vehicleId={u.vehicleId} /> : null}
          extra={
            u.documentOverrideReason ? (
              <Field label="Dérogation accordée">
                {u.documentOverrideReason}
                <OverrideLegalNotice className="mt-1" />
              </Field>
            ) : null
          }
        />
        {u.returnedAt ? (
          <SideCard
            title="Restitution"
            timezone={session.timezone}
            at={u.returnedAt}
            by={u.returnedByName}
            location={u.returnLocation}
            reading={u.returnReading}
            withoutReading={u.returnWithoutReading}
            withoutReadingLabel="Retour constaté sans relevé"
            exceptionReason={u.returnExceptionReason}
            fuel={u.returnFuelGauge}
            confirmedBy={u.returnConfirmedBy}
            notes={u.returnNotes}
            checklist={parseChecklist(u.returnChecklist)}
            readingAction={canApprove && u.returnReading?.status === 'EN_ATTENTE' ? <PendingReadingLink vehicleId={u.vehicleId} /> : null}
            extra={
              <Field label="Dommage constaté">
                {u.damageIncident ? (
                  <Link href={`/incidents/${u.damageIncident.id}`} className="font-medium underline underline-offset-4">
                    Incident {u.damageIncident.reference}
                    <span className="sr-only"> (ouvert lors de la restitution)</span>
                  </Link>
                ) : (
                  'Aucun dommage déclaré au retour'
                )}
              </Field>
            }
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <h2>Restitution</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>Véhicule non restitué. Retour prévu le {formatDateTime(u.expectedReturnAt, session.timezone)}.</p>
              {canOperate && !returnOpen ? (
                <Button type="button" variant="outline" onClick={openReturn}>
                  Enregistrer le retour
                </Button>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">
            <h2>Photos</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {u.photoAttachmentIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune photo jointe à la remise ou à la restitution.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {u.photoAttachmentIds.map((pid, index) => (
                <li key={pid} className="space-y-1">
                  <a href={`/api/v1/attachments/${pid}/download`} target="_blank" rel="noopener noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/v1/attachments/${pid}/download`} alt={`Photo ${index + 1} de l’utilisation`} className="aspect-video w-full rounded-md border object-cover" />
                  </a>
                  <a href={`/api/v1/attachments/${pid}/download`} download className="text-sm underline underline-offset-4">
                    Télécharger<span className="sr-only"> la photo {index + 1}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canOperate && open && returnOpen ? (
        <div className="mt-4">
          <ReturnForm key={returnKey} usage={u} onDone={() => setReturnOpen(false)} onCancel={() => setReturnOpen(false)} />
        </div>
      ) : null}

      {canOperate && open ? <ExtendDialog key={extendKey} usage={u} open={extendOpen} onOpenChange={setExtendOpen} /> : null}
      {canRegularize ? <RegularizeDialog key={regularizeKey} usage={u} open={regularizeOpen} onOpenChange={setRegularizeOpen} /> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children ?? '—'}</dd>
    </div>
  );
}

/** File de validation du kilométrage, filtrée sur le véhicule (la décision reste prise par l'API). */
function PendingReadingLink({ vehicleId }: { vehicleId: string }) {
  return (
    <Link href={`/kilometrage?onglet=a-valider&vehicule=${encodeURIComponent(vehicleId)}`} className="text-xs underline underline-offset-4">
      Valider ou rejeter le relevé en attente
    </Link>
  );
}

function ReservationSummary({ reservationId, timezone }: { reservationId: string; timezone: string }) {
  const reservation = useQuery({ queryKey: ['reservation', reservationId], queryFn: () => api<ReservationView>(`/reservations/${reservationId}`) });
  if (reservation.isPending) return <p className="text-muted-foreground">Chargement de la réservation…</p>;
  if (reservation.isError) {
    return (
      <p role="alert" className="text-destructive">
        Réservation indisponible : {isApiError(reservation.error) ? reservation.error.message : 'erreur inconnue'}
      </p>
    );
  }
  const r = reservation.data;
  return (
    <div className="space-y-2">
      <p>
        Réservation convertie : du {formatDateTime(r.startAt, timezone)} au {formatDateTime(r.endAt, timezone)}
      </p>
      <StatusBadge label={RESERVATION_STATUS_LABELS[r.status] ?? r.status} tone={r.status === 'CONVERTIE' ? 'success' : 'neutral'} />
      <p className="text-muted-foreground">Motif réservé : {r.purpose}</p>
      {r.destination ? <p className="text-muted-foreground">Destination : {r.destination}</p> : null}
    </div>
  );
}

function SideCard({
  title,
  timezone,
  at,
  by,
  location,
  reading,
  withoutReading,
  withoutReadingLabel,
  exceptionReason,
  fuel,
  confirmedBy,
  notes,
  checklist,
  readingAction,
  extra,
}: {
  title: string;
  timezone: string;
  at: string;
  by: string | null;
  location: string | null;
  reading: UsageReadingRef | null;
  withoutReading: boolean;
  withoutReadingLabel: string;
  exceptionReason: string | null;
  fuel: string | null;
  confirmedBy: string | null;
  notes: string | null;
  checklist: UsageChecklistEntry[];
  readingAction?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Field label="Date et heure">{formatDateTime(at, timezone)}</Field>
          <Field label="Enregistrée par">{by ?? '—'}</Field>
          <Field label="Lieu">{location ?? 'Non renseigné'}</Field>
          <Field label="Carburant">{fuel ? (FUEL_GAUGE_LABELS[fuel as keyof typeof FUEL_GAUGE_LABELS] ?? fuel) : 'Non renseigné'}</Field>
          <Field label="Relevé du compteur">
            {reading ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{formatKm(reading.physicalKm)}</span>
                <StatusBadge label={READING_STATUS_LABELS[reading.status] ?? reading.status} tone={toneForReading(reading.status)} />
                <span className="block w-full text-xs text-muted-foreground">observé le {formatDateTime(reading.observedAt, timezone)}</span>
                {readingAction ? <span className="block w-full">{readingAction}</span> : null}
              </span>
            ) : withoutReading ? (
              <StatusBadge label={withoutReadingLabel} tone="warning" />
            ) : (
              'Aucun relevé'
            )}
          </Field>
          <Field label="Confirmation nominative">{confirmedBy ? `${confirmedBy} (non certifiée)` : '—'}</Field>
          {exceptionReason ? (
            <div className="sm:col-span-2">
              <Field label="Motif de l’exception">{exceptionReason}</Field>
            </div>
          ) : null}
          {extra ? <div className="sm:col-span-2">{extra}</div> : null}
          <div className="sm:col-span-2">
            <Field label="Observations">
              <span className="whitespace-pre-wrap">{notes ?? '—'}</span>
            </Field>
          </div>
        </dl>
        <div>
          <h3 className="mb-2 font-medium">Clés, documents et accessoires</h3>
          {checklist.length === 0 ? (
            <p className="text-muted-foreground">Checklist non renseignée.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {checklist.map((item) => (
                <li key={item.label} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {item.label}
                    {item.comment ? <span className="block text-xs text-muted-foreground">{item.comment}</span> : null}
                  </span>
                  <StatusBadge label={item.present ? 'Présent' : 'Absent'} tone={item.present ? 'success' : 'warning'} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
