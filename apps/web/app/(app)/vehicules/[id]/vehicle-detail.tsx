'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FRESHNESS_LABELS, MEASUREMENT_KIND_LABELS, PLAN_STATUS_LABELS, READING_SOURCE_LABELS, VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope, useRoleIn } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge, toneForFreshness, toneForOperational, toneForPlan } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import type { VehicleSynthesis } from '@/lib/vehicles-types';
import { AssignmentsPanel } from './assignments-panel';
import { ConsumptionPanel } from './consumption-panel';
import { VehicleDocumentsPanel } from './documents-panel';
import { LifecycleDialog } from './lifecycle-dialog';
import { LocationPanel } from './location-panel';
import { MaintenancePanel } from './maintenance-panel';
import { OdometerPanel } from './odometer-panel';
import { PhotosPanel } from './photos-panel';
import { QrPanel } from './qr-panel';
import { ReservationsPanel } from './reservations-panel';
import { TransferDialog } from './transfer-dialog';

/** Onglets atteignables par lien (?onglet=…, liens d'alerte) ; les onglets de gestion sont refusés au conducteur. */
const STAFF_TABS = new Set(['synthese', 'localisation', 'kilometrage', 'photos', 'affectations', 'reservations', 'entretien', 'documents', 'carburant']);
const DRIVER_TABS = new Set(['synthese', 'localisation']);

function initialTab(requested: string | null, driverOnly: boolean): string {
  return requested && (driverOnly ? DRIVER_TABS : STAFF_TABS).has(requested) ? requested : 'synthese';
}

