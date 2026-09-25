'use client';

import { useQuery } from '@tanstack/react-query';
import { Satellite } from 'lucide-react';
import Link from 'next/link';
import { FUEL_MEASURE_KIND_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { vehicleFuelEventsPath } from '@/components/telemetry/fuel-events-link';
import { ProviderStatusBadge, SimulatorBadge, SimulatorNotice, formatPercentValue, fuelKindsLabel } from '@/components/telemetry/telemetry-display';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import { formatDateTime, formatKm, formatLiters } from '@/lib/format';
import { CALIBRATION_STATUS_LABELS, MAPPING_ODOMETER_KIND_LABELS, OBSERVED_ODOMETER_KIND_LABELS, type VehicleCalibrationView, type VehicleTelemetryView } from '@/lib/telemetry-types';
import { FuelThresholdsCard } from './fuel-thresholds-card';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Panneau télématique de la fiche véhicule (CDC 5.6, 14.5 ; D-101, D-178, D-190), autonome : unité
 * associée et natures retenues, dernière observation reçue, dernière estimation « estimé GPS » avec la
 * date de sa référence manuelle, dernier calibrage et dernière dérive. Toutes les valeurs viennent de
 * GET /telemetry/vehicles/:id ; aucun suivi en direct, aucune position.
 */
export function VehicleTelemetryPanel({ vehicleId, companyId }: { vehicleId: string; companyId: string }) {
  const { session } = useAppScope();
  const tz = session.timezone;
  const status = useQuery({ queryKey: ['telemetry', 'vehicle', vehicleId], queryFn: () => api<VehicleTelemetryView>(`/telemetry/vehicles/${vehicleId}`) });
  const canManage = session.isAdmin || session.grants.some((g) => g.companyId === companyId && g.role === 'CHEF_PARC');

  if (status.isPending) return <LoadingState />;
  if (status.isError) return <ErrorState error={status.error} retry={() => void status.refetch()} />;
  const t = status.data;
  const m = t.mapping;
  const obs = t.lastObservation;
  const manageLink = `/telematique${toQuery({ onglet: 'associations', categorie: m ? 'ASSOCIEES' : t.pendingProposals > 0 ? 'PROPOSEES' : 'VEHICULES_SANS_UNITE', q: t.vehicleCode })}`;

  return (
    <div className="space-y-4">
      {!t.telemetryEnabled ? (
        <p role="note" className="rounded-md border p-3 text-sm text-muted-foreground">
          Module télématique désactivé pour la société du véhicule : aucune donnée n’est lue et le kilométrage est saisi manuellement. Les données déjà reçues restent affichées ci-dessous.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Satellite className="size-4" aria-hidden="true" /> Unité associée
            </CardTitle>
            <CardDescription>Aucun suivi en direct : seules les données reçues du fournisseur sont affichées.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {m ? (
              <>
                {m.isSimulator ? <SimulatorNotice /> : null}
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <Row label="Unité">
                    {m.unitLabel} <span className="text-muted-foreground">({m.unitExternalId})</span>
                  </Row>
                  <Row label="Fournisseur">
                    {t.provider ? (
                      <span className="flex flex-wrap items-center gap-1">
                        {t.provider.name} {t.provider.isSimulator ? <SimulatorBadge /> : <span className="text-muted-foreground">({t.provider.kindLabel})</span>} <ProviderStatusBadge status={t.provider.status} />
                      </span>
                    ) : (
                      m.providerName
                    )}
                  </Row>
                  <Row label="Nature du kilométrage">
                    <StatusBadge label={MAPPING_ODOMETER_KIND_LABELS[m.odometerKind]} tone={m.odometerKind === 'DISTANCE_GPS' ? 'warning' : 'info'} />
                  </Row>
                  <Row label="Carburant">{fuelKindsLabel(m.fuelKinds)}</Row>
                  <Row label="Associée depuis le">{formatDateTime(m.validFrom, tz)}</Row>
                  {t.provider ? <Row label="Dernière synchronisation réussie">{t.provider.lastSuccessAt ? formatDateTime(t.provider.lastSuccessAt, tz) : 'Aucune'}</Row> : null}
                </dl>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucune unité associée : le kilométrage de ce véhicule est saisi manuellement.
                {t.pendingProposals > 0 ? ` ${t.pendingProposals} proposition(s) d’association attendent une confirmation.` : ''}
              </p>
            )}
            <p className="text-sm">
              <Link href={manageLink} className="underline underline-offset-4">
                {canManage ? (m ? 'Gérer l’association dans Télématique' : t.pendingProposals > 0 ? 'Confirmer la proposition dans Télématique' : 'Associer une unité dans Télématique') : 'Voir dans Télématique'}
              </Link>
            </p>
            {m && m.fuelKinds.length > 0 ? (
              <p className="text-sm">
                <Link href={vehicleFuelEventsPath(vehicleId)} className="underline underline-offset-4">
                  Événements carburant télématiques du véhicule
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dernière observation reçue</CardTitle>
            <CardDescription>Valeurs brutes du fournisseur ; seul un relevé accepté compte pour le compteur courant.</CardDescription>
          </CardHeader>
          <CardContent>
            {obs ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Row label={obs.odometerKind === 'DISTANCE_GPS' ? 'Distance GPS brute (odomètre virtuel)' : 'Compteur'}>
                  {obs.odometerKm !== null ? (
                    <>
                      {formatKm(obs.odometerKm)}
                      {obs.odometerKind ? <span className="block text-xs text-muted-foreground">{OBSERVED_ODOMETER_KIND_LABELS[obs.odometerKind]}</span> : null}
                    </>
                  ) : (
                    'Aucune'
                  )}
                </Row>
                <Row label="Observée le">{formatDateTime(obs.odometerObservedAt, tz)}</Row>
                <Row label="Carburant">
                  {obs.fuelKind ? (
                    <>
                      {[obs.fuelLiters !== null ? formatLiters(obs.fuelLiters) : null, formatPercentValue(obs.fuelPercent)].filter(Boolean).join(' · ') || '—'}
                      <span className="block text-xs text-muted-foreground">{FUEL_MEASURE_KIND_LABELS[obs.fuelKind]}</span>
                    </>
                  ) : (
                    'Aucune mesure'
                  )}
                </Row>
                <Row label="Mesure carburant du">{formatDateTime(obs.fuelObservedAt, tz)}</Row>
                <Row label="Dernière réception">{formatDateTime(obs.receivedAt, tz)}</Row>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Aucune donnée reçue pour l’unité associée.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dernière estimation « estimé GPS »</CardTitle>
            <CardDescription>Kilométrage estimé à partir de la dernière référence manuelle ; jamais présenté comme la valeur du compteur.</CardDescription>
          </CardHeader>
          <CardContent>
            {t.lastEstimate ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Row label="Kilométrage estimé">{formatKm(t.lastEstimate.cumulativeKm, { estimate: true })}</Row>
                <Row label="Observé le">{formatDateTime(t.lastEstimate.observedAt, tz)}</Row>
                <Row label="Référence manuelle">
                  {t.lastEstimate.referenceAt ? `du ${formatDateTime(t.lastEstimate.referenceAt, tz)}` : '—'}
                  {t.lastEstimate.referenceKm !== null ? ` (${formatKm(t.lastEstimate.referenceKm)})` : ''}
                </Row>
                {t.lastEstimate.label ? <Row label="Libellé">{t.lastEstimate.label}</Row> : null}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{m?.odometerKind === 'DISTANCE_GPS' ? 'Aucune estimation : un relevé manuel accepté est nécessaire comme référence de calibrage.' : 'Sans objet : le véhicule n’est pas associé en distance GPS.'}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calibrage et dérive</CardTitle>
            <CardDescription>Écart entre l’estimation GPS et le relevé manuel, en pourcentage de la distance parcourue depuis la référence précédente.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {t.lastCalibration ? <CalibrationBlock title="Dernier calibrage" calibration={t.lastCalibration} timezone={tz} /> : <p className="text-sm text-muted-foreground">Aucun calibrage enregistré.</p>}
            {t.lastDrift && t.lastDrift.id !== t.lastCalibration?.id ? <CalibrationBlock title="Dernière dérive mesurée" calibration={t.lastDrift} timezone={tz} /> : null}
          </CardContent>
        </Card>
      </div>

      {t.telemetryEnabled || (m && m.fuelKinds.length > 0) ? <FuelThresholdsCard vehicleId={vehicleId} /> : null}
    </div>
  );
}

function CalibrationBlock({ title, calibration: c, timezone }: { title: string; calibration: VehicleCalibrationView; timezone: string }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {title} <StatusBadge label={CALIBRATION_STATUS_LABELS[c.status]} tone={c.status === 'CALIBRE' ? 'success' : 'warning'} />
        {c.driftAlertRaised ? <StatusBadge label="Alerte dérive GPS" tone="danger" /> : null}
      </p>
      <p>
        Référence manuelle du {formatDateTime(c.referenceAt, timezone)} : {formatKm(c.referenceKm)}.
      </p>
      {c.deviationPercentLabel !== null ? (
        <p>
          Dérive de {c.deviationPercentLabel} % : estimation {formatKm(c.estimatedKmAtReference, { estimate: true })} pour un relevé manuel de {formatKm(c.referenceKm)}, sur {formatKm(c.distanceSincePreviousKm)} parcourus depuis la
          référence précédente.
        </p>
      ) : c.status === 'CALIBRE' ? (
        <p className="text-muted-foreground">
          Aucune dérive mesurée pour cette référence : pas de référence précédente calibrée pour la même association et le même compteur, ou distance parcourue depuis celle-ci inférieure au minimum paramétré.
        </p>
      ) : null}
      {c.statusReason ? <p className="text-muted-foreground">{c.statusReason}</p> : null}
    </div>
  );
}
