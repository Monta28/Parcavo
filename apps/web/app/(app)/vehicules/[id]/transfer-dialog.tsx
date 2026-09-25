'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ROLE_LABELS, type RoleKey } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { NONE } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { AttachmentField, type UploadedFile } from '@/components/odometer/attachment-field';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DepartmentView } from '@/lib/admin-types';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { appPathOrNull } from '@/lib/app-paths';
import type { DriverView } from '@/lib/drivers-types';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import { type TransferIssue, type TransferPlanDecision, type TransferPreview, type TransferResponsibles, type TransferResult, transferBlockersOf, transferFieldErrors, transferIssueStatusLabel } from '@/lib/transfer-types';
import type { SiteView } from '@/lib/vehicles-types';

type FieldErrors = Record<string, string[]>;
type ReadingMode = '' | 'releve' | 'sans';
interface PlanChoice {
  decision: TransferPlanDecision | '';
  responsibleUserId: string;
}

function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

function invalid(errors: FieldErrors, name: string): true | undefined {
  return errors[name]?.length ? true : undefined;
}

/**
 * Transfert d'un véhicule vers une autre société (CDC 2.4 ; D-119 à D-125), réservé à l'administrateur :
 * aperçu serveur (GET /vehicles/:id/transfer-preview) avec objets bloquants, avertissements et objets à
 * réexaminer, puis une décision explicite par objet et POST /vehicles/:id/transfer avec clé d'idempotence
 * (générée à l'ouverture, conservée pour les nouvelles tentatives) et version attendue. Un refus 409
 * TRANSFERT_BLOQUE affiche la liste typée des objets bloquants renvoyée par l'API.
 */