export function VehicleDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const synthesis = useQuery({ queryKey: ['vehicle', id, 'synthesis'], queryFn: () => api<VehicleSynthesis>(`/vehicles/${id}/synthesis`) });
  const role = useRoleIn(synthesis.data?.companyId ?? null);
  const isManager = session.isAdmin || role === 'CHEF_PARC';
  const isOperational = isManager || role === 'OPERATEUR';
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const lifecycle = useMutation({
    mutationFn: (input: { lifecycleStatus: string; reason: string }) =>
      api(`/vehicles/${id}/lifecycle`, { method: 'POST', body: { ...input, expectedVersion: synthesis.data?.version } }),
    onSuccess: () => {
      toast.success('Statut mis à jour.');
      setLifecycleOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['vehicle', id] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Échec de la mise à jour.'),
  });

  if (synthesis.isPending) return <LoadingState label="Chargement du dossier…" />;
  if (synthesis.isError) return <ErrorState error={synthesis.error} retry={() => void synthesis.refetch()} />;
  const v = synthesis.data;
  const odo = v.odometer;

  return (
    <div>
      <PageHeader
        title={`${v.code} · ${v.registration}`}
        description={`${v.make} ${v.model} · ${v.categoryLabel} · Société ${v.companyCode}`}
        actions={
          <>
            {isOperational && v.lifecycleStatus !== 'ARCHIVE' && v.lifecycleStatus !== 'CEDE' ? (
              <Button variant="outline" asChild>
                <Link href={`/vehicules/${id}/modifier`}>Modifier</Link>
              </Button>
            ) : null}
            {isManager && v.lifecycleStatus !== 'ARCHIVE' ? (
              <Button variant="outline" onClick={() => setLifecycleOpen(true)}>
                Changer le cycle de vie
              </Button>
            ) : null}
            {session.isAdmin && v.lifecycleStatus !== 'ARCHIVE' && v.lifecycleStatus !== 'CEDE' ? (
              <Button variant="outline" onClick={() => setTransferOpen(true)}>
                Transférer
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={VEHICLE_LIFECYCLE_LABELS[v.lifecycleStatus]} tone={v.lifecycleStatus === 'ACTIF' ? 'success' : 'neutral'} />
        {v.operationalStatus ? <StatusBadge label={VEHICLE_OPERATIONAL_STATUS_LABELS[v.operationalStatus]} tone={toneForOperational(v.operationalStatus)} /> : null}
        <StatusBadge label={`Kilométrage : ${FRESHNESS_LABELS[v.freshness]}`} tone={toneForFreshness(v.freshness)} />
        {v.documentCompliance && v.documentCompliance.blocking > 0 ? <StatusBadge label={`${v.documentCompliance.blocking} document(s) bloquant(s)`} tone="danger" /> : null}
        {v.currentUsage && v.lifecycleStatus !== 'ACTIF' ? <StatusBadge label="Utilisation ouverte malgré le statut" tone="warning" /> : null}
      </div>

      <Tabs defaultValue={initialTab(searchParams.get('onglet'), session.isDriverOnly)}>
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          <TabsTrigger value="synthese">Synthèse</TabsTrigger>
          <TabsTrigger value="localisation">Localisation</TabsTrigger>
          {session.isDriverOnly ? null : <TabsTrigger value="kilometrage">Kilométrage</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="photos">Photos et QR</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="affectations">Affectations</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="reservations">Réservations</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="entretien">Entretien</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="documents">Documents</TabsTrigger>}
          {session.isDriverOnly ? null : <TabsTrigger value="carburant">Carburant</TabsTrigger>}
        </TabsList>

        <TabsContent value="synthese">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Responsable habituel</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {v.responsible ? (
                  <p>
                    <Link href={`/conducteurs/${v.responsible.driverId}`} className="font-medium underline-offset-4 hover:underline">
                      {v.responsible.driverName}
                    </Link>
                    <span className="block text-muted-foreground">depuis le {formatDate(v.responsible.since, session.timezone)}</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">Aucun responsable habituel enregistré.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Utilisateur actuel</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {v.currentUsage ? (
                  <p>
                    <span className="font-medium">{v.currentUsage.driverName}</span>
                    <span className="block text-muted-foreground">remise le {formatDateTime(v.currentUsage.checkedOutAt, session.timezone)}</span>
                    <span className="block text-muted-foreground">retour prévu le {formatDateTime(v.currentUsage.expectedReturnAt, session.timezone)}</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">Aucune utilisation en cours.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dernière localisation déclarée</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {v.lastLocation ? (
                  <p>
                    <span className="font-medium">{v.lastLocation.siteName ?? v.lastLocation.placeLabel}</span>
                    <span className="block text-muted-foreground">
                      observée le {formatDateTime(v.lastLocation.observedAt, session.timezone)}
                      {v.lastLocation.createdByName ? ` par ${v.lastLocation.createdByName}` : ''}
                    </span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">Aucune localisation déclarée.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dernier relevé validé</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {odo ? (
                  <div className="space-y-1">
                    <p className="text-lg font-semibold">{formatKm(odo.isEstimate ? odo.cumulativeKm : odo.physicalKm, { estimate: odo.isEstimate })}</p>
                    {odo.cumulativeKm && !odo.isEstimate && odo.cumulativeKm !== odo.physicalKm ? <p className="text-muted-foreground">Cumul véhicule : {formatKm(odo.cumulativeKm)}</p> : null}
                    {!odo.cumulativeKnown ? <p className="text-warning-foreground">Cumul incomplet : historique antérieur inconnu.</p> : null}
                    <p className="text-muted-foreground">
                      {READING_SOURCE_LABELS[odo.source as keyof typeof READING_SOURCE_LABELS]} · {MEASUREMENT_KIND_LABELS[odo.measurementKind as keyof typeof MEASUREMENT_KIND_LABELS]} · observé le {formatDateTime(odo.observedAt, session.timezone)}
                    </p>
                    <StatusBadge label={`${FRESHNESS_LABELS[v.freshness]}${odo.ageDays !== null ? ` (${odo.ageDays} j)` : ''}`} tone={toneForFreshness(v.freshness)} />
                  </div>
                ) : (
                  <p className="text-muted-foreground">Kilométrage inconnu : aucun relevé accepté.</p>
                )}
                {v.pendingReadings !== null && v.pendingReadings > 0 ? <p className="mt-2 text-warning-foreground">{v.pendingReadings} relevé(s) en attente de validation.</p> : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Prochaines échéances</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {v.upcomingMaintenance.length === 0 ? (
                  <p className="text-muted-foreground">Aucun plan d’entretien actif.</p>
                ) : (
                  <ul className="space-y-2">
                    {v.upcomingMaintenance.map((m) => (
                      <li key={m.planId} className="flex items-center justify-between gap-2">
                        <span>{m.maintenanceTypeLabel}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          {m.nextDueKm ? formatKm(m.nextDueKm) : null}
                          {m.nextDueDate ? formatDate(m.nextDueDate) : null}
                          <StatusBadge label={PLAN_STATUS_LABELS[m.status as keyof typeof PLAN_STATUS_LABELS]} tone={toneForPlan(m.status)} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            {v.documentCompliance ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Conformité et suivi</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p>Documents manquants : {v.documentCompliance.missing}</p>
                  <p>Documents expirés : {v.documentCompliance.expired}</p>
                  <p>Documents à renouveler : {v.documentCompliance.expiringSoon}</p>
                  {v.openIncidents !== null ? <p>Incidents ouverts : {v.openIncidents}</p> : null}
                </CardContent>
              </Card>
            ) : null}
            <Card className="md:col-span-2 xl:col-span-3">
              <CardHeader>
                <CardTitle className="text-base">Fiche</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="VIN" value={v.vin} />
                  <Field label="Année" value={v.year?.toString() ?? null} />
                  <Field label="Mise en service" value={v.commissioningDate ? formatDate(v.commissioningDate) : null} />
                  <Field label="Énergie" value={v.energy} />
                  <Field label="Réservoir" value={v.tankCapacityLiters ? `${Number(v.tankCapacityLiters)} L` : null} />
                  <Field label="Détention" value={v.ownershipMode} />
                  <Field label="Fin de contrat" value={v.contractEndDate ? formatDate(v.contractEndDate) : null} />
                  <Field label="Créé le" value={formatDate(v.createdAt, session.timezone)} />
                  <div className="sm:col-span-2 lg:col-span-3">
                    <dt className="text-muted-foreground">Notes</dt>
                    <dd className="whitespace-pre-wrap">{v.notes ?? '—'}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="localisation">
          <LocationPanel vehicleId={id} companyId={v.companyId} canDeclare={isOperational} />
        </TabsContent>

        {session.isDriverOnly ? null : (
          <TabsContent value="kilometrage">
            <OdometerPanel vehicleId={id} companyId={v.companyId} canEnter={isOperational} />
          </TabsContent>
        )}

        {session.isDriverOnly || v.qrToken === null ? null : (
          <TabsContent value="photos">
            <div className="grid gap-4 md:grid-cols-2">
              <PhotosPanel vehicleId={id} companyId={v.companyId} photoIds={v.photoAttachmentIds} canEdit={isOperational} />
              <QrPanel vehicleId={id} qrToken={v.qrToken} canRegenerate={isManager} />
            </div>
          </TabsContent>
        )}

        {session.isDriverOnly ? null : (
          <TabsContent value="affectations">
            <AssignmentsPanel vehicleId={id} companyId={v.companyId} canManage={isOperational || role === 'ADMIN'} />
          </TabsContent>
        )}

        {session.isDriverOnly ? null : (
          <TabsContent value="reservations">
            <ReservationsPanel vehicleId={id} />
          </TabsContent>
        )}

        {session.isDriverOnly ? null : (
          <TabsContent value="entretien">
            <MaintenancePanel vehicleId={id} companyId={v.companyId} />
          </TabsContent>
        )}

        {session.isDriverOnly ? null : (
          <TabsContent value="documents">
            <VehicleDocumentsPanel vehicleId={id} companyId={v.companyId} />
          </TabsContent>
        )}

        {session.isDriverOnly ? null : (
          <TabsContent value="carburant">
            <ConsumptionPanel vehicleId={id} companyId={v.companyId} />
          </TabsContent>
        )}
      </Tabs>

      <LifecycleDialog open={lifecycleOpen} onOpenChange={setLifecycleOpen} current={v.lifecycleStatus} pending={lifecycle.isPending} onSubmit={(input) => lifecycle.mutate(input)} />
      {transferOpen ? <TransferDialog vehicleId={id} onClose={() => setTransferOpen(false)} /> : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}
