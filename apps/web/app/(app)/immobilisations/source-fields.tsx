'use client';

import { useQuery } from '@tanstack/react-query';
import { INCIDENT_TYPE_LABELS, INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { type FieldErrors, describedBy, invalid } from '@/components/incidents/ops-helpers';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { IncidentInterventionRef, IncidentView } from '@/lib/incidents-types';

export type SourceKind = 'AUTRE' | 'INCIDENT' | 'INTERVENTION';

export interface SourceValue {
  kind: SourceKind;
  incidentId: string;
  interventionId: string;
}

export const EMPTY_SOURCE: SourceValue = { kind: 'AUTRE', incidentId: '', interventionId: '' };

export function sourceBody(source: SourceValue): { incidentId?: string; interventionId?: string } {
  if (source.kind === 'INCIDENT' && source.incidentId) return { incidentId: source.incidentId };
  if (source.kind === 'INTERVENTION' && source.interventionId) return { interventionId: source.interventionId };
  return {};
}

export function sourceLocalErrors(source: SourceValue): FieldErrors {
  if (source.kind === 'INCIDENT' && !source.incidentId) return { incidentId: ['Choisissez l’incident source.'] };
  if (source.kind === 'INTERVENTION' && !source.interventionId) return { interventionId: ['Choisissez l’intervention source.'] };
  return {};
}

const KIND_LABELS: Record<SourceKind, string> = { AUTRE: 'Autre motif', INCIDENT: 'Incident du véhicule', INTERVENTION: 'Intervention du véhicule' };

/**
 * Source d'une cause d'immobilisation : incident non clôturé (GET /incidents?open=true) ou intervention
 * ouverte (GET /interventions?open=true) du même véhicule, ou autre motif.
 */
export function SourceFields({ idPrefix, vehicleId, value, onChange, errors }: { idPrefix: string; vehicleId: string | null; value: SourceValue; onChange: (value: SourceValue) => void; errors: FieldErrors }) {
  const incidents = useQuery({
    queryKey: ['incidents', toQuery({ vehicleId, open: 'true', pageSize: 100 })],
    queryFn: () => api<Page<IncidentView>>(`/incidents${toQuery({ vehicleId, open: 'true', pageSize: 100 })}`),
    enabled: Boolean(vehicleId) && value.kind === 'INCIDENT',
  });
  const interventions = useQuery({
    queryKey: ['interventions', 'immobilisation-source', vehicleId],
    queryFn: () => api<Page<IncidentInterventionRef>>(`/interventions${toQuery({ vehicleId, open: 'true', pageSize: 100 })}`),
    enabled: Boolean(vehicleId) && value.kind === 'INTERVENTION',
  });

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Source de la cause</legend>
      <RadioGroup value={value.kind} onValueChange={(kind) => onChange({ ...value, kind: kind as SourceKind })} className="flex flex-wrap gap-4">
        {(Object.keys(KIND_LABELS) as SourceKind[]).map((kind) => (
          <div key={kind} className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-source-${kind}`} value={kind} disabled={kind !== 'AUTRE' && !vehicleId} />
            <Label htmlFor={`${idPrefix}-source-${kind}`} className="font-normal">
              {KIND_LABELS[kind]}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {value.kind === 'INCIDENT' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-incident`}>Incident *</Label>
          <Select value={value.incidentId} onValueChange={(incidentId) => onChange({ ...value, incidentId })}>
            <SelectTrigger id={`${idPrefix}-incident`} className="w-full" aria-invalid={invalid(errors, 'incidentId')} aria-describedby={describedBy(errors, 'incidentId')}>
              <SelectValue placeholder={incidents.isPending ? 'Chargement…' : 'Choisir un incident'} />
            </SelectTrigger>
            <SelectContent>
              {(incidents.data?.items ?? []).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.reference} · {INCIDENT_TYPE_LABELS[i.type] ?? i.type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {incidents.isSuccess && incidents.data.items.length === 0 ? <p className="text-xs text-muted-foreground">Aucun incident non clôturé pour ce véhicule.</p> : null}
          <FieldError errors={errors} name="incidentId" />
        </div>
      ) : null}
      {value.kind === 'INTERVENTION' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-intervention`}>Intervention *</Label>
          <Select value={value.interventionId} onValueChange={(interventionId) => onChange({ ...value, interventionId })}>
            <SelectTrigger id={`${idPrefix}-intervention`} className="w-full" aria-invalid={invalid(errors, 'interventionId')} aria-describedby={describedBy(errors, 'interventionId')}>
              <SelectValue placeholder={interventions.isPending ? 'Chargement…' : 'Choisir une intervention'} />
            </SelectTrigger>
            <SelectContent>
              {(interventions.data?.items ?? []).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.reference} · {INTERVENTION_STATUS_LABELS[i.status as keyof typeof INTERVENTION_STATUS_LABELS] ?? i.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {interventions.isSuccess && interventions.data.items.length === 0 ? <p className="text-xs text-muted-foreground">Aucune intervention ouverte pour ce véhicule.</p> : null}
          <FieldError errors={errors} name="interventionId" />
        </div>
      ) : null}
    </fieldset>
  );
}
