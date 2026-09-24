'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS, INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { INTERVENTION_KIND_LABELS, type IncidentSummary, type InterventionKind, type InterventionView } from '@/lib/interventions-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { isoToLocalInput, localInputToIso } from '@/lib/zoned-time';
import { ApiErrorAlert, GarageSelect, type TaskRow, TasksEditor, taskInputsFrom, taskRowsFrom, validateTaskRows } from './form-parts';
import { type FieldErrors, NONE, describedBy, useOperationalCompanyIds } from './intervention-helpers';
import { VehiclePicker } from './vehicle-picker';

type Props =
  | { mode: 'create'; initialVehicleId?: string; sourceIncidentId?: string }
  | { mode: 'edit'; intervention: InterventionView };

function incidentLabel(i: IncidentSummary, timezone: string): string {
  return `${i.reference} · ${INCIDENT_TYPE_LABELS[i.type as keyof typeof INCIDENT_TYPE_LABELS] ?? i.type} · ${formatDateTime(i.occurredAt, timezone)}`;
}

/**
 * Création (POST /interventions) ou modification (PATCH /interventions/:id, verrou optimiste) d'une
 * intervention. Avec une date de début prévue, l'API la crée « planifiée », sinon « brouillon ».
 */
export function InterventionForm(props: Props) {
  const router = useRouter();
  const session = useSession();
  const queryClient = useQueryClient();
  const operationalCompanies = useOperationalCompanyIds();
  const editing = props.mode === 'edit' ? props.intervention : null;
  const sourceIncidentId = props.mode === 'create' ? (props.sourceIncidentId ?? '') : '';

  const [vehicleId, setVehicleId] = useState(props.mode === 'create' ? (props.initialVehicleId ?? '') : props.intervention.vehicleId);
  const [kind, setKind] = useState<InterventionKind>(editing ? editing.kind : sourceIncidentId ? 'CORRECTIF' : 'PREVENTIF');
  const [supplierId, setSupplierId] = useState(editing?.supplierId ?? NONE);
  const [plannedStart, setPlannedStart] = useState(isoToLocalInput(editing?.plannedStartAt, session.timezone));
  const [plannedEnd, setPlannedEnd] = useState(isoToLocalInput(editing?.plannedEndAt, session.timezone));
  const [diagnosis, setDiagnosis] = useState(editing?.diagnosis ?? '');
  const [workDescription, setWorkDescription] = useState(editing?.workDescription ?? '');
  const [incidentId, setIncidentId] = useState(sourceIncidentId || NONE);
  const [isHistorical, setIsHistorical] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>(() => (editing ? taskRowsFrom(editing.tasks) : []));
  const [tasksDirty, setTasksDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);

  // Incident source transmis dans l'URL : il impose le véhicule (l'API exige le même véhicule).
  const linkedIncidentId = sourceIncidentId || editing?.incidentId || '';
  const sourceIncident = useQuery({ queryKey: ['incident', linkedIncidentId], queryFn: () => api<IncidentSummary>(`/incidents/${linkedIncidentId}`), enabled: Boolean(linkedIncidentId) });
  const effectiveVehicleId = sourceIncidentId ? (sourceIncident.data?.vehicleId ?? '') : vehicleId;
  const vehicle = useQuery({ queryKey: ['vehicle', effectiveVehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${effectiveVehicleId}`), enabled: Boolean(effectiveVehicleId) && !editing });
  const companyId = editing ? editing.companyId : (vehicle.data?.companyId ?? null);
  const openIncidents = useQuery({
    queryKey: ['incidents', 'vehicle-open', effectiveVehicleId],
    queryFn: () => api<Page<IncidentSummary>>(`/incidents${toQuery({ vehicleId: effectiveVehicleId, open: 'true', pageSize: 100 })}`),
    enabled: Boolean(effectiveVehicleId) && !editing && !sourceIncidentId,
  });
  const incidentOptions = sourceIncident.data ? [sourceIncident.data] : (openIncidents.data?.items ?? []);
  const selectedIncident = incidentOptions.find((i) => i.id === incidentId) ?? null;

  const save = useMutation({
    mutationFn: () => {
      const plannedStartAt = plannedStart ? localInputToIso(plannedStart, session.timezone) : null;
      const plannedEndAt = plannedEnd ? localInputToIso(plannedEnd, session.timezone) : null;
      if (!editing) {
        return api<InterventionView>('/interventions', {
          method: 'POST',
          body: {
            vehicleId: effectiveVehicleId,
            kind,
            supplierId: supplierId !== NONE ? supplierId : undefined,
            plannedStartAt: plannedStartAt ?? undefined,
            plannedEndAt: plannedEndAt ?? undefined,
            diagnosis: diagnosis.trim() || undefined,
            workDescription: workDescription.trim() || undefined,
            incidentId: incidentId !== NONE ? incidentId : undefined,
            isHistorical: isHistorical || undefined,
            tasks: taskInputsFrom(tasks),
          },
        });
      }
      // Modification : seuls les champs changés sont transmis (un garage archivé depuis reste en place).
      const body: Record<string, unknown> = { expectedVersion: editing.version };
      if (kind !== editing.kind) body.kind = kind;
      const nextSupplier = supplierId === NONE ? null : supplierId;
      if (nextSupplier !== editing.supplierId) body.supplierId = nextSupplier;
      if (plannedStart !== isoToLocalInput(editing.plannedStartAt, session.timezone)) body.plannedStartAt = plannedStartAt;
      if (plannedEnd !== isoToLocalInput(editing.plannedEndAt, session.timezone)) body.plannedEndAt = plannedEndAt;
      if (diagnosis.trim() !== (editing.diagnosis ?? '')) body.diagnosis = diagnosis.trim() || null;
      if (workDescription.trim() !== (editing.workDescription ?? '')) body.workDescription = workDescription.trim() || null;
      if (tasksDirty) body.tasks = taskInputsFrom(tasks);
      return api<InterventionView>(`/interventions/${editing.id}`, { method: 'PATCH', body });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['intervention', saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ['interventions'] });
      if (saved.incidentId) {
        void queryClient.invalidateQueries({ queryKey: ['incident', saved.incidentId] });
        void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      }
      toast.success(editing ? `Intervention ${saved.reference} mise à jour.` : `Intervention ${saved.reference} créée (${INTERVENTION_STATUS_LABELS[saved.status].toLowerCase()}).`);
      router.push(`/interventions/${saved.id}`);
    },
    onError: (error) => {
      setSubmitError(error);
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la fiche est rechargée, le formulaire repart de la version courante.
        if (editing && error.status === 409) {
          void queryClient.invalidateQueries({ queryKey: ['intervention', editing.id] });
          if (error.code === 'VERSION_OBSOLETE') toast.info('Le formulaire a été rechargé avec la version courante : ressaisissez vos modifications.');
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const local: FieldErrors = { ...validateTaskRows(tasks) };
    if (!editing && !effectiveVehicleId) local.vehicleId = ['Choisissez le véhicule.'];
    if (plannedStart && !localInputToIso(plannedStart, session.timezone)) local.plannedStartAt = ['Date et heure invalides.'];
    if (plannedEnd && !localInputToIso(plannedEnd, session.timezone)) local.plannedEndAt = ['Date et heure invalides.'];
    setFieldErrors(local);
    if (Object.keys(local).length > 0) {
      toast.error('Certains champs sont à compléter.');
      return;
    }
    save.mutate();
  }

  const changeTasks = (rows: TaskRow[]) => {
    setTasks(rows);
    setTasksDirty(true);
  };

  return (
    <form className="space-y-6" noValidate onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intervention</CardTitle>
          <CardDescription>
            {editing
              ? `Référence ${editing.reference} · ${INTERVENTION_STATUS_LABELS[editing.status]}. Une version obsolète est refusée : la fiche est alors rechargée.`
              : 'La référence est attribuée par le serveur. Avec une date de début prévue, l’intervention est créée « planifiée » ; sans date, en « brouillon ».'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="vehicleId">Véhicule *</Label>
            {editing ? (
              <Input id="vehicleId" value={`${editing.vehicleCode} · ${editing.vehicleRegistration}`} readOnly disabled />
            ) : sourceIncidentId ? (
              <Input
                id="vehicleId"
                readOnly
                disabled
                value={vehicle.data ? `${vehicle.data.code} · ${vehicle.data.registration} · ${vehicle.data.make} ${vehicle.data.model}` : sourceIncident.isError ? 'Incident source introuvable' : 'Chargement…'}
                aria-describedby="vehicleId-hint"
              />
            ) : (
              <VehiclePicker
                id="vehicleId"
                vehicle={vehicle.data ?? null}
                allowedCompanyIds={operationalCompanies}
                onChange={(v) => {
                  queryClient.setQueryData(['vehicle', v.id, 'view'], v);
                  if (v.id !== vehicleId) {
                    setVehicleId(v.id);
                    setSupplierId(NONE);
                    setIncidentId(NONE);
                    // Les plans proposés dépendent du véhicule : les lignes liées à un plan sont retirées.
                    setTasks((rows) => rows.filter((r) => r.source !== 'plan'));
                  }
                }}
                invalid={Boolean(fieldErrors.vehicleId?.length)}
                describedBy={describedBy(fieldErrors, 'vehicleId', 'vehicleId-hint')}
              />
            )}
            <p id="vehicleId-hint" className="text-xs text-muted-foreground">
              {editing ? 'Le véhicule d’une intervention n’est pas modifiable.' : sourceIncidentId ? 'Véhicule de l’incident source.' : 'Véhicules actifs ou hors service des sociétés où vous pouvez créer une intervention.'}
            </p>
            {vehicle.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {isApiError(vehicle.error) ? vehicle.error.message : 'Véhicule introuvable.'}
              </p>
            ) : null}
            <FieldError errors={fieldErrors} name="vehicleId" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="kind">Type *</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as InterventionKind)}>
              <SelectTrigger id="kind" className="w-full" aria-describedby={describedBy(fieldErrors, 'kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(INTERVENTION_KIND_LABELS) as InterventionKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {INTERVENTION_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={fieldErrors} name="kind" />
          </div>

          <GarageSelect
            id="supplierId"
            companyId={companyId}
            value={supplierId}
            onChange={setSupplierId}
            current={editing?.supplierId && editing.supplierName ? { id: editing.supplierId, name: editing.supplierName } : null}
            errors={fieldErrors}
          />

          <div className="space-y-2">
            <Label htmlFor="plannedStartAt">Début prévu{editing?.status === 'PLANIFIEE' ? ' (obligatoire pour une intervention planifiée)' : ''}</Label>
            <Input
              id="plannedStartAt"
              type="datetime-local"
              required={editing?.status === 'PLANIFIEE'}
              value={plannedStart}
              onChange={(e) => setPlannedStart(e.target.value)}
              aria-invalid={Boolean(fieldErrors.plannedStartAt?.length) || undefined}
              aria-describedby={describedBy(fieldErrors, 'plannedStartAt', 'planned-hint')}
            />
            <FieldError errors={fieldErrors} name="plannedStartAt" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plannedEndAt">Fin prévue</Label>
            <Input
              id="plannedEndAt"
              type="datetime-local"
              value={plannedEnd}
              min={plannedStart || undefined}
              onChange={(e) => setPlannedEnd(e.target.value)}
              aria-invalid={Boolean(fieldErrors.plannedEndAt?.length) || undefined}
              aria-describedby={describedBy(fieldErrors, 'plannedEndAt', 'planned-hint')}
            />
            <FieldError errors={fieldErrors} name="plannedEndAt" />
          </div>
          <p id="planned-hint" className="text-xs text-muted-foreground md:col-span-2">
            Heures dans le fuseau de l’organisation ({session.timezone}). Planifier ne signifie pas exécuter : les dates prévues n’enregistrent aucun travail réalisé.
            {editing?.status === 'BROUILLON' ? ' Renseigner ces dates ne change pas le statut : l’intervention reste un brouillon jusqu’à l’action « Planifier » de la fiche.' : ''}
            {editing?.status === 'PLANIFIEE' ? ' Une intervention planifiée garde un début prévu : vous pouvez le déplacer, pas l’effacer (annulez l’intervention si elle n’a plus lieu).' : ''}
          </p>

          {editing ? (
            editing.incidentId ? (
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="incident-readonly">Incident source</Label>
                <Input
                  id="incident-readonly"
                  value={sourceIncident.data ? incidentLabel(sourceIncident.data, session.timezone) : sourceIncident.isError ? 'Incident hors de votre périmètre' : 'Chargement…'}
                  readOnly
                  disabled
                  aria-describedby="incident-readonly-hint"
                />
                <p id="incident-readonly-hint" className="text-xs text-muted-foreground">
                  L’incident source n’est pas modifiable.
                </p>
              </div>
            ) : null
          ) : (
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="incidentId">Incident source</Label>
              {sourceIncidentId ? (
                <Input
                  id="incidentId"
                  readOnly
                  disabled
                  value={sourceIncident.data ? incidentLabel(sourceIncident.data, session.timezone) : sourceIncident.isError ? 'Incident introuvable ou hors de votre périmètre' : 'Chargement…'}
                  aria-describedby="incidentId-hint"
                />
              ) : (
                <Select value={incidentId} onValueChange={setIncidentId} disabled={!effectiveVehicleId}>
                  <SelectTrigger id="incidentId" className="w-full" aria-describedby={describedBy(fieldErrors, 'incidentId', 'incidentId-hint')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Aucun incident</SelectItem>
                    {incidentOptions.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {incidentLabel(i, session.timezone)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p id="incidentId-hint" className="text-xs text-muted-foreground">
                {selectedIncident
                  ? `${INCIDENT_SEVERITY_LABELS[selectedIncident.severity as keyof typeof INCIDENT_SEVERITY_LABELS] ?? selectedIncident.severity} · ${INCIDENT_STATUS_LABELS[selectedIncident.status as keyof typeof INCIDENT_STATUS_LABELS] ?? selectedIncident.status} · ${selectedIncident.description}`
                  : 'Intervention urgente ouverte depuis un incident ouvert du véhicule (facultatif).'}
              </p>
              {sourceIncident.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {isApiError(sourceIncident.error) ? sourceIncident.error.message : 'Incident introuvable.'}
                </p>
              ) : null}
              {selectedIncident && !diagnosis.trim() ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setDiagnosis(selectedIncident.description)}>
                  Reprendre la description de l’incident dans le diagnostic
                </Button>
              ) : null}
              <FieldError errors={fieldErrors} name="incidentId" />
            </div>
          )}

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="diagnosis">Diagnostic</Label>
            <Textarea id="diagnosis" value={diagnosis} maxLength={4000} onChange={(e) => setDiagnosis(e.target.value)} aria-describedby={describedBy(fieldErrors, 'diagnosis')} />
            <FieldError errors={fieldErrors} name="diagnosis" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="workDescription">Travaux</Label>
            <Textarea id="workDescription" value={workDescription} maxLength={4000} onChange={(e) => setWorkDescription(e.target.value)} aria-describedby={describedBy(fieldErrors, 'workDescription')} />
            <FieldError errors={fieldErrors} name="workDescription" />
          </div>

          {!editing ? (
            <div className="space-y-1 md:col-span-2">
              <div className="flex items-start gap-2">
                <Checkbox id="isHistorical" checked={isHistorical} onCheckedChange={(v) => setIsHistorical(v === true)} aria-describedby="isHistorical-hint" className="mt-0.5" />
                <Label htmlFor="isHistorical" className="font-normal">
                  Opération historique saisie a posteriori
                </Label>
              </div>
              <p id="isHistorical-hint" className="pl-6 text-xs text-muted-foreground">
                Import ou rattrapage d’un entretien déjà réalisé : terminez-la ensuite directement avec sa date effective. Une opération plus ancienne que la base courante d’un plan ne la fait pas reculer.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Travaux prévus</CardTitle>
          <CardDescription>Les lignes de travail restent modifiables jusqu’à la clôture{editing ? ' ; si vous les modifiez, elles remplacent les lignes actuelles' : ''}.</CardDescription>
        </CardHeader>
        <CardContent>
          <TasksEditor vehicleId={effectiveVehicleId || null} rows={tasks} onChange={changeTasks} errors={fieldErrors} />
        </CardContent>
      </Card>

      <ApiErrorAlert error={submitError} />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : editing ? 'Enregistrer les modifications' : 'Créer l’intervention'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={save.isPending}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
