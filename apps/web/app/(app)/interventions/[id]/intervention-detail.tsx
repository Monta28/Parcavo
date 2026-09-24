'use client';

import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  INTERVENTION_STATUS_LABELS,
  MEASUREMENT_KIND_LABELS,
  READING_SOURCE_LABELS,
  READING_STATUS_LABELS,
} from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDate, formatDateTime, formatKm, formatMoney } from '@/lib/format';
import {
  COST_LINE_KIND_LABELS,
  IMMOBILIZATION_STATUS_LABELS,
  INTERVENTION_ATTACHMENT_KIND_LABELS,
  INTERVENTION_COST_STATUS_LABELS,
  INTERVENTION_KIND_LABELS,
  type ExecutionReadingView,
  type ImmobilizationSummary,
  type IncidentSummary,
  type InterventionTaskView,
  type InterventionView,
} from '@/lib/interventions-types';
import { plannedRange } from '../form-parts';
import { toneForCostStatus, toneForInterventionStatus, useInterventionRights } from '../intervention-helpers';
import { CancelDialog, PlanDialog, ReopenDialog, StartDialog } from './action-dialogs';
import { CompleteForm } from './complete-form';
import { CostDialog } from './cost-dialog';

type DialogKind = 'plan' | 'start' | 'cancel' | 'reopen' | 'cost' | null;

function taskOrigin(t: InterventionTaskView): string {
  if (t.planId) return `Plan du véhicule : ${t.maintenanceTypeLabel ?? t.label}`;
  if (t.maintenanceTypeId) return `Opération du catalogue : ${t.maintenanceTypeLabel ?? t.label}`;
  return 'Libellé libre';
}

function formatQuantity(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(n) : value;
}

/** Taille d'un fichier lisible (octets fournis par l'API). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const format = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  return bytes < 1024 * 1024 ? `${format.format(bytes / 1024)} Ko` : `${format.format(bytes / (1024 * 1024))} Mo`;
}

function fileTypeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/jpeg') return 'JPEG';
  if (mimeType === 'image/png') return 'PNG';
  return mimeType;
}

/** Relevé d'exécution fourni par la fiche (kilomètres déjà tronqués par l'API). */
function ExecutionReading({ reading, timezone }: { reading: ExecutionReadingView; timezone: string }) {
  return (
    <>
      {formatKm(reading.physicalKm)} lu le {formatDateTime(reading.observedAt, timezone)}
      <span className="block text-xs text-muted-foreground">
        {READING_SOURCE_LABELS[reading.source] ?? reading.source} · {MEASUREMENT_KIND_LABELS[reading.measurementKind] ?? reading.measurementKind} · {READING_STATUS_LABELS[reading.status] ?? reading.status}
      </span>
      {reading.status !== 'ACCEPTE' ? (
        <span className="block text-xs text-muted-foreground">Ce relevé n’est plus accepté depuis la clôture (correction ou remplacement) : consultez l’historique du compteur du véhicule.</span>
      ) : null}
    </>
  );
}

