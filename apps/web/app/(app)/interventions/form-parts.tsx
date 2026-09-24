'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { PLAN_STATUS_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { AttachmentView } from '@/lib/drivers-types';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import {
  COST_LINE_KIND_LABELS,
  type CostLineInput,
  type CostLineKind,
  type GarageOption,
  type InterventionTaskView,
  type MaintenanceTypeOption,
  type TaskInput,
  type VehiclePlanOption,
} from '@/lib/interventions-types';
import { type FieldErrors, NONE, collectErrors, describedBy, isDecimalFormat, normalizeDecimalInput } from './intervention-helpers';

let rowCounter = 0;
function nextRowKey(): string {
  rowCounter += 1;
  return `ligne-${rowCounter}`;
}

/** Erreur globale renvoyée par l'API (message métier affiché tel quel, référence de la requête). */
export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="text-destructive">{apiError ? apiError.message : 'Une erreur est survenue.'}</p>
      {apiError?.status === 0 ? <p className="mt-1 text-muted-foreground">Vérifiez votre connexion : rien n’a été enregistré.</p> : null}
      {apiError?.requestId ? <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p> : null}
    </div>
  );
}

// Garage --------------------------------------------------------------------------------------

/**
 * Garage de la société du véhicule (GET /suppliers?companyId=&category=GARAGE, actifs). Le fournisseur
 * actuel reste affiché s'il n'est plus proposé (archivé ou d'une autre catégorie).
 */
