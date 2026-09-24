'use client';

import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS, INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
import { IncidentComments } from '@/components/incidents/incident-comments';
import { ApiErrorAlert, Field } from '@/components/incidents/ops-display';
import { toneForIncidentStatus, toneForSeverity, useOpsRights } from '@/components/incidents/ops-helpers';
import { PhotoUploader, type UploadedPhoto } from '@/components/incidents/photo-uploader';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { ImmobilizationView } from '@/lib/immobilizations-types';
import type { IncidentInterventionRef, IncidentView } from '@/lib/incidents-types';
import { ImmobilizeIncidentDialog, LinkDriverDialog, OpenInterventionDialog } from './action-dialogs';
import { EditIncidentDialog } from './edit-incident-dialog';
import { useIncidentCache } from './incident-cache';
import { TransitionDialog, type TransitionAction, transitionsFor } from './transition-dialog';

type DialogKind = { kind: 'transition'; action: TransitionAction } | { kind: 'edit' } | { kind: 'intervention' } | { kind: 'immobilize' } | { kind: 'link-driver'; driverId: string; driverName: string } | null;

/**
 * Fiche d'un incident (CDC 7.3, D-215 à D-218) : informations, traitement, coût lié (costs.read),
 * contravention (information seulement), photos, commentaires chronologiques et actions selon statut et rôle.
 */