/** Fiche d'une intervention (CDC 6.3, 6.4, 10.2) : travaux, relevé d'exécution, coûts, pièces jointes, liens et actions selon statut et rôle. */
export function InterventionDetail({ id }: { id: string }) {
  const { session } = useAppScope();
  const intervention = useQuery({ queryKey: ['intervention', id], queryFn: () => api<InterventionView>(`/interventions/${id}`) });
  const data = intervention.data;
  const rights = useInterventionRights(data?.companyId ?? null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Nouvelle instance du formulaire de clôture (et nouvelle clé d'idempotence) à chaque ouverture.
  const [completeKey, setCompleteKey] = useState(0);

  const incident = useQuery({
    queryKey: ['incident', data?.incidentId],
    queryFn: () => api<IncidentSummary>(`/incidents/${data?.incidentId}`),
    enabled: Boolean(data?.incidentId),
  });
  const immobilizations = useQuery({
    queryKey: ['immobilizations', 'vehicle', data?.vehicleId],
    queryFn: () => api<Page<ImmobilizationSummary>>(`/immobilizations${toQuery({ vehicleId: data?.vehicleId, pageSize: 100 })}`),
    enabled: Boolean(data?.vehicleId),
  });

  if (intervention.isPending) return <LoadingState label="Chargement de l’intervention…" />;
  if (intervention.isError) return <ErrorState error={intervention.error} retry={() => void intervention.refetch()} />;
  const i = intervention.data;
  const isOpen = i.status === 'BROUILLON' || i.status === 'PLANIFIEE' || i.status === 'EN_COURS';
  const notStarted = i.status === 'BROUILLON' || i.status === 'PLANIFIEE';
  const canComplete = isOpen && rights.can('maintenance.complete');
  const canReadCosts = rights.can('costs.read');
  const company = session.companies.find((c) => c.id === i.companyId);
  const linkedCauses = (immobilizations.data?.items ?? []).flatMap((imm) => imm.causes.filter((c) => c.interventionId === i.id).map((cause) => ({ imm, cause })));

  const openComplete = () => {
    setCompleteKey((k) => k + 1);
    setCompleteOpen(true);
  };

  return (
    <div>
      <PageHeader
        title={`Intervention ${i.reference}`}
        description={`${INTERVENTION_KIND_LABELS[i.kind] ?? i.kind} · ${i.vehicleCode} · ${i.vehicleRegistration}${company ? ` · Société ${company.code}` : ''}`}
        actions={
          <>
            {isOpen && rights.operational ? (
              <Button variant="outline" asChild>
                <Link href={`/interventions/${i.id}/modifier`}>Modifier</Link>
              </Button>
            ) : null}
            {notStarted && rights.operational ? (
              <Button variant="outline" onClick={() => setDialog('plan')}>
                {i.status === 'PLANIFIEE' ? 'Replanifier' : 'Planifier'}
              </Button>
            ) : null}
            {notStarted && rights.operational ? (
              <Button variant="outline" onClick={() => setDialog('start')}>
                Démarrer
              </Button>
            ) : null}
            {canComplete ? (
              <Button onClick={openComplete} disabled={completeOpen} aria-controls="cloture">
                Terminer
              </Button>
            ) : null}
            {i.status === 'TERMINEE' && i.costStatus === 'A_SAISIR' && rights.can('costs.write') ? <Button onClick={() => setDialog('cost')}>Saisir le coût</Button> : null}
            {isOpen && rights.operational ? (
              <Button variant="outline" onClick={() => setDialog('cancel')}>
                Annuler l’intervention
              </Button>
            ) : null}
            {i.status === 'TERMINEE' && rights.manager && rights.can('maintenance.complete') ? (
              <Button variant="outline" onClick={() => setDialog('reopen')}>
                Rouvrir
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge label={INTERVENTION_STATUS_LABELS[i.status] ?? i.status} tone={toneForInterventionStatus(i.status)} />
        <StatusBadge label={INTERVENTION_KIND_LABELS[i.kind] ?? i.kind} tone="neutral" />
        {i.status === 'TERMINEE' ? <StatusBadge label={INTERVENTION_COST_STATUS_LABELS[i.costStatus] ?? i.costStatus} tone={toneForCostStatus(i.costStatus)} /> : null}
        {i.isHistorical ? <StatusBadge label="Opération historique saisie a posteriori" tone="info" /> : null}
        {i.openImmobilizationCauseId ? <StatusBadge label="Véhicule immobilisé pour cette intervention" tone="danger" /> : null}
        {i.reopenReason && i.status !== 'TERMINEE' ? <StatusBadge label="Rouverte" tone="warning" /> : null}
      </div>

      {notStarted ? (
        <Alert className="mb-4" role="note">
          <Info aria-hidden="true" />
          <AlertTitle>Planifier ne signifie pas exécuter</AlertTitle>
          <AlertDescription>
            <p>
              {i.status === 'PLANIFIEE' ? 'Cette intervention est seulement planifiée' : 'Cette intervention est un brouillon'} : aucun travail n’est enregistré comme réalisé et aucun plan d’entretien n’est mis à jour avant sa clôture (« Terminer »), avec la date effective et, pour un plan en kilomètres, un relevé validé.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {completeOpen && isOpen && canComplete ? (
        <div className="mb-6">
          <CompleteForm key={completeKey} intervention={i} onClose={() => setCompleteOpen(false)} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Informations</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Véhicule">
                <Link href={`/vehicules/${i.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                  {i.vehicleCode} · {i.vehicleRegistration}
                </Link>
              </Field>
              <Field label="Société historique">{company ? `${company.code} · ${company.name}` : '—'}</Field>
              <Field label="Garage / fournisseur">{i.supplierName ?? '—'}</Field>
              <Field label="Dates prévues">{plannedRange(i.plannedStartAt, i.plannedEndAt, session.timezone)}</Field>
              <Field label="Début réel">{formatDateTime(i.startedAt, session.timezone)}</Field>
              <Field label="Clôturée le">{formatDateTime(i.completedAt, session.timezone)}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Réalisation et relevé d’exécution</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-y-2 text-sm">
              <Field label="Date effective">{i.performedOn ? formatDate(i.performedOn) : 'Non réalisée'}</Field>
              <Field label="Relevé d’exécution">{i.executionReading ? <ExecutionReading reading={i.executionReading} timezone={session.timezone} /> : 'Aucun relevé rattaché'}</Field>
              <Field label="Kilométrage cumulé au relevé">{i.performedKm ? formatKm(i.performedKm) : '—'}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coût</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {i.status === 'TERMINEE' ? (
              <p>
                <StatusBadge label={INTERVENTION_COST_STATUS_LABELS[i.costStatus] ?? i.costStatus} tone={toneForCostStatus(i.costStatus)} />
              </p>
            ) : (
              <p className="text-muted-foreground">
                Le coût est saisi à la clôture, ou plus tard si la facture n’est pas encore reçue.
                {i.reopenReason ? ' La réouverture a annulé la dépense liée ainsi que ses lignes et son total (valeurs conservées dans l’audit) : ressaisissez le coût à la nouvelle clôture.' : ''}
              </p>
            )}
            {canReadCosts ? (
              <>
                <p className="text-lg font-semibold tabular-nums">{i.totalAmount !== null ? formatMoney(i.totalAmount, session.currency, session.currencyDecimals) : '—'}</p>
                <p className="text-muted-foreground">{i.expenseId ? 'Dépense liée enregistrée (entretien / réparation).' : 'Aucune dépense liée.'}</p>
              </>
            ) : (
              <p className="text-muted-foreground">Coûts non visibles avec vos habilitations.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Diagnostic et travaux</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm md:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Diagnostic</dt>
                <dd className="whitespace-pre-wrap">{i.diagnosis ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Travaux</dt>
                <dd className="whitespace-pre-wrap">{i.workDescription ?? '—'}</dd>
              </div>
              {i.cancelReason ? (
                <div>
                  <dt className="text-muted-foreground">Motif d’annulation</dt>
                  <dd className="whitespace-pre-wrap">{i.cancelReason}</dd>
                </div>
              ) : null}
              {i.reopenReason ? (
                <div>
                  <dt className="text-muted-foreground">Motif de la dernière réouverture</dt>
                  <dd className="whitespace-pre-wrap">{i.reopenReason}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Lignes de travail</CardTitle>
          </CardHeader>
          <CardContent>
            {i.tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune ligne de travail{isOpen ? ' : ajoutez-en via « Modifier » avant la clôture.' : '.'}</p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Libellé</TableHead>
                      <TableHead>Rattachement</TableHead>
                      <TableHead>Réalisation</TableHead>
                      <TableHead className="hidden md:table-cell">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {i.tasks.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-normal font-medium">{t.label}</TableCell>
                        <TableCell className="whitespace-normal">{taskOrigin(t)}</TableCell>
                        <TableCell>
                          {i.status === 'TERMINEE' ? <StatusBadge label={t.completed ? 'Réalisée' : 'Non réalisée'} tone={t.completed ? 'success' : 'neutral'} /> : <span className="text-muted-foreground">À réaliser</span>}
                        </TableCell>
                        <TableCell className="hidden whitespace-normal md:table-cell">{t.notes ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Lignes pièces et main-d’œuvre</CardTitle>
          </CardHeader>
          <CardContent>
            {!canReadCosts ? (
              <p className="text-sm text-muted-foreground">Coûts non visibles avec vos habilitations.</p>
            ) : i.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune ligne de coût{i.totalAmount !== null ? ' : total saisi sans détail.' : '.'}</p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nature</TableHead>
                      <TableHead>Libellé</TableHead>
                      <TableHead className="hidden md:table-cell">Ligne de travail</TableHead>
                      <TableHead className="text-right">Quantité</TableHead>
                      <TableHead className="text-right">Prix unitaire TTC</TableHead>
                      <TableHead className="text-right">Montant TTC</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {i.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{COST_LINE_KIND_LABELS[l.kind] ?? l.kind}</TableCell>
                        <TableCell className="whitespace-normal">{l.label}</TableCell>
                        <TableCell className="hidden whitespace-normal md:table-cell">{i.tasks.find((t) => t.id === l.taskId)?.label ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(l.unitPrice, session.currency, session.currencyDecimals)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(l.amount, session.currency, session.currencyDecimals)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={5} className="text-right">
                        Total TTC
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(i.totalAmount, session.currency, session.currencyDecimals)}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pièces jointes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {i.attachments.length === 0 ? (
              <p className="text-muted-foreground">Aucune pièce jointe. Les fichiers (factures, bons, photos) s’ajoutent à la clôture.</p>
            ) : (
              <ul className="space-y-2">
                {i.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={a.downloadPath} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline underline-offset-4">
                      {a.originalName}
                      <span className="sr-only"> (téléchargement privé, nouvel onglet)</span>
                    </a>
                    <span className="block text-xs text-muted-foreground">
                      {INTERVENTION_ATTACHMENT_KIND_LABELS[a.kind] ?? a.kind} · {fileTypeLabel(a.mimeType)} · {formatFileSize(a.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Immobilisation liée</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {immobilizations.isPending ? (
              <p role="status" className="text-muted-foreground">
                Chargement…
              </p>
            ) : immobilizations.isError ? (
              <p role="alert" className="text-destructive">
                {isApiError(immobilizations.error) ? immobilizations.error.message : 'Immobilisations indisponibles.'}
              </p>
            ) : linkedCauses.length === 0 ? (
              <p className="text-muted-foreground">Aucune immobilisation liée. Elle se déclare explicitement au démarrage (« Immobiliser le véhicule »).</p>
            ) : (
              <ul className="space-y-3">
                {linkedCauses.map(({ imm, cause }) => (
                  <li key={cause.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge label={cause.endedAt ? 'Cause terminée' : 'Cause ouverte'} tone={cause.endedAt ? 'neutral' : 'danger'} />
                      <StatusBadge label={`Immobilisation ${IMMOBILIZATION_STATUS_LABELS[imm.status]?.toLowerCase() ?? imm.status}`} tone={imm.status === 'ACTIVE' ? 'warning' : 'neutral'} />
                    </div>
                    <p>{cause.reason}</p>
                    <p className="text-muted-foreground">
                      depuis le {formatDateTime(cause.startedAt, session.timezone)}
                      {cause.endedAt ? ` · jusqu’au ${formatDateTime(cause.endedAt, session.timezone)}` : ''}
                    </p>
                    {cause.endReason ? <p className="text-muted-foreground">Fin : {cause.endReason}</p> : null}
                    {imm.garageName || imm.siteName || imm.locationLabel ? <p className="text-muted-foreground">Lieu : {imm.garageName ?? imm.siteName ?? imm.locationLabel}</p> : null}
                    <p>
                      <Link href={`/immobilisations/${imm.id}`} className="underline-offset-4 hover:underline">
                        Voir l’immobilisation
                      </Link>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Incident source</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!i.incidentId ? (
              <p className="text-muted-foreground">Intervention non issue d’un incident.</p>
            ) : incident.isPending ? (
              <p role="status" className="text-muted-foreground">
                Chargement…
              </p>
            ) : incident.isError ? (
              <p role="alert" className="text-destructive">
                {isApiError(incident.error) ? incident.error.message : 'Incident indisponible.'}
              </p>
            ) : (
              <>
                <p>
                  <Link href={`/incidents/${incident.data.id}`} className="font-medium underline-offset-4 hover:underline">
                    Incident {incident.data.reference}
                  </Link>
                </p>
                <p>
                  {INCIDENT_TYPE_LABELS[incident.data.type as keyof typeof INCIDENT_TYPE_LABELS] ?? incident.data.type} · gravité {(INCIDENT_SEVERITY_LABELS[incident.data.severity as keyof typeof INCIDENT_SEVERITY_LABELS] ?? incident.data.severity).toLowerCase()}
                </p>
                <p>
                  <StatusBadge label={INCIDENT_STATUS_LABELS[incident.data.status as keyof typeof INCIDENT_STATUS_LABELS] ?? incident.data.status} tone={incident.data.status === 'CLOTURE' || incident.data.status === 'RESOLU' ? 'neutral' : 'warning'} />
                </p>
                <p className="text-muted-foreground">Survenu le {formatDateTime(incident.data.occurredAt, session.timezone)}</p>
                <p className="whitespace-pre-wrap">{incident.data.description}</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {dialog === 'plan' ? <PlanDialog intervention={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'start' ? <StartDialog intervention={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'cancel' ? <CancelDialog intervention={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'reopen' ? <ReopenDialog intervention={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'cost' ? <CostDialog intervention={i} onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
