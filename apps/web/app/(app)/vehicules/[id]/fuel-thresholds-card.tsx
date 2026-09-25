'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { FUEL_THRESHOLD_SOURCE_LABELS, type FuelThresholdField, type VehicleFuelThresholdRow, type VehicleFuelThresholdsView } from '@/lib/telemetry-types';

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

/** Valeur d'un seuil avec son unité, telle que renvoyée par l'API. */
export function formatThreshold(value: number, unit: string | null): string {
  return `${NUMBER.format(value)}${unit ? ` ${unit}` : ''}`;
}

function thresholdsKey(vehicleId: string) {
  return ['telemetry', 'vehicle', vehicleId, 'fuel-thresholds'] as const;
}

/**
 * Seuils carburant du véhicule (CDC 8.5, 17.1 ; D-238, D-240) : baisse anormale à l'arrêt et remplissage
 * détecté. Pour chaque seuil, la valeur de la société (avec son origine), la surcharge propre au véhicule et
 * la valeur appliquée par la détection, toutes fournies par l'API. Le chef de parc (ou l'administrateur)
 * modifie les surcharges avec un motif ; un champ vide reprend la valeur de la société.
 */
export function FuelThresholdsCard({ vehicleId }: { vehicleId: string }) {
  const { session } = useAppScope();
  const query = useQuery({ queryKey: thresholdsKey(vehicleId), queryFn: () => api<VehicleFuelThresholdsView>(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`) });
  const [editing, setEditing] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Seuils carburant du véhicule</CardTitle>
        <CardDescription>
          Baisse anormale à l’arrêt (sonde uniquement) et remplissage détecté. Un seuil propre au véhicule remplace celui de la société ; sans surcharge, la valeur de la société s’applique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <LoadingState label="Chargement des seuils…" />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : (
          <>
            <div className="rounded-md border">
              <Table aria-label="Seuils carburant du véhicule">
                <TableHeader>
                  <TableRow>
                    <TableHead>Seuil</TableHead>
                    <TableHead className="hidden md:table-cell">Société</TableHead>
                    <TableHead>Véhicule</TableHead>
                    <TableHead>Appliqué</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.thresholds.map((row) => (
                    <TableRow key={row.field}>
                      <TableCell className="text-sm">{row.label}</TableCell>
                      <TableCell className="hidden md:table-cell text-sm">
                        {formatThreshold(row.companyValue, row.unit)}
                        <span className="block text-xs text-muted-foreground">{FUEL_THRESHOLD_SOURCE_LABELS[row.companySource]}</span>
                      </TableCell>
                      <TableCell className="text-sm">{row.vehicleValue === null ? <span className="text-muted-foreground">—</span> : formatThreshold(row.vehicleValue, row.unit)}</TableCell>
                      <TableCell className="text-sm">
                        <span className="font-medium">{formatThreshold(row.effectiveValue, row.unit)}</span>
                        <StatusBadge label={FUEL_THRESHOLD_SOURCE_LABELS[row.source]} tone={row.source === 'vehicule' ? 'info' : 'neutral'} className="ml-2" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {query.data.version > 0 ? (
              <p className="text-xs text-muted-foreground">
                Surcharge du véhicule : « {query.data.reason} »{query.data.updatedByName ? `, par ${query.data.updatedByName}` : ''}
                {query.data.updatedAt ? `, le ${formatDateTime(query.data.updatedAt, session.timezone)}` : ''}.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Aucun seuil propre à ce véhicule : les seuils de la société s’appliquent.</p>
            )}
            {query.data.canEdit ? (
              editing ? (
                <ThresholdsForm view={query.data} onClose={() => setEditing(false)} />
              ) : (
                <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                  Modifier les seuils du véhicule
                </Button>
              )
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function initialValues(rows: readonly VehicleFuelThresholdRow[]): Record<FuelThresholdField, string> {
  return Object.fromEntries(rows.map((r) => [r.field, r.vehicleValue === null ? '' : String(r.vehicleValue).replace('.', ',')])) as Record<FuelThresholdField, string>;
}

/** Saisie des surcharges : champ vide = valeur de la société ; bornes et motif contrôlés par l'API (422). */
function ThresholdsForm({ view, onClose }: { view: VehicleFuelThresholdsView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => initialValues(view.thresholds));
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<VehicleFuelThresholdsView>(`/telemetry/vehicles/${view.vehicleId}/fuel-thresholds`, { method: 'PUT', body }),
    onSuccess: (next) => {
      queryClient.setQueryData(thresholdsKey(view.vehicleId), next);
      toast.success(next.version > 0 ? 'Seuils du véhicule enregistrés.' : 'Seuils de la société rétablis pour ce véhicule.');
      onClose();
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Seuils non enregistrés.'),
  });
  const errors = { ...errorsOf(save.error), ...local };

  function submit(clear: boolean) {
    const next: FieldErrors = {};
    const body: Record<string, unknown> = { reason: reason.trim(), expectedVersion: view.version };
    for (const row of view.thresholds) {
      const raw = clear ? '' : values[row.field].trim().replace(',', '.');
      if (raw === '') {
        body[row.field] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) next[row.field] = ['Nombre attendu.'];
      else body[row.field] = n;
    }
    if (reason.trim().length < 3) next['reason'] = ['Indiquez le motif (3 caractères au moins).'];
    setLocal(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(body);
  }

  return (
    <form
      className="space-y-4 rounded-md border p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {view.thresholds.map((row) => {
          const id = `fuel-threshold-${row.field}`;
          return (
            <div key={row.field} className="space-y-1">
              <Label htmlFor={id}>
                {row.label}
                {row.unit ? ` (${row.unit})` : ''}
              </Label>
              <Input
                id={id}
                inputMode="decimal"
                value={values[row.field]}
                placeholder={`Société : ${formatThreshold(row.companyValue, row.unit)}`}
                onChange={(e) => setValues({ ...values, [row.field]: e.target.value })}
                aria-invalid={invalid(errors, row.field)}
                aria-describedby={describedBy(errors, row.field, `${id}-hint`)}
              />
              <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                Vide : valeur de la société.{row.min !== null && row.max !== null ? ` Entre ${formatThreshold(row.min, row.unit)} et ${formatThreshold(row.max, row.unit)}.` : ''}
              </p>
              <FieldError errors={errors} name={row.field} />
            </div>
          );
        })}
      </div>
      <div className="space-y-1">
        <Label htmlFor="fuel-threshold-reason">Motif *</Label>
        <Textarea id="fuel-threshold-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. sonde de benne, réservoir de faible capacité" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
        <FieldError errors={errors} name="reason" />
      </div>
      {save.error ? <ApiErrorAlert error={save.error} /> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer les seuils'}
        </Button>
        {view.version > 0 ? (
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => submit(true)}>
            Revenir aux seuils de la société
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
