'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { MaintenanceVehiclePicker } from '@/components/maintenance/vehicle-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AcceptedSources, MaintenancePlanView, MaintenanceTypeView } from '@/lib/maintenance-types';
import { EMPTY_INTERVALS, IntervalFields, intervalsPayloadWithoutEmpty, type IntervalsForm } from './interval-fields';
import { BaseFields, EMPTY_BASE, RESPONSIBLE_NONE, ResponsibleField, SourcesField, basePayload, responsiblePayload, type BaseForm } from './plan-form-parts';

/** Création d'un plan véhicule/opération (POST /maintenance-plans) avec sa base de calcul (6.1, D-196). */
export function PlanCreateDialog({ companyId, initialVehicleId, onOpenChange, onCreated }: { companyId: string | null; initialVehicleId?: string; onOpenChange: (open: boolean) => void; onCreated: (plan: MaintenancePlanView) => void }) {
  const [vehicleId, setVehicleId] = useState(initialVehicleId ?? '');
  const [maintenanceTypeId, setMaintenanceTypeId] = useState('');
  const [intervals, setIntervals] = useState<IntervalsForm>(EMPTY_INTERVALS);
  const [base, setBase] = useState<BaseForm>(EMPTY_BASE);
  const [acceptedSources, setAcceptedSources] = useState<AcceptedSources>('TOUTES');
  const [responsible, setResponsible] = useState(RESPONSIBLE_NONE);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const types = useQuery({ queryKey: ['maintenance-types', 'actifs'], queryFn: () => api<MaintenanceTypeView[]>('/maintenance-types') });

  const create = useMutation({
    mutationFn: () => {
      const responsibleUserId = responsiblePayload(responsible);
      return api<MaintenancePlanView>('/maintenance-plans', {
        method: 'POST',
        body: {
          vehicleId,
          maintenanceTypeId,
          ...intervalsPayloadWithoutEmpty(intervals),
          base: basePayload(base),
          acceptedSources,
          ...(responsibleUserId ? { responsibleUserId } : {}),
        },
      });
    },
    onSuccess: (plan) => {
      toast.success(plan.status === 'INCOMPLET' ? 'Plan créé, statut INCOMPLET : échéance non calculable pour l’instant.' : 'Plan d’entretien créé.');
      onCreated(plan);
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
        toast.error(error.message);
      } else toast.error('Création impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !create.isPending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Nouveau plan d’entretien</DialogTitle>
          <DialogDescription>Un plan par véhicule et par opération. Les intervalles sont ceux retenus pour ce véhicule : aucun intervalle universel n’est imposé.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            const missing: Record<string, string[]> = {};
            if (!vehicleId) missing.vehicleId = ['Choisissez un véhicule.'];
            if (!maintenanceTypeId) missing.maintenanceTypeId = ['Choisissez une opération.'];
            setFieldErrors(missing);
            if (Object.keys(missing).length === 0) create.mutate();
          }}
        >
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="plan-vehicle">Véhicule *</Label>
              <MaintenanceVehiclePicker id="plan-vehicle" value={vehicleId} onChange={(v) => setVehicleId(v?.id ?? '')} companyId={companyId} invalid={Boolean(fieldErrors.vehicleId)} describedBy="vehicleId-error" />
              <FieldError errors={fieldErrors} name="vehicleId" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-type">Opération *</Label>
              <Select value={maintenanceTypeId} onValueChange={setMaintenanceTypeId}>
                <SelectTrigger id="plan-type" className="w-full" aria-invalid={fieldErrors.maintenanceTypeId ? true : undefined} aria-describedby="plan-type-hint maintenanceTypeId-error">
                  <SelectValue placeholder={types.isPending ? 'Chargement…' : 'Choisir une opération'} />
                </SelectTrigger>
                <SelectContent>
                  {(types.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {types.isError ? (
                <p id="plan-type-hint" className="text-xs text-destructive">
                  {isApiError(types.error) ? types.error.message : 'Catalogue indisponible.'}
                </p>
              ) : types.data && types.data.length === 0 ? (
                <p id="plan-type-hint" className="text-xs text-muted-foreground">
                  Catalogue vide : l’administrateur doit d’abord ajouter des opérations (onglet Catalogue).
                </p>
              ) : null}
              <FieldError errors={fieldErrors} name="maintenanceTypeId" />
            </div>
          </div>
          <IntervalFields value={intervals} onChange={(patch) => setIntervals((f) => ({ ...f, ...patch }))} errors={fieldErrors} idPrefix="plan-create" />
          <BaseFields value={base} onChange={(patch) => setBase((f) => ({ ...f, ...patch }))} errors={fieldErrors} idPrefix="plan-create" />
          <div className="grid gap-4 sm:grid-cols-2">
            <SourcesField id="plan-sources" value={acceptedSources} onChange={setAcceptedSources} errors={fieldErrors} />
            <ResponsibleField id="plan-responsible" value={responsible} onChange={setResponsible} errors={fieldErrors} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Création…' : 'Créer le plan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