export function IncidentDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const incident = useQuery({ queryKey: ['incident', id], queryFn: () => api<IncidentView>(`/incidents/${id}`) });
  const data = incident.data;
  const rights = useOpsRights(data?.companyId ?? null);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const staff = !session.isDriverOnly;
  const interventions = useQueries({
    queries: (data?.interventionIds ?? []).map((interventionId) => ({
      queryKey: ['intervention', interventionId],
      queryFn: () => api<IncidentInterventionRef>(`/interventions/${interventionId}`),
    })),
  });
  const immobilizations = useQuery({
    queryKey: ['immobilizations', 'vehicle', data?.vehicleId],
    queryFn: () => api<Page<ImmobilizationView>>(`/immobilizations${toQuery({ vehicleId: data?.vehicleId, pageSize: 100 })}`),
    enabled: staff && Boolean(data?.vehicleId),
  });

  if (incident.isPending) return <LoadingState label="Chargement de l’incident…" />;
  if (incident.isError) return <ErrorState error={incident.error} retry={() => void incident.refetch()} />;
  const i = incident.data;
  const closed = i.status === 'CLOTURE';
  const company = session.companies.find((c) => c.id === i.companyId);
  const transitions = transitionsFor(i.status, rights);
  const linkedCauses = (immobilizations.data?.items ?? []).flatMap((imm) => imm.causes.filter((c) => c.incidentId === i.id).map((cause) => ({ imm, cause })));
  const followUpLabel = !i.followUpUserId ? 'Non désigné' : `${i.followUpUserName ?? 'Membre du personnel désigné'}${i.followUpUserId === session.userId ? ' (vous)' : ''}`;
  // Contravention : lien explicite proposé au chef avec le conducteur de l'utilisation à l'instant déclaré (information, D-217).
  const linkableDriver = rights.manager && i.type === 'CONTRAVENTION' && !closed && i.usageAtTimeDriverId && i.usageAtTimeDriverId !== i.driverId ? { driverId: i.usageAtTimeDriverId, driverName: i.usageAtTimeDriverName ?? 'le conducteur' } : null;

  return (
    <div>
      <PageHeader
        title={`Incident ${i.reference}`}
        description={`${INCIDENT_TYPE_LABELS[i.type] ?? i.type} · ${i.vehicleCode} · ${i.vehicleRegistration}${company ? ` · Société ${company.code}` : ''}`}
        actions={
          <>
            {!closed && rights.operational ? (
              <Button variant="outline" onClick={() => setDialog({ kind: 'edit' })}>
                Modifier
              </Button>
            ) : null}
            {transitions.map((action) => (
              <Button key={action.key} variant={action.destructive ? 'outline' : 'default'} onClick={() => setDialog({ kind: 'transition', action })}>
                {action.label}
              </Button>
            ))}
            {!closed && rights.operational ? (
              <Button variant="outline" onClick={() => setDialog({ kind: 'intervention' })}>
                Ouvrir une intervention
              </Button>
            ) : null}
            {!closed && rights.operational && !i.openImmobilizationCauseId ? (
              <Button variant="outline" onClick={() => setDialog({ kind: 'immobilize' })}>
                Immobiliser le véhicule
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={INCIDENT_STATUS_LABELS[i.status] ?? i.status} tone={toneForIncidentStatus(i.status)} />
        <StatusBadge label={`Gravité : ${INCIDENT_SEVERITY_LABELS[i.severity] ?? i.severity}`} tone={toneForSeverity(i.severity)} />
        <StatusBadge label={INCIDENT_TYPE_LABELS[i.type] ?? i.type} tone="neutral" />
        {i.openImmobilizationCauseId ? <StatusBadge label="Véhicule immobilisé pour cet incident" tone="danger" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Informations</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Véhicule">
                {staff ? (
                  <Link href={`/vehicules/${i.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                    {i.vehicleCode} · {i.vehicleRegistration}
                  </Link>
                ) : (
                  `${i.vehicleCode} · ${i.vehicleRegistration}`
                )}
              </Field>
              <Field label="Société">{company ? `${company.code} · ${company.name}` : '—'}</Field>
              <Field label="Date du fait">{formatDateTime(i.occurredAt, session.timezone)}</Field>
              <Field label="Lieu déclaré">{i.siteId ? (i.siteName ? `Site ${i.siteName}` : 'Site de la société') : (i.locationLabel ?? '—')}</Field>
              <Field label="Conducteur lié">
                {i.driverId && staff ? (
                  <Link href={`/conducteurs/${i.driverId}`} className="underline-offset-4 hover:underline">
                    {i.driverName ?? 'Fiche conducteur'}
                  </Link>
                ) : (
                  (i.driverName ?? '—')
                )}
              </Field>
              <Field label="Utilisation concernée">
                {i.usageId && staff ? (
                  <Link href={`/utilisations/${i.usageId}`} className="underline-offset-4 hover:underline">
                    Voir l’utilisation
                  </Link>
                ) : i.usageId ? (
                  'Utilisation rattachée'
                ) : (
                  '—'
                )}
              </Field>
              {staff ? <Field label="Responsable du suivi">{followUpLabel}</Field> : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Traitement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid gap-y-2">
              <Field label="Résolu le">{formatDateTime(i.resolvedAt, session.timezone)}</Field>
              {i.resolutionNote ? <Field label="Note de résolution">{i.resolutionNote}</Field> : null}
              <Field label="Clôturé le">{formatDateTime(i.closedAt, session.timezone)}</Field>
              {i.closureNote ? <Field label="Note de clôture">{i.closureNote}</Field> : null}
            </dl>
            {staff ? (
              <div className="space-y-2">
                <h3 className="font-medium">Interventions issues de l’incident</h3>
                {i.interventionIds.length === 0 ? (
                  <p className="text-muted-foreground">Aucune intervention ouverte depuis cet incident.</p>
                ) : (
                  <ul className="space-y-1">
                    {i.interventionIds.map((interventionId, index) => {
                      const q = interventions[index];
                      return (
                        <li key={interventionId} className="flex flex-wrap items-center gap-2">
                          <Link href={`/interventions/${interventionId}`} className="underline-offset-4 hover:underline">
                            {q?.data ? `Intervention ${q.data.reference}` : 'Intervention'}
                          </Link>
                          {q?.data ? <StatusBadge label={INTERVENTION_STATUS_LABELS[q.data.status as keyof typeof INTERVENTION_STATUS_LABELS] ?? q.data.status} tone="neutral" /> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : null}
            {staff ? (
              <div className="space-y-2">
                <h3 className="font-medium">Immobilisations liées</h3>
                {immobilizations.isError ? (
                  <p className="text-muted-foreground">Immobilisations indisponibles.</p>
                ) : linkedCauses.length === 0 ? (
                  <p className="text-muted-foreground">{immobilizations.isPending ? 'Chargement…' : 'Aucune immobilisation liée à cet incident.'}</p>
                ) : (
                  <ul className="space-y-1">
                    {linkedCauses.map(({ imm, cause }) => (
                      <li key={cause.id}>
                        <Link href={`/immobilisations/${imm.id}`} className="underline-offset-4 hover:underline">
                          Depuis le {formatDateTime(cause.startedAt, session.timezone)}
                        </Link>{' '}
                        <StatusBadge label={cause.endedAt ? `Cause terminée le ${formatDateTime(cause.endedAt, session.timezone)}` : 'Cause en cours'} tone={cause.endedAt ? 'neutral' : 'danger'} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {staff ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Coût lié</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {i.linkedCost !== null ? (
                <>
                  <p className="text-lg font-semibold tabular-nums">{formatMoney(i.linkedCost, session.currency, session.currencyDecimals)}</p>
                  <p className="text-muted-foreground">Dépenses validées rattachées à l’incident et à ses interventions, calculées par le serveur.</p>
                </>
              ) : (
                <p className="text-muted-foreground">Coûts non visibles avec vos habilitations.</p>
              )}
            </CardContent>
          </Card>
        ) : null}

        {staff && i.type === 'CONTRAVENTION' ? (
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">Utilisation en cours à cet instant (information)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {i.usageAtTimeId ? (
                <p>
                  <Link href={`/utilisations/${i.usageAtTimeId}`} className="font-medium underline-offset-4 hover:underline">
                    Utilisation par {i.usageAtTimeDriverName ?? 'un conducteur'}
                  </Link>{' '}
                  en cours à la date du fait déclaré.
                </p>
              ) : (
                <p className="text-muted-foreground">Aucune utilisation n’était enregistrée en cours à l’instant déclaré.</p>
              )}
              <p className="text-muted-foreground">Une contravention reste une information de suivi : aucune responsabilité personnelle ni retenue n’est déduite automatiquement. Le lien avec un conducteur ne se pose que par une action explicite du chef de parc.</p>
              {linkableDriver ? (
                <Button type="button" variant="outline" onClick={() => setDialog({ kind: 'link-driver', driverId: linkableDriver.driverId, driverName: linkableDriver.driverName })}>
                  Lier {linkableDriver.driverName} au dossier
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap break-words">{i.description}</p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Photos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {i.photoAttachmentIds.length === 0 ? <p className="text-sm text-muted-foreground">Aucune photo.</p> : null}
            {i.photoAttachmentIds.length > 0 ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {i.photoAttachmentIds.map((photoId, index) => (
                  <li key={photoId}>
                    <a href={`/api/v1/attachments/${photoId}/download`} target="_blank" rel="noopener noreferrer" className="block rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/v1/attachments/${photoId}/download`} alt={`Photo ${index + 1} de l’incident (ouvrir en grand)`} className="aspect-video w-full rounded-md border object-cover" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {!closed && rights.operational ? <AddPhotos incident={i} /> : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Commentaires</CardTitle>
          </CardHeader>
          <CardContent>
            <IncidentComments incident={i} canComment={session.isDriverOnly || rights.operational} />
          </CardContent>
        </Card>
      </div>

      {dialog?.kind === 'transition' ? <TransitionDialog incident={i} action={dialog.action} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'edit' ? <EditIncidentDialog incident={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'intervention' ? <OpenInterventionDialog incident={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'immobilize' ? <ImmobilizeIncidentDialog incident={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'link-driver' ? <LinkDriverDialog incident={i} driverId={dialog.driverId} driverName={dialog.driverName} onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}

/** Ajout de photos à un incident existant : téléversement puis PATCH photoAttachmentIds (expectedVersion). */
function AddPhotos({ incident }: { incident: IncidentView }) {
  const cache = useIncidentCache(incident.id);
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const save = useMutation({
    mutationFn: () => api<IncidentView>(`/incidents/${incident.id}`, { method: 'PATCH', body: { photoAttachmentIds: photos.map((p) => p.id), expectedVersion: incident.version } }),
    onSuccess: (updated) => {
      setPhotos([]);
      cache.saved(updated, photos.length > 1 ? 'Photos ajoutées.' : 'Photo ajoutée.');
    },
    onError: (error) => {
      cache.failed(error, 'Ajout des photos impossible.');
    },
  });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <PhotoUploader id="incident-add-photos" label="Ajouter des photos" companyId={incident.companyId} photos={photos} onChange={setPhotos} errors={{}} />
      {save.error ? <ApiErrorAlert error={save.error} /> : null}
      {photos.length > 0 ? (
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer les photos sur l’incident'}
        </Button>
      ) : null}
    </div>
  );
}
