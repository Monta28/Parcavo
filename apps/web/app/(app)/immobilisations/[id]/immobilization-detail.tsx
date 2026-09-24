'use client';

import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Field } from '@/components/incidents/ops-display';
import { formatDays, formatHours, toneForImmobilization, useOpsRights } from '@/components/incidents/ops-helpers';
import { placeLabel } from '@/components/incidents/place-fields';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { IMMOBILIZATION_CAUSE_KIND_LABELS, IMMOBILIZATION_STATUS_LABELS, type ImmobilizationCauseView, type ImmobilizationView } from '@/lib/immobilizations-types';
import { AddCauseDialog, EditImmobilizationDialog, EndDialog } from './immobilization-dialogs';

type DialogKind = { kind: 'add-cause' } | { kind: 'edit' } | { kind: 'end'; cause: ImmobilizationCauseView | null } | null;

function CauseSource({ cause }: { cause: ImmobilizationCauseView }) {
  if (cause.incidentId) {
    return (
      <Link href={`/incidents/${cause.incidentId}`} className="underline-offset-4 hover:underline">
        Incident {cause.incidentReference ?? ''}
      </Link>
    );
  }
  if (cause.interventionId) {
    return (
      <Link href={`/interventions/${cause.interventionId}`} className="underline-offset-4 hover:underline">
        Intervention {cause.interventionReference ?? ''}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Fiche d'une immobilisation (CDC 7.4, D-219, D-220) : causes et sources, durées calculées par l'API
 * (total = union des causes, durée propre de chaque cause, en heures et en jours), utilisation ouverte
 * pendant l'immobilisation, et actions (ajout ou fin de cause, fin, modification).
 */
export function ImmobilizationDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const immobilization = useQuery({ queryKey: ['immobilization', id], queryFn: () => api<ImmobilizationView>(`/immobilizations/${id}`) });
  const rights = useOpsRights(immobilization.data?.companyId ?? null);
  const [dialog, setDialog] = useState<DialogKind>(null);

  if (immobilization.isPending) return <LoadingState label="Chargement de l’immobilisation…" />;
  if (immobilization.isError) return <ErrorState error={immobilization.error} retry={() => void immobilization.refetch()} />;
  const imm = immobilization.data;
  const active = imm.status === 'ACTIVE';
  const canAct = active && rights.operational;
  const company = session.companies.find((c) => c.id === imm.companyId);
  const openCount = imm.causes.filter((c) => !c.endedAt).length;

  return (
    <div>
      <PageHeader
        title={`Immobilisation ${imm.vehicleCode}`}
        description={`${imm.vehicleRegistration}${company ? ` · Société ${company.code}` : ''} · depuis le ${formatDateTime(imm.startedAt, session.timezone)}`}
        actions={
          canAct ? (
            <>
              <Button variant="outline" onClick={() => setDialog({ kind: 'edit' })}>
                Modifier fin prévue / lieu
              </Button>
              <Button variant="outline" onClick={() => setDialog({ kind: 'add-cause' })}>
                Ajouter une cause
              </Button>
              <Button onClick={() => setDialog({ kind: 'end', cause: null })}>Fin d’immobilisation</Button>
            </>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={IMMOBILIZATION_STATUS_LABELS[imm.status] ?? imm.status} tone={toneForImmobilization(imm.status)} />
        {active ? <StatusBadge label={`${openCount} cause${openCount > 1 ? 's' : ''} ouverte${openCount > 1 ? 's' : ''}`} tone="warning" /> : null}
      </div>

      {active ? (
        <Alert className="mb-4" role="note">
          <Info aria-hidden="true" />
          <AlertTitle>Véhicule indisponible</AlertTitle>
          <AlertDescription>La disponibilité est rétablie seulement après la fin de toutes les causes.</AlertDescription>
        </Alert>
      ) : null}
      {imm.openUsageId ? (
        <Alert variant="destructive" className="mb-4">
          <Info aria-hidden="true" />
          <AlertTitle>Utilisation en cours pendant l’immobilisation</AlertTitle>
          <AlertDescription>
            <p>
              L’utilisation est conservée et sa restitution reste possible.{' '}
              <Link href={`/utilisations/${imm.openUsageId}`} className="font-medium underline underline-offset-4">
                Ouvrir l’utilisation
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Informations</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Véhicule">
                <Link href={`/vehicules/${imm.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                  {imm.vehicleCode} · {imm.vehicleRegistration}
                </Link>
              </Field>
              <Field label="Société">{company ? `${company.code} · ${company.name}` : '—'}</Field>
              <Field label="Lieu">{placeLabel(imm)}</Field>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Période</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Début">{formatDateTime(imm.startedAt, session.timezone)}</Field>
              <Field label="Fin prévue">{formatDateTime(imm.expectedEndAt, session.timezone)}</Field>
              <Field label="Fin réelle">{active ? 'En cours' : formatDateTime(imm.endedAt, session.timezone)}</Field>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Durée</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="text-lg font-semibold tabular-nums">
              {formatHours(imm.durationHours)} <span className="text-base font-normal text-muted-foreground">· {formatDays(imm.durationDays)}</span>
            </p>
            <p className="text-muted-foreground">{active ? 'En cours : durée jusqu’à maintenant.' : 'Durée totale.'} Union des périodes des causes : une superposition n’est comptée qu’une fois.</p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Causes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p id="cause-durations-note" className="text-sm text-muted-foreground">
              Durée propre de chaque cause{active ? ' (jusqu’à maintenant pour une cause ouverte)' : ''}. {imm.causeDurationsNote}
            </p>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Motif</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Début</TableHead>
                    <TableHead>Fin</TableHead>
                    <TableHead aria-describedby="cause-durations-note">Durée propre</TableHead>
                    <TableHead>Motif de fin</TableHead>
                    {canAct ? <TableHead className="text-right">Action</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imm.causes.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{IMMOBILIZATION_CAUSE_KIND_LABELS[c.kind] ?? c.kind}</TableCell>
                      <TableCell className="max-w-72 whitespace-normal break-words">{c.reason}</TableCell>
                      <TableCell>
                        <CauseSource cause={c} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(c.startedAt, session.timezone)}</TableCell>
                      <TableCell className="whitespace-nowrap">{c.endedAt ? formatDateTime(c.endedAt, session.timezone) : <StatusBadge label="Ouverte" tone="danger" />}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatHours(c.durationHours)} · {formatDays(c.durationDays)}
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal break-words">{c.endReason ?? '—'}</TableCell>
                      {canAct ? (
                        <TableCell className="text-right">
                          {c.endedAt ? null : (
                            <Button type="button" size="sm" variant="outline" onClick={() => setDialog({ kind: 'end', cause: c })}>
                              Terminer la cause
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {dialog?.kind === 'add-cause' ? <AddCauseDialog immobilization={imm} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'edit' ? <EditImmobilizationDialog immobilization={imm} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog?.kind === 'end' ? <EndDialog immobilization={imm} cause={dialog.cause} onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}