export function GarageSelect({
  id,
  companyId,
  value,
  onChange,
  current,
  errors,
  errorName = 'supplierId',
  label = 'Garage / fournisseur',
  allowNone = true,
}: {
  id: string;
  companyId: string | null;
  value: string;
  onChange: (value: string) => void;
  current?: { id: string; name: string } | null;
  errors: FieldErrors;
  errorName?: string;
  label?: string;
  allowNone?: boolean;
}) {
  const garages = useQuery({
    queryKey: ['suppliers', 'garages', companyId],
    queryFn: () => api<Page<GarageOption>>(`/suppliers${toQuery({ companyId, category: 'GARAGE', status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(companyId),
  });
  const items = garages.data?.items ?? [];
  const showCurrent = current && !items.some((g) => g.id === current.id);
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={!companyId}>
        <SelectTrigger id={id} className="w-full" aria-invalid={Boolean(errors[errorName]?.length) || undefined} aria-describedby={describedBy(errors, errorName, hintId)}>
          <SelectValue placeholder="Aucun garage" />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value={NONE}>Aucun garage</SelectItem> : null}
          {showCurrent ? <SelectItem value={current.id}>{current.name} (actuel)</SelectItem> : null}
          {items.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
              {g.phone ? ` · ${g.phone}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        {!companyId
          ? 'Choisissez d’abord le véhicule : seuls les garages de sa société sont proposés.'
          : garages.isPending
            ? 'Chargement des garages…'
            : garages.isError
              ? isApiError(garages.error)
                ? garages.error.message
                : 'Liste des garages indisponible.'
              : items.length === 0
                ? 'Aucun garage actif enregistré pour la société du véhicule.'
                : 'Garages actifs de la société du véhicule.'}
      </p>
      <FieldError errors={errors} name={errorName} />
    </div>
  );
}

// Lignes de travail ---------------------------------------------------------------------------

export type TaskSource = 'plan' | 'type' | 'libre';

export interface TaskRow {
  key: string;
  source: TaskSource;
  planId: string;
  maintenanceTypeId: string;
  label: string;
  notes: string;
  /** Libellé du plan déjà rattaché (modification), affiché s'il n'est plus proposé. */
  planLabel?: string;
}

const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  plan: 'Plan d’entretien du véhicule',
  type: 'Opération du catalogue',
  libre: 'Libellé libre',
};

/** Intervalles du plan tels que renvoyés par l'API (km et/ou mois ou jours). */
function planInterval(p: VehiclePlanOption): string {
  const parts = [p.intervalKm ? formatKm(p.intervalKm) : null, p.intervalMonths ? `${p.intervalMonths} mois` : null, p.intervalDays ? `${p.intervalDays} jours` : null].filter(Boolean);
  return parts.length ? parts.join(' ou ') : 'non renseigné';
}

export function newTaskRow(source: TaskSource): TaskRow {
  return { key: nextRowKey(), source, planId: '', maintenanceTypeId: '', label: '', notes: '' };
}

/** Lignes existantes d'une intervention, pour modification. */
export function taskRowsFrom(tasks: InterventionTaskView[]): TaskRow[] {
  return tasks.map((t) => ({
    key: t.id,
    source: t.planId ? 'plan' : t.maintenanceTypeId ? 'type' : 'libre',
    planId: t.planId ?? '',
    maintenanceTypeId: t.maintenanceTypeId ?? '',
    label: t.label,
    notes: t.notes ?? '',
    planLabel: t.planId ? (t.maintenanceTypeLabel ?? t.label) : undefined,
  }));
}

/** Contrôles de saisie (champ requis selon la nature de la ligne) ; les règles métier restent à l'API. */
export function validateTaskRows(rows: TaskRow[]): FieldErrors {
  const errors: FieldErrors = {};
  rows.forEach((r, i) => {
    if (r.source === 'plan' && !r.planId) errors[`tasks.${i}.planId`] = ['Choisissez le plan réalisé par cette ligne.'];
    if (r.source === 'type' && !r.maintenanceTypeId) errors[`tasks.${i}.maintenanceTypeId`] = ['Choisissez l’opération du catalogue.'];
    if (r.source === 'libre' && r.label.trim().length < 2) errors[`tasks.${i}.label`] = ['Libellé requis (2 caractères minimum).'];
    else if (r.label.trim().length === 1) errors[`tasks.${i}.label`] = ['Libellé trop court (2 caractères minimum) : laissez vide pour reprendre celui de l’opération.'];
  });
  return errors;
}

export function taskInputsFrom(rows: TaskRow[]): TaskInput[] {
  return rows.map((r) => {
    const label = r.label.trim() || undefined;
    const notes = r.notes.trim() || undefined;
    if (r.source === 'plan') return { planId: r.planId, label, notes };
    if (r.source === 'type') return { maintenanceTypeId: r.maintenanceTypeId, label, notes };
    return { label, notes };
  });
}

/**
 * Lignes de travail (CDC 6.3, 6.4) : chaque ligne réalise un plan du véhicule, une opération du
 * catalogue (rattachée par l'API au plan actif correspondant s'il existe) ou un libellé libre.
 */
export function TasksEditor({ vehicleId, rows, onChange, errors }: { vehicleId: string | null; rows: TaskRow[]; onChange: (rows: TaskRow[]) => void; errors: FieldErrors }) {
  const plans = useQuery({
    queryKey: ['maintenance-plans', 'vehicle', vehicleId],
    queryFn: () => api<Page<VehiclePlanOption>>(`/maintenance-plans${toQuery({ vehicleId, pageSize: 100 })}`),
    enabled: Boolean(vehicleId),
  });
  const types = useQuery({ queryKey: ['maintenance-types', 'actifs'], queryFn: () => api<MaintenanceTypeOption[]>('/maintenance-types') });
  const planItems = plans.data?.items ?? [];
  const typeItems = types.data ?? [];
  const update = (index: number, patch: Partial<TaskRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const add = (source: TaskSource) => onChange([...rows, newTaskRow(source)]);

  return (
    <fieldset className="space-y-3" aria-describedby="tasks-hint">
      <legend className="text-sm font-medium">Lignes de travail</legend>
      <p id="tasks-hint" className="text-xs text-muted-foreground">
        Liez chaque ligne au plan qu’elle réalise : à la clôture, seules les lignes effectivement réalisées mettent à jour leur propre plan (changer une batterie ne remet pas la vidange à zéro).
      </p>
      {!vehicleId ? <p className="text-sm text-muted-foreground">Choisissez d’abord le véhicule pour proposer ses plans d’entretien.</p> : null}
      {plans.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(plans.error) ? plans.error.message : 'Plans d’entretien indisponibles.'}
        </p>
      ) : null}
      {types.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(types.error) ? types.error.message : 'Catalogue des opérations indisponible.'}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Aucune ligne de travail. Ajoutez au moins une ligne avant la clôture.</p> : null}
      <ol className="space-y-3">
        {rows.map((row, index) => {
          const n = index + 1;
          const base = `task-${row.key}`;
          const usedPlans = new Set(rows.filter((_, i) => i !== index).map((r) => r.planId).filter(Boolean));
          const selectedPlan = planItems.find((p) => p.id === row.planId);
          return (
            <li key={row.key} className="rounded-md border p-3">
              <div className="grid gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
                <div className="space-y-1">
                  <Label htmlFor={`${base}-source`}>Ligne {n} : nature</Label>
                  <Select value={row.source} onValueChange={(v) => update(index, { source: v as TaskSource, planId: '', maintenanceTypeId: '' })}>
                    <SelectTrigger id={`${base}-source`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TASK_SOURCE_LABELS) as TaskSource[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {TASK_SOURCE_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {row.source === 'plan' ? (
                  <div className="space-y-1">
                    <Label htmlFor={`${base}-plan`}>Plan du véhicule *</Label>
                    <Select value={row.planId} onValueChange={(v) => update(index, { planId: v })} disabled={!vehicleId}>
                      <SelectTrigger
                        id={`${base}-plan`}
                        className="w-full"
                        aria-invalid={Boolean(errors[`tasks.${index}.planId`]?.length) || undefined}
                        aria-describedby={describedBy(errors, `tasks.${index}.planId`)}
                      >
                        <SelectValue placeholder={plans.isPending && vehicleId ? 'Chargement…' : 'Choisir un plan'} />
                      </SelectTrigger>
                      <SelectContent>
                        {row.planId && !selectedPlan && !plans.isPending ? <SelectItem value={row.planId}>{row.planLabel ?? 'Plan actuel'} (plan inactif ou non proposé)</SelectItem> : null}
                        {planItems.length === 0 ? (
                          <SelectItem value={NONE} disabled>
                            Aucun plan actif pour ce véhicule
                          </SelectItem>
                        ) : null}
                        {planItems.map((p) => (
                          <SelectItem key={p.id} value={p.id} disabled={usedPlans.has(p.id)}>
                            {p.maintenanceTypeLabel} · {PLAN_STATUS_LABELS[p.status as keyof typeof PLAN_STATUS_LABELS] ?? p.status}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedPlan ? (
                      <p className="text-xs text-muted-foreground">
                        Intervalle : {planInterval(selectedPlan)} · prochaine échéance : {[selectedPlan.nextDueKm ? formatKm(selectedPlan.nextDueKm) : null, selectedPlan.nextDueDate ? formatDate(selectedPlan.nextDueDate) : null].filter(Boolean).join(' ou ') || 'non déterminée'}
                      </p>
                    ) : null}
                    <FieldError errors={errors} name={`tasks.${index}.planId`} />
                  </div>
                ) : row.source === 'type' ? (
                  <div className="space-y-1">
                    <Label htmlFor={`${base}-type`}>Opération du catalogue *</Label>
                    <Select value={row.maintenanceTypeId} onValueChange={(v) => update(index, { maintenanceTypeId: v })}>
                      <SelectTrigger
                        id={`${base}-type`}
                        className="w-full"
                        aria-invalid={Boolean(errors[`tasks.${index}.maintenanceTypeId`]?.length) || undefined}
                        aria-describedby={describedBy(errors, `tasks.${index}.maintenanceTypeId`, `${base}-type-hint`)}
                      >
                        <SelectValue placeholder={types.isPending ? 'Chargement…' : 'Choisir une opération'} />
                      </SelectTrigger>
                      <SelectContent>
                        {typeItems.length === 0 ? (
                          <SelectItem value={NONE} disabled>
                            Catalogue vide
                          </SelectItem>
                        ) : null}
                        {typeItems.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p id={`${base}-type-hint`} className="text-xs text-muted-foreground">
                      Si le véhicule a un plan actif pour cette opération, la ligne y est rattachée.
                    </p>
                    <FieldError errors={errors} name={`tasks.${index}.maintenanceTypeId`} />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor={`${base}-label`}>Libellé *</Label>
                    <Input
                      id={`${base}-label`}
                      value={row.label}
                      maxLength={200}
                      onChange={(e) => update(index, { label: e.target.value })}
                      aria-invalid={Boolean(errors[`tasks.${index}.label`]?.length) || undefined}
                      aria-describedby={describedBy(errors, `tasks.${index}.label`)}
                    />
                    <FieldError errors={errors} name={`tasks.${index}.label`} />
                  </div>
                )}
                <div className="flex items-end">
                  <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={`Retirer la ligne ${n}`} title={`Retirer la ligne ${n}`}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {row.source !== 'libre' ? (
                  <div className="space-y-1">
                    <Label htmlFor={`${base}-custom-label`}>Libellé (facultatif)</Label>
                    <Input
                      id={`${base}-custom-label`}
                      value={row.label}
                      maxLength={200}
                      placeholder="Par défaut : libellé de l’opération"
                      onChange={(e) => update(index, { label: e.target.value })}
                      aria-invalid={Boolean(errors[`tasks.${index}.label`]?.length) || undefined}
                      aria-describedby={describedBy(errors, `tasks.${index}.label`)}
                    />
                    <FieldError errors={errors} name={`tasks.${index}.label`} />
                  </div>
                ) : null}
                <div className={row.source === 'libre' ? 'space-y-1 md:col-span-2' : 'space-y-1'}>
                  <Label htmlFor={`${base}-notes`}>Notes</Label>
                  <Input id={`${base}-notes`} value={row.notes} maxLength={1000} onChange={(e) => update(index, { notes: e.target.value })} aria-describedby={describedBy(errors, `tasks.${index}.notes`)} />
                  <FieldError errors={errors} name={`tasks.${index}.notes`} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => add('plan')} disabled={!vehicleId}>
          <Plus className="size-4" aria-hidden="true" /> Plan du véhicule
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => add('type')}>
          <Plus className="size-4" aria-hidden="true" /> Opération du catalogue
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => add('libre')}>
          <Plus className="size-4" aria-hidden="true" /> Libellé libre
        </Button>
      </div>
      <FieldError errors={errors} name="tasks" />
    </fieldset>
  );
}

// Coûts ---------------------------------------------------------------------------------------

export type CostMode = 'plus_tard' | 'lignes' | 'total' | 'sans_cout';

export interface CostLineRow {
  key: string;
  taskId: string;
  kind: CostLineKind;
  label: string;
  quantity: string;
  unitPrice: string;
}

export function newCostLineRow(kind: CostLineKind = 'PIECE'): CostLineRow {
  return { key: nextRowKey(), taskId: NONE, kind, label: '', quantity: '1', unitPrice: '' };
}

export interface CostState {
  mode: CostMode;
  lines: CostLineRow[];
  total: string;
}

/** Contrôles de format des montants ; totaux, arrondis et état du coût sont calculés par l'API. */
export function validateCost(state: CostState): FieldErrors {
  const errors: FieldErrors = {};
  if (state.mode === 'lignes') {
    if (state.lines.length === 0) errors.lines = ['Ajoutez au moins une ligne, ou choisissez un autre mode de saisie.'];
    state.lines.forEach((l, i) => {
      if (!l.label.trim()) errors[`lines.${i}.label`] = ['Libellé requis.'];
      if (!isDecimalFormat(normalizeDecimalInput(l.quantity))) errors[`lines.${i}.quantity`] = ['Quantité positive attendue (ex. 1 ou 2,5).'];
      if (!isDecimalFormat(normalizeDecimalInput(l.unitPrice))) errors[`lines.${i}.unitPrice`] = ['Prix unitaire positif attendu (ex. 45,500).'];
    });
  }
  if (state.mode === 'total' && !isDecimalFormat(normalizeDecimalInput(state.total))) errors.totalAmount = ['Total TTC positif ou nul attendu (ex. 250,000).'];
  return errors;
}

/** Champs de coût du contrat API (lignes, total ou « sans coût ») selon le mode choisi. */
export function costPayload(state: CostState): { lines?: CostLineInput[]; totalAmount?: string; noCost?: boolean } {
  switch (state.mode) {
    case 'lignes':
      return {
        lines: state.lines.map((l) => ({
          ...(l.taskId !== NONE ? { taskId: l.taskId } : {}),
          kind: l.kind,
          label: l.label.trim(),
          quantity: normalizeDecimalInput(l.quantity),
          unitPrice: normalizeDecimalInput(l.unitPrice),
        })),
      };
    case 'total':
      return { totalAmount: normalizeDecimalInput(state.total) };
    case 'sans_cout':
      return { noCost: true };
    default:
      return {};
  }
}

/**
 * Saisie du coût : lignes pièces / main-d'œuvre (quantité, prix unitaire TTC), total TTC seul, ou
 * « sans coût ». Les montants de ligne et le total sont calculés par l'API à l'enregistrement.
 */
export function CostFields({
  idPrefix,
  state,
  onChange,
  canWriteCosts,
  allowLater,
  tasks,
  errors,
}: {
  idPrefix: string;
  state: CostState;
  onChange: (state: CostState) => void;
  canWriteCosts: boolean;
  allowLater: boolean;
  tasks: InterventionTaskView[];
  errors: FieldErrors;
}) {
  const session = useSession();
  const modes: Array<{ value: CostMode; label: string; hint: string }> = [
    ...(allowLater ? [{ value: 'plus_tard' as const, label: 'Coût à saisir plus tard', hint: 'Facture non reçue : l’intervention sera marquée « coût à saisir ».' }] : []),
    ...(canWriteCosts
      ? [
          { value: 'lignes' as const, label: 'Lignes pièces / main-d’œuvre', hint: 'Le total est la somme des lignes, calculée par le serveur.' },
          { value: 'total' as const, label: 'Total TTC seul', hint: `Montant en ${session.currency}, ${session.currencyDecimals} décimales.` },
        ]
      : []),
    { value: 'sans_cout', label: 'Sans coût', hint: 'Aucune dépense ne sera créée.' },
  ];
  const updateLine = (index: number, patch: Partial<CostLineRow>) => onChange({ ...state, lines: state.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) });

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Coût</legend>
      {!canWriteCosts ? <p className="text-xs text-muted-foreground">La saisie des montants requiert la permission « Saisir des coûts » (costs.write).</p> : null}
      <RadioGroup value={state.mode} onValueChange={(v) => onChange({ ...state, mode: v as CostMode })} aria-label="Mode de saisie du coût" className="gap-2">
        {modes.map((m) => (
          <div key={m.value} className="flex items-start gap-2">
            <RadioGroupItem id={`${idPrefix}-mode-${m.value}`} value={m.value} className="mt-0.5" aria-describedby={`${idPrefix}-mode-${m.value}-hint`} />
            <div>
              <Label htmlFor={`${idPrefix}-mode-${m.value}`} className="font-normal">
                {m.label}
              </Label>
              <p id={`${idPrefix}-mode-${m.value}-hint`} className="text-xs text-muted-foreground">
                {m.hint}
              </p>
            </div>
          </div>
        ))}
      </RadioGroup>

      {state.mode === 'lignes' ? (
        <div className="space-y-3">
          <ol className="space-y-3">
            {state.lines.map((line, index) => {
              const n = index + 1;
              const base = `${idPrefix}-line-${line.key}`;
              return (
                <li key={line.key} className="rounded-md border p-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,6rem)_minmax(0,9rem)_auto]">
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-kind`}>Ligne {n} : nature</Label>
                      <Select value={line.kind} onValueChange={(v) => updateLine(index, { kind: v as CostLineKind })}>
                        <SelectTrigger id={`${base}-kind`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(COST_LINE_KIND_LABELS) as CostLineKind[]).map((k) => (
                            <SelectItem key={k} value={k}>
                              {COST_LINE_KIND_LABELS[k]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-label`}>Libellé *</Label>
                      <Input
                        id={`${base}-label`}
                        value={line.label}
                        maxLength={200}
                        onChange={(e) => updateLine(index, { label: e.target.value })}
                        aria-invalid={Boolean(errors[`lines.${index}.label`]?.length) || undefined}
                        aria-describedby={describedBy(errors, `lines.${index}.label`)}
                      />
                      <FieldError errors={errors} name={`lines.${index}.label`} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-qty`}>Quantité *</Label>
                      <Input
                        id={`${base}-qty`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })}
                        aria-invalid={Boolean(errors[`lines.${index}.quantity`]?.length) || undefined}
                        aria-describedby={describedBy(errors, `lines.${index}.quantity`)}
                      />
                      <FieldError errors={errors} name={`lines.${index}.quantity`} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-price`}>Prix unitaire TTC ({session.currency}) *</Label>
                      <Input
                        id={`${base}-price`}
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                        aria-invalid={Boolean(errors[`lines.${index}.unitPrice`]?.length) || undefined}
                        aria-describedby={describedBy(errors, `lines.${index}.unitPrice`)}
                      />
                      <FieldError errors={errors} name={`lines.${index}.unitPrice`} />
                    </div>
                    <div className="flex items-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => onChange({ ...state, lines: state.lines.filter((_, i) => i !== index) })}
                        aria-label={`Retirer la ligne de coût ${n}`}
                        title={`Retirer la ligne de coût ${n}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {tasks.length > 0 ? (
                    <div className="mt-3 space-y-1 sm:max-w-md">
                      <Label htmlFor={`${base}-task`}>Ligne de travail concernée</Label>
                      <Select value={line.taskId} onValueChange={(v) => updateLine(index, { taskId: v })}>
                        <SelectTrigger id={`${base}-task`} className="w-full" aria-describedby={describedBy(errors, `lines.${index}.taskId`)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Aucune en particulier</SelectItem>
                          {tasks.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError errors={errors} name={`lines.${index}.taskId`} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...state, lines: [...state.lines, newCostLineRow('PIECE')] })}>
              <Plus className="size-4" aria-hidden="true" /> Pièce
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...state, lines: [...state.lines, newCostLineRow('MAIN_OEUVRE')] })}>
              <Plus className="size-4" aria-hidden="true" /> Main-d’œuvre
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Le montant de chaque ligne et le total TTC sont calculés par le serveur à l’enregistrement ; ils s’affichent ensuite sur la fiche.</p>
          <FieldError errors={errors} name="lines" />
        </div>
      ) : null}

      {state.mode === 'total' ? (
        <div className="space-y-1 sm:max-w-xs">
          <Label htmlFor={`${idPrefix}-total`}>Total TTC ({session.currency}) *</Label>
          <Input
            id={`${idPrefix}-total`}
            inputMode="decimal"
            value={state.total}
            onChange={(e) => onChange({ ...state, total: e.target.value })}
            aria-invalid={Boolean(errors.totalAmount?.length) || undefined}
            aria-describedby={describedBy(errors, 'totalAmount')}
          />
          <FieldError errors={errors} name="totalAmount" />
        </div>
      ) : null}
      <FieldError errors={errors} name="noCost" />
    </fieldset>
  );
}

// Pièces jointes ------------------------------------------------------------------------------

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Pièces jointes privées (PDF, JPEG, PNG ; 10 Mo) : téléversées en zone temporaire (POST /attachments)
 * puis rattachées par l'API lors de l'enregistrement.
 */
export function AttachmentsField({
  id,
  label,
  hint,
  companyId,
  files,
  onChange,
  max,
  errors,
  errorName,
}: {
  id: string;
  label: string;
  hint?: string;
  companyId: string;
  files: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  max: number;
  errors: FieldErrors;
  errorName: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      const uploaded: UploadedFile[] = [];
      for (const file of list) {
        const form = new FormData();
        form.append('file', file);
        form.append('companyId', companyId);
        const att = await api<AttachmentView>('/attachments', { method: 'POST', formData: form });
        uploaded.push({ id: att.id, name: att.originalName, mimeType: att.mimeType });
      }
      return uploaded;
    },
    onSuccess: (uploaded) => onChange([...files, ...uploaded]),
  });
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      <input
        ref={input}
        type="file"
        multiple
        accept="application/pdf,image/jpeg,image/png"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []).slice(0, Math.max(0, max - files.length));
          if (list.length) upload.mutate(list);
          e.target.value = '';
        }}
      />
      {files.length > 0 ? (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{f.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange(files.filter((x) => x.id !== f.id))} aria-label={`Retirer ${f.name}`}>
                Retirer
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        id={id}
        type="button"
        variant="outline"
        size="sm"
        disabled={upload.isPending || files.length >= max}
        onClick={() => input.current?.click()}
        aria-labelledby={`${id}-label ${id}`}
        aria-describedby={describedBy(errors, errorName, hintId)}
      >
        {upload.isPending ? 'Envoi du fichier…' : 'Ajouter un fichier'}
      </Button>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {upload.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(upload.error) ? upload.error.message : 'Téléversement impossible.'}
        </p>
      ) : null}
      <FieldError errors={collectErrors(errors, errorName)} name={errorName} />
    </div>
  );
}

// Divers --------------------------------------------------------------------------------------

/** Libellé court d'un instant prévu, dans le fuseau de l'organisation. */
export function plannedRange(start: string | null, end: string | null, timezone: string): string {
  if (!start && !end) return '—';
  if (start && end) return `du ${formatDateTime(start, timezone)} au ${formatDateTime(end, timezone)}`;
  return start ? `à partir du ${formatDateTime(start, timezone)}` : `jusqu’au ${formatDateTime(end, timezone)}`;
}