export function TransferDialog({ vehicleId, onClose }: { vehicleId: string; onClose: () => void }) {
  const preview = useQuery({
    queryKey: ['vehicle', vehicleId, 'transfer-preview'],
    queryFn: () => api<TransferPreview>(`/vehicles/${vehicleId}/transfer-preview`),
    // Aperçu toujours recalculé à l'ouverture : jamais d'ancien aperçu (blocages levés entre-temps) affiché.
    staleTime: 0,
    gcTime: 0,
  });
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{preview.data ? `Transférer le véhicule ${preview.data.vehicleCode} · ${preview.data.registration}` : 'Transférer le véhicule'}</DialogTitle>
          <DialogDescription>
            Le transfert prend effet à l’heure du serveur lors de la validation. Les événements et les dépenses passés restent à la société d’origine ; la société destinataire voit l’état technique courant et les documents partagés.
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <LoadingState label="Calcul de l’aperçu du transfert…" />
        ) : preview.isError ? (
          <ErrorState error={preview.error} retry={() => void preview.refetch()} />
        ) : (
          <TransferForm preview={preview.data} refreshing={preview.isFetching} onRefresh={() => void preview.refetch()} onSubmitting={setSubmitting} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function IssueList({ issues, tone }: { issues: TransferIssue[]; tone: 'danger' | 'warning' }) {
  return (
    <ul className="space-y-2">
      {issues.map((issue) => {
        const link = appPathOrNull(issue.link);
        return (
          <li key={`${issue.type}-${issue.id}`} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge label={transferIssueStatusLabel(issue)} tone={tone} />
              <span className="font-medium">{issue.label}</span>
            </div>
            <p className="mt-1 text-muted-foreground">{issue.action}</p>
            {link ? (
              <Link href={link} className="mt-1 inline-block underline underline-offset-4">
                Traiter<span className="sr-only"> : {issue.label}</span>
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TransferForm({ preview, refreshing, onRefresh, onSubmitting, onClose }: { preview: TransferPreview; refreshing: boolean; onRefresh: () => void; onSubmitting: (pending: boolean) => void; onClose: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [targetCompanyId, setTargetCompanyId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [closeAssignment, setCloseAssignment] = useState(false);
  const [newDriverId, setNewDriverId] = useState(NONE);
  const [plans, setPlans] = useState<Record<string, PlanChoice>>({});
  const [shared, setShared] = useState<Set<string>>(() => new Set(preview.documents.filter((d) => d.suggested).map((d) => d.id)));
  const [readingMode, setReadingMode] = useState<ReadingMode>('');
  const [physicalKm, setPhysicalKm] = useState('');
  const [readingNote, setReadingNote] = useState('');
  const [readingPhoto, setReadingPhoto] = useState<UploadedFile | null>(null);
  const [noReadingReason, setNoReadingReason] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  const target = preview.targetCompanies.find((c) => c.id === targetCompanyId) ?? null;
  const sites = useQuery({
    queryKey: ['sites', 'transfer', targetCompanyId],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: targetCompanyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(targetCompanyId),
  });
  const departments = useQuery({
    queryKey: ['departments', 'transfer', targetCompanyId],
    queryFn: () => api<DepartmentView[]>(`/departments${toQuery({ companyId: targetCompanyId })}`),
    enabled: Boolean(targetCompanyId),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'transfer', targetCompanyId],
    queryFn: () => api<Page<DriverView>>(`/drivers${toQuery({ companyId: targetCompanyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(targetCompanyId),
  });
  // Responsables éligibles calculés par l'API avec la règle du contrôle (administrateurs groupe compris).
  const responsibles = useQuery({
    queryKey: ['vehicles', preview.vehicleId, 'transfer-responsibles', targetCompanyId],
    queryFn: () => api<TransferResponsibles>(`/vehicles/${preview.vehicleId}/transfer-responsibles${toQuery({ companyId: targetCompanyId })}`),
    enabled: Boolean(targetCompanyId) && preview.plans.length > 0,
  });
  const responsibleOptions = (responsibles.data?.items ?? []).filter((u) => u.id !== session.userId);
  const activeDepartments = (departments.data ?? []).filter((d) => d.status === 'ACTIF');

  const transfer = useMutation({
    mutationFn: () => {
      const hasAssignments = preview.assignments.length > 0;
      const body = {
        targetCompanyId,
        expectedVersion: preview.version,
        reason: reason.trim(),
        assignment: hasAssignments || newDriverId !== NONE ? { closeCurrent: hasAssignments ? closeAssignment : false, newResponsibleDriverId: newDriverId !== NONE ? newDriverId : null } : undefined,
        plans: preview.plans.map((p) => {
          const choice = plans[p.id];
          return {
            planId: p.id,
            decision: choice?.decision,
            responsibleUserId: choice?.decision === 'KEEP' ? (choice.responsibleUserId !== NONE ? choice.responsibleUserId : null) : undefined,
          };
        }),
        siteId: siteId === NONE ? null : siteId,
        departmentId: departmentId === NONE ? null : departmentId,
        sharedDocumentVersionIds: preview.documents.filter((d) => shared.has(d.id)).map((d) => d.id),
        transferReading: readingMode === 'releve' ? { physicalKm: physicalKm.trim().replace(/[\s  ]/g, '').replace(',', '.'), attachmentId: readingPhoto?.id, note: readingNote.trim() || undefined } : undefined,
        noReadingReason: readingMode === 'sans' ? noReadingReason.trim() : undefined,
        acknowledgeWarnings: preview.warnings.length > 0 ? acknowledge : undefined,
      };
      return api<TransferResult>(`/vehicles/${preview.vehicleId}/transfer`, { method: 'POST', body, idempotencyKey });
    },
    onMutate: () => onSubmitting(true),
    onSettled: () => onSubmitting(false),
    onSuccess: (result) => {
      const to = preview.targetCompanies.find((c) => c.id === result.toCompanyId);
      toast.success(`Véhicule ${preview.vehicleCode} transféré vers la société ${to?.code ?? result.vehicle.companyCode}${result.resolvedAlerts > 0 ? ` ; ${result.resolvedAlerts} alerte(s) de la société d’origine résolue(s)` : ''}.`);
      void queryClient.invalidateQueries({ queryKey: ['vehicle', preview.vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 409) onRefresh();
    },
  });
  const refusedBlockers = transferBlockersOf(transfer.error);
  const errors: FieldErrors = { ...transferFieldErrors(transfer.error), ...local };

  if (preview.blockers.length > 0) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTitle>Transfert impossible pour l’instant</AlertTitle>
          <AlertDescription>
            {preview.blockers.length} opération{preview.blockers.length > 1 ? 's' : ''} ouverte{preview.blockers.length > 1 ? 's' : ''} à traiter d’abord (utilisation, immobilisation, intervention ou réservation future). Rien n’est annulé automatiquement.
          </AlertDescription>
        </Alert>
        <section aria-labelledby="transfer-blockers-title" className="space-y-2">
          <h3 id="transfer-blockers-title" className="text-sm font-semibold">
            Opérations bloquantes
          </h3>
          <IssueList issues={preview.blockers} tone="danger" />
        </section>
        <p className="text-xs text-muted-foreground">Aperçu calculé le {formatDateTime(preview.evaluatedAt, session.timezone)}.</p>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Fermer
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // Un nouvel aperçu remplace le refus précédent : ses objets bloquants ne sont plus réaffichés.
              transfer.reset();
              onRefresh();
            }}
            disabled={refreshing}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> {refreshing ? 'Actualisation…' : 'Actualiser l’aperçu'}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const setPlan = (planId: string, patch: Partial<PlanChoice>) => setPlans((prev) => ({ ...prev, [planId]: { decision: prev[planId]?.decision ?? '', responsibleUserId: prev[planId]?.responsibleUserId ?? NONE, ...patch } }));

  const submit = () => {
    const next: FieldErrors = {};
    if (!targetCompanyId) next.targetCompanyId = ['Choisissez la société destinataire.'];
    if (targetCompanyId && !siteId) next.siteId = ['Choisissez un site de la société destinataire, ou « aucun site ».'];
    if (targetCompanyId && !departmentId) next.departmentId = ['Choisissez un service de la société destinataire, ou « aucun service ».'];
    if (preview.assignments.length > 0 && !closeAssignment) next['assignment.closeCurrent'] = ['Confirmez la clôture de l’affectation habituelle : son conducteur relève de la société d’origine.'];
    preview.plans.forEach((p, index) => {
      if (!plans[p.id]?.decision) next[`plans.${index}.decision`] = ['Choisissez de conserver ou de désactiver ce plan.'];
    });
    if (!readingMode) next.readingMode = ['Saisissez le relevé de transfert, ou transférez sans relevé avec un motif.'];
    if (readingMode === 'releve' && !physicalKm.trim()) next['transferReading.physicalKm'] = ['Indiquez le compteur lu.'];
    if (readingMode === 'sans' && noReadingReason.trim().length < 3) next.noReadingReason = ['Indiquez pourquoi aucun relevé n’est saisi (3 caractères au moins).'];
    if (preview.warnings.length > 0 && !acknowledge) next.acknowledgeWarnings = ['Prenez connaissance des avertissements avant de transférer.'];
    if (reason.trim().length < 3) next.reason = ['Indiquez le motif du transfert (3 caractères au moins).'];
    setLocal(next);
    if (Object.keys(next).length === 0) transfer.mutate();
  };

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Alert>
        <AlertTitle>Aucune opération bloquante</AlertTitle>
        <AlertDescription>
          Société actuelle : {preview.companyCode}. Aperçu calculé le {formatDateTime(preview.evaluatedAt, session.timezone)} ; il est recalculé par le serveur au moment du transfert.
        </AlertDescription>
      </Alert>

      {refusedBlockers.length > 0 ? (
        <section aria-labelledby="transfer-refused-title" className="space-y-2">
          <h3 id="transfer-refused-title" className="text-sm font-semibold text-destructive">
            Transfert refusé : opérations ouvertes apparues entre-temps
          </h3>
          <IssueList issues={refusedBlockers} tone="danger" />
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="transfer-target">Société destinataire *</Label>
          <Select
            value={targetCompanyId}
            onValueChange={(v) => {
              setTargetCompanyId(v);
              setSiteId('');
              setDepartmentId('');
              setNewDriverId(NONE);
              setPlans((prev) => Object.fromEntries(Object.entries(prev).map(([k, c]) => [k, { ...c, responsibleUserId: NONE }])));
            }}
          >
            <SelectTrigger id="transfer-target" className="w-full" aria-invalid={invalid(errors, 'targetCompanyId')} aria-describedby={describedBy(errors, 'targetCompanyId')}>
              <SelectValue placeholder="Choisir la société" />
            </SelectTrigger>
            <SelectContent>
              {preview.targetCompanies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} · {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preview.targetCompanies.length === 0 ? <p className="text-xs text-muted-foreground">Aucune autre société active ne peut recevoir le véhicule.</p> : null}
          <FieldError errors={errors} name="targetCompanyId" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="transfer-site">Site dans la société destinataire *</Label>
          <Select value={siteId} onValueChange={setSiteId} disabled={!targetCompanyId || sites.isPending}>
            <SelectTrigger id="transfer-site" className="w-full" aria-invalid={invalid(errors, 'siteId')} aria-describedby={describedBy(errors, 'siteId')}>
              <SelectValue placeholder={targetCompanyId ? 'Choisir' : 'Société d’abord'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Aucun site</SelectItem>
              {(sites.data?.items ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sites.isError ? <p className="text-xs text-destructive">{isApiError(sites.error) ? sites.error.message : 'Sites indisponibles.'}</p> : null}
          <FieldError errors={errors} name="siteId" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="transfer-department">Service dans la société destinataire *</Label>
          <Select value={departmentId} onValueChange={setDepartmentId} disabled={!targetCompanyId || departments.isPending}>
            <SelectTrigger id="transfer-department" className="w-full" aria-invalid={invalid(errors, 'departmentId')} aria-describedby={describedBy(errors, 'departmentId')}>
              <SelectValue placeholder={targetCompanyId ? 'Choisir' : 'Société d’abord'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Aucun service</SelectItem>
              {activeDepartments.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {departments.isError ? <p className="text-xs text-destructive">{isApiError(departments.error) ? departments.error.message : 'Services indisponibles.'}</p> : null}
          <FieldError errors={errors} name="departmentId" />
        </div>
      </section>

      {preview.warnings.length > 0 ? (
        <section aria-labelledby="transfer-warnings-title" className="space-y-2">
          <h3 id="transfer-warnings-title" className="text-sm font-semibold">
            Avertissements (non bloquants)
          </h3>
          <IssueList issues={preview.warnings} tone="warning" />
          <div className="flex items-start gap-2">
            <Checkbox id="transfer-ack" checked={acknowledge} onCheckedChange={(v) => setAcknowledge(v === true)} aria-invalid={invalid(errors, 'acknowledgeWarnings')} aria-describedby={describedBy(errors, 'acknowledgeWarnings')} />
            <Label htmlFor="transfer-ack" className="font-normal">
              J’ai pris connaissance de ces avertissements : ces objets restent rattachés à la société d’origine.
            </Label>
          </div>
          <FieldError errors={errors} name="acknowledgeWarnings" />
        </section>
      ) : null}

      <section aria-labelledby="transfer-assignment-title" className="space-y-3">
        <h3 id="transfer-assignment-title" className="text-sm font-semibold">
          Affectation habituelle
        </h3>
        {preview.assignments.length > 0 ? (
          <>
            <ul className="space-y-1 text-sm">
              {preview.assignments.map((a) => (
                <li key={a.id}>
                  {a.driverName} · {a.isCurrent ? `en cours depuis le ${formatDateTime(a.startsAt, session.timezone)} (clôturée au transfert)` : `prévue à partir du ${formatDateTime(a.startsAt, session.timezone)} (retirée au transfert)`}
                </li>
              ))}
            </ul>
            <div className="flex items-start gap-2">
              <Checkbox id="transfer-close-assignment" checked={closeAssignment} onCheckedChange={(v) => setCloseAssignment(v === true)} aria-invalid={invalid(errors, 'assignment.closeCurrent')} aria-describedby={describedBy(errors, 'assignment.closeCurrent')} />
              <Label htmlFor="transfer-close-assignment" className="font-normal">
                Clôturer l’affectation en cours et retirer les affectations prévues (leur conducteur relève de la société d’origine)
              </Label>
            </div>
            <FieldError errors={errors} name="assignment.closeCurrent" />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Aucune affectation habituelle en cours ou prévue.</p>
        )}
        <div className="max-w-md space-y-2">
          <Label htmlFor="transfer-new-driver">Nouveau responsable habituel (facultatif)</Label>
          <Select value={newDriverId} onValueChange={setNewDriverId} disabled={!targetCompanyId}>
            <SelectTrigger id="transfer-new-driver" className="w-full" aria-invalid={invalid(errors, 'assignment.newResponsibleDriverId')} aria-describedby={describedBy(errors, 'assignment.newResponsibleDriverId')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Aucun</SelectItem>
              {(drivers.data?.items ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.firstName} {d.lastName} · {d.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Conducteur actif de la société destinataire.</p>
          <FieldError errors={errors} name="assignment.newResponsibleDriverId" />
        </div>
      </section>

      <section aria-labelledby="transfer-plans-title" className="space-y-3">
        <h3 id="transfer-plans-title" className="text-sm font-semibold">
          Plans d’entretien actifs
        </h3>
        {preview.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun plan d’entretien actif.</p>
        ) : (
          <ul className="space-y-3">
            {preview.plans.map((p, index) => {
              const choice = plans[p.id];
              return (
                <li key={p.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <p className="font-medium">{p.maintenanceTypeLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    Prochaine échéance : {p.nextDueKm ? formatKm(p.nextDueKm) : '—'} · {p.nextDueDate ? formatDate(p.nextDueDate) : '—'} (bases et échéances conservées si le plan est gardé)
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor={`transfer-plan-${index}`}>Décision *</Label>
                      <Select value={choice?.decision ?? ''} onValueChange={(v) => setPlan(p.id, { decision: v === 'KEEP' ? 'KEEP' : 'DEACTIVATE' })}>
                        <SelectTrigger id={`transfer-plan-${index}`} className="w-full" aria-invalid={invalid(errors, `plans.${index}.decision`)} aria-describedby={describedBy(errors, `plans.${index}.decision`)}>
                          <SelectValue placeholder="Choisir" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="KEEP">Conserver pour la société destinataire</SelectItem>
                          <SelectItem value="DEACTIVATE">Désactiver</SelectItem>
                        </SelectContent>
                      </Select>
                      <FieldError errors={errors} name={`plans.${index}.decision`} />
                      <FieldError errors={errors} name={`plans.${index}.planId`} />
                    </div>
                    {choice?.decision === 'KEEP' ? (
                      <div className="space-y-1">
                        <Label htmlFor={`transfer-plan-${index}-responsible`}>Responsable du plan</Label>
                        <Select value={choice.responsibleUserId} onValueChange={(v) => setPlan(p.id, { responsibleUserId: v })} disabled={!targetCompanyId}>
                          <SelectTrigger id={`transfer-plan-${index}-responsible`} className="w-full" aria-invalid={invalid(errors, `plans.${index}.responsibleUserId`)} aria-describedby={describedBy(errors, `plans.${index}.responsibleUserId`)}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Aucun responsable</SelectItem>
                            <SelectItem value={session.userId}>
                              Moi-même ({session.firstName} {session.lastName})
                            </SelectItem>
                            {responsibleOptions.map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {u.firstName} {u.lastName} · {u.roles.map((r) => ROLE_LABELS[r as RoleKey] ?? r).join(', ')} · {u.email}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {responsibles.isError ? (
                          <p className="text-xs text-destructive" role="alert">
                            Liste des responsables indisponible : {isApiError(responsibles.error) ? responsibles.error.message : 'erreur réseau'}.
                          </p>
                        ) : null}
                        <FieldError errors={errors} name={`plans.${index}.responsibleUserId`} />
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <FieldError errors={errors} name="plans" />
      </section>

      <section aria-labelledby="transfer-documents-title" className="space-y-3">
        <h3 id="transfer-documents-title" className="text-sm font-semibold">
          Documents du véhicule à partager
        </h3>
        {preview.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun document de véhicule enregistré.</p>
        ) : (
          <ul className="space-y-2">
            {preview.documents.map((d) => (
              <li key={d.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  id={`transfer-doc-${d.id}`}
                  checked={shared.has(d.id)}
                  onCheckedChange={(v) =>
                    setShared((prev) => {
                      const next = new Set(prev);
                      if (v === true) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    })
                  }
                />
                <Label htmlFor={`transfer-doc-${d.id}`} className="font-normal">
                  {d.documentTypeLabel}
                  {d.number ? ` n° ${d.number}` : ''} · {d.validFrom ? `du ${formatDate(d.validFrom)}` : 'sans date de début'} {d.validTo ? `au ${formatDate(d.validTo)}` : '(sans fin)'}
                  {d.suggested ? ' · proposé' : ''}
                </Label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Les versions cochées restent rattachées à la société d’origine et deviennent visibles de la société destinataire.</p>
        <FieldError errors={errors} name="sharedDocumentVersionIds" />
      </section>

      {preview.telemetryMappings.length > 0 ? (
        <section aria-labelledby="transfer-telemetry-title" className="space-y-2">
          <h3 id="transfer-telemetry-title" className="text-sm font-semibold">
            Boîtiers télématiques
          </h3>
          <ul className="space-y-1 text-sm">
            {preview.telemetryMappings.map((m) => (
              <li key={m.id}>
                <span className="font-medium">
                  {m.providerName} · {m.unitLabel}
                </span>{' '}
                <span className="text-muted-foreground">— {m.outcome}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="transfer-reading-title" className="space-y-3">
        <h3 id="transfer-reading-title" className="text-sm font-semibold">
          Relevé de transfert *
        </h3>
        <p className="text-sm text-muted-foreground">
          {preview.lastReading
            ? `Dernier relevé accepté : ${formatKm(preview.lastReading.physicalKm ?? preview.lastReading.cumulativeKm)} le ${formatDateTime(preview.lastReading.observedAt, session.timezone)}.`
            : 'Aucun relevé accepté pour ce véhicule.'}{' '}
          Le relevé borne la répartition des distances entre les deux sociétés ; il est rattaché à la société d’origine.
        </p>
        <RadioGroup value={readingMode} onValueChange={(v) => setReadingMode(v === 'releve' ? 'releve' : 'sans')} aria-label="Relevé de transfert" aria-describedby={describedBy(errors, 'readingMode')} className="gap-2">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="transfer-reading-yes" value="releve" />
            <Label htmlFor="transfer-reading-yes" className="font-normal">
              Saisir le compteur lu au moment du transfert
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="transfer-reading-no" value="sans" />
            <Label htmlFor="transfer-reading-no" className="font-normal">
              Transférer sans relevé (distances de la période non ventilables)
            </Label>
          </div>
        </RadioGroup>
        <FieldError errors={errors} name="readingMode" />
        {readingMode === 'releve' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="transfer-km">Compteur lu (km) *</Label>
              <Input id="transfer-km" inputMode="decimal" autoComplete="off" value={physicalKm} onChange={(e) => setPhysicalKm(e.target.value)} aria-invalid={invalid(errors, 'transferReading.physicalKm')} aria-describedby={describedBy(errors, 'transferReading.physicalKm')} />
              <FieldError errors={errors} name="transferReading.physicalKm" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transfer-reading-note">Note du relevé</Label>
              <Input id="transfer-reading-note" maxLength={1000} value={readingNote} onChange={(e) => setReadingNote(e.target.value)} aria-invalid={invalid(errors, 'transferReading.note')} aria-describedby={describedBy(errors, 'transferReading.note')} />
              <FieldError errors={errors} name="transferReading.note" />
            </div>
            <div className="sm:col-span-2">
              <AttachmentField
                id="transfer-reading-photo"
                label="Photo du compteur (facultatif)"
                companyId={preview.companyId}
                accept="image/jpeg,image/png"
                capture
                value={readingPhoto}
                onChange={setReadingPhoto}
                errors={errors}
                errorName="transferReading.attachmentId"
              />
            </div>
          </div>
        ) : null}
        {readingMode === 'sans' ? (
          <div className="space-y-2">
            <Label htmlFor="transfer-no-reading">Motif de l’absence de relevé *</Label>
            <Textarea id="transfer-no-reading" rows={2} maxLength={500} value={noReadingReason} onChange={(e) => setNoReadingReason(e.target.value)} aria-invalid={invalid(errors, 'noReadingReason')} aria-describedby={describedBy(errors, 'noReadingReason')} />
            <FieldError errors={errors} name="noReadingReason" />
          </div>
        ) : null}
      </section>

      <div className="space-y-2">
        <Label htmlFor="transfer-reason">Motif du transfert *</Label>
        <Textarea id="transfer-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
        <FieldError errors={errors} name="reason" />
      </div>

      {refusedBlockers.length === 0 ? <ApiErrorAlert error={transfer.error} /> : null}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={transfer.isPending}>
          Fermer
        </Button>
        <Button type="submit" disabled={transfer.isPending || refreshing}>
          {transfer.isPending ? 'Transfert en cours…' : target ? `Transférer vers ${target.code}` : 'Confirmer le transfert'}
        </Button>
      </DialogFooter>
    </form>
  );
}
