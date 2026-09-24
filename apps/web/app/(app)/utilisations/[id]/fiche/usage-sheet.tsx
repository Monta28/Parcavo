'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DISTANCE_STATUS_LABELS, FUEL_GAUGE_LABELS, READING_STATUS_LABELS, USAGE_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { OVERRIDE_LEGAL_NOTICE } from '@/components/documents/override-notice';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ReservationView } from '@/lib/reservations-types';
import type { UsageChecklistEntry, UsageDetailView, UsageReadingRef } from '@/lib/usages-types';
import { parseChecklist } from '../../usage-helpers';
import { UsageSheetHandSignatures } from './usage-sheet-extras';

/** Fiche de remise et de restitution imprimable (CDC 4.4) : noms, dates, relevés, accessoires et réserves. */
export function UsageSheet({ id }: { id: string }) {
  const { session } = useAppScope();
  const tz = session.timezone;
  const usage = useQuery({ queryKey: ['usage', id], queryFn: () => api<UsageDetailView>(`/usages/${id}`) });
  const reservationId = usage.data?.reservationId ?? null;
  const reservation = useQuery({ queryKey: ['reservation', reservationId], queryFn: () => api<ReservationView>(`/reservations/${reservationId}`), enabled: reservationId !== null });
  const [editedAt] = useState(() => new Date().toISOString());

  if (usage.data === undefined) {
    return usage.isError ? <ErrorState error={usage.error} retry={() => void usage.refetch()} /> : <LoadingState label="Préparation de la fiche…" />;
  }
  const u = usage.data;
  const company = session.companies.find((c) => c.id === u.companyId);
  const outList = parseChecklist(u.checkoutChecklist);
  const backList = parseChecklist(u.returnChecklist);
  const labels = [...new Set([...outList.map((i) => i.label), ...backList.map((i) => i.label)])];

  return (
    <div className="mx-auto max-w-4xl">
      <style>{`@media print {
  @page { size: A4; margin: 14mm; }
  .usage-sheet { font-size: 10.5pt; color: #000; }
  .usage-sheet section, .usage-sheet tr { break-inside: avoid; }
}`}</style>
      <div className="no-print mb-4 flex flex-wrap gap-2">
        <Button type="button" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" /> Imprimer
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/utilisations/${u.id}`}>
            <ArrowLeft className="size-4" aria-hidden="true" /> Retour à l’utilisation
          </Link>
        </Button>
      </div>

      <article className="usage-sheet space-y-6 rounded-md border bg-background p-6 text-sm print:border-0 print:p-0">
        <header className="flex flex-col gap-2 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Fiche de remise et de restitution</h1>
            <p className="text-muted-foreground">
              {session.organizationName}
              {company ? ` · ${company.code} ${company.name}` : ''}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p>
              Statut : <span className="font-medium">{USAGE_STATUS_LABELS[u.status] ?? u.status}</span>
            </p>
            <p className="text-muted-foreground">Éditée le {formatDateTime(editedAt, tz)}</p>
          </div>
        </header>

        <section aria-labelledby="sheet-general" className="space-y-2">
          <h2 id="sheet-general" className="text-base font-semibold">
            Véhicule et conducteur
          </h2>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Row label="Véhicule" value={`${u.vehicleCode} · ${u.vehicleRegistration}`} />
            <Row label="Conducteur" value={u.driverName} />
            <Row label="Motif" value={u.purpose} />
            <Row label="Retour prévu" value={formatDateTime(u.expectedReturnAt, tz)} />
            {reservationId ? (
              <Row
                label="Réservation convertie"
                value={reservation.data ? `du ${formatDateTime(reservation.data.startAt, tz)} au ${formatDateTime(reservation.data.endAt, tz)}` : reservation.isError ? 'indisponible' : 'chargement…'}
              />
            ) : null}
            <Row label="Distance" value={`${formatKm(u.distanceKm)} · ${DISTANCE_STATUS_LABELS[u.distanceStatus] ?? u.distanceStatus}`} />
          </dl>
        </section>

        <section aria-labelledby="sheet-sides" className="space-y-2">
          <h2 id="sheet-sides" className="text-base font-semibold">
            Remise et restitution
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="w-1/4 py-2 pr-3 font-medium text-muted-foreground">
                    <span className="sr-only">Rubrique</span>
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Remise
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Restitution
                  </th>
                </tr>
              </thead>
              <tbody>
                <SideRow label="Date et heure" out={formatDateTime(u.checkedOutAt, tz)} back={u.returnedAt ? formatDateTime(u.returnedAt, tz) : 'Non restitué'} />
                <SideRow label="Enregistrée par" out={u.checkedOutByName ?? '—'} back={u.returnedAt ? (u.returnedByName ?? '—') : '—'} />
                <SideRow label="Lieu" out={u.checkoutLocation ?? 'Non renseigné'} back={u.returnedAt ? (u.returnLocation ?? 'Non renseigné') : '—'} />
                <SideRow
                  label="Relevé du compteur"
                  out={readingText(u.checkoutReading, u.checkoutWithoutReading, 'Départ sans relevé', tz)}
                  back={u.returnedAt ? readingText(u.returnReading, u.returnWithoutReading, 'Retour constaté sans relevé', tz) : '—'}
                />
                {u.checkoutExceptionReason || u.returnExceptionReason ? <SideRow label="Motif d’exception" out={u.checkoutExceptionReason ?? '—'} back={u.returnExceptionReason ?? '—'} /> : null}
                <SideRow label="Carburant" out={gaugeText(u.checkoutFuelGauge)} back={u.returnedAt ? gaugeText(u.returnFuelGauge) : '—'} />
                <SideRow label="Observations et réserves" out={u.checkoutNotes ?? 'Aucune'} back={u.returnedAt ? (u.returnNotes ?? 'Aucune') : '—'} />
                {u.damageIncident ? <SideRow label="Dommage constaté" out="—" back={`Incident ${u.damageIncident.reference} ouvert au retour`} /> : null}
                <SideRow label="Confirmation nominative" out={u.checkoutConfirmedBy ?? '—'} back={u.returnConfirmedBy ?? '—'} />
              </tbody>
            </table>
          </div>
          {u.documentOverrideReason ? (
            <p>
              Départ autorisé par dérogation motivée : {u.documentOverrideReason}. {OVERRIDE_LEGAL_NOTICE}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="sheet-checklist" className="space-y-2">
          <h2 id="sheet-checklist" className="text-base font-semibold">
            Clés, documents et accessoires
          </h2>
          {labels.length === 0 ? (
            <p className="text-muted-foreground">Checklist non renseignée.</p>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Élément
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Remise
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Restitution
                  </th>
                </tr>
              </thead>
              <tbody>
                {labels.map((label) => (
                  <tr key={label} className="border-b align-top">
                    <th scope="row" className="py-1.5 pr-3 font-normal">
                      {label}
                    </th>
                    <td className="py-1.5 pr-3">{checklistText(outList, label)}</td>
                    <td className="py-1.5">{u.returnedAt ? checklistText(backList, label) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-labelledby="sheet-confirm" className="space-y-3 border-t pt-4">
          <h2 id="sheet-confirm" className="text-base font-semibold">
            Confirmation nominative
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
            <div className="min-h-20 rounded-md border p-3">
              <p className="text-muted-foreground">À la remise</p>
              <p className="font-medium">{u.checkoutConfirmedBy ?? ' '}</p>
            </div>
            <div className="min-h-20 rounded-md border p-3">
              <p className="text-muted-foreground">À la restitution</p>
              <p className="font-medium">{u.returnConfirmedBy ?? ' '}</p>
            </div>
          </div>
          <p className="font-medium">Ceci n’est pas une signature certifiée.</p>
          <p className="text-xs text-muted-foreground">La confirmation nominative est une simple mention du nom saisie dans l’application ; elle n’a pas valeur de signature électronique.</p>
        </section>

        <UsageSheetHandSignatures />
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label} :</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function SideRow({ label, out, back }: { label: string; out: string; back: string }) {
  return (
    <tr className="border-b align-top">
      <th scope="row" className="py-1.5 pr-3 font-normal text-muted-foreground">
        {label}
      </th>
      <td className="whitespace-pre-wrap py-1.5 pr-3">{out}</td>
      <td className="whitespace-pre-wrap py-1.5">{back}</td>
    </tr>
  );
}

function readingText(reading: UsageReadingRef | null, without: boolean, withoutLabel: string, tz: string): string {
  if (reading) return `${formatKm(reading.physicalKm)} (${READING_STATUS_LABELS[reading.status] ?? reading.status}, observé le ${formatDateTime(reading.observedAt, tz)})`;
  return without ? withoutLabel : 'Aucun relevé';
}

function gaugeText(value: string | null): string {
  return value ? (FUEL_GAUGE_LABELS[value as keyof typeof FUEL_GAUGE_LABELS] ?? value) : 'Non renseigné';
}

function checklistText(list: UsageChecklistEntry[], label: string): string {
  const item = list.find((i) => i.label === label);
  if (!item) return 'Non renseigné';
  return `${item.present ? 'Présent' : 'Absent'}${item.comment ? ` · ${item.comment}` : ''}`;
}
