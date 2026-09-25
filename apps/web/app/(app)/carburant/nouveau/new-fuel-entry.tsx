'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { AttachmentField, type UploadedFile } from '@/components/odometer/attachment-field';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { FuelEntryView } from '@/lib/fuel-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { VehiclePicker } from '../../interventions/vehicle-picker';
import { FuelAnomalyBadges, FuelStatusBadge, FuelWarnings, formatFuelLiters, useFuelWriteCompanyIds, useMoney } from '../fuel-display';
import { DriverSelect, EnergySelect, FullTankField, SupplierSelect, isDecimal3, normalizeDecimal } from '../fuel-form-parts';

interface Draft {
  filledAt: string;
  odometerKm: string;
  liters: string;
  unitPrice: string;
  totalAmount: string;
  energy: string;
  isFullTank: boolean | null;
  supplierId: string;
  driverId: string;
  ticket: UploadedFile | null;
  notes: string;
}

function emptyDraft(timezone: string): Draft {
  return { filledAt: nowLocalInput(timezone), odometerKm: '', liters: '', unitPrice: '', totalAmount: '', energy: '', isFullTank: null, supplierId: '', driverId: '', ticket: null, notes: '' };
}

/**
 * Saisie d'un plein par le personnel (CDC 8.2, D-222 à D-225) : POST /fuel-entries avec une clé
 * d'idempotence générée à l'ouverture du formulaire et réutilisée pour chaque nouvel essai du même envoi.
 * Le serveur crée le plein validé et sa dépense, contrôle le compteur, signale l'écart de montant et le
 * dépassement de capacité : ces avertissements sont affichés tels quels après l'enregistrement.
 */
export function NewFuelEntry() {
  const { session } = useAppScope();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const writeCompanies = useFuelWriteCompanyIds();
  const money = useMoney();
  const initialVehicleId = params.get('vehicule') ?? '';
  const [vehicle, setVehicle] = useState<VehicleView | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(session.timezone));
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [local, setLocal] = useState<FieldErrors>({});
  const [result, setResult] = useState<FuelEntryView | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // Véhicule prérempli depuis ?vehicule= (fiche véhicule, liste filtrée) : rechargé depuis l'API.
  const preset = useQuery({ queryKey: ['vehicle', initialVehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${initialVehicleId}`), enabled: Boolean(initialVehicleId) });
  const presetVehicle = preset.data && writeCompanies.includes(preset.data.companyId) ? preset.data : null;
  const selected = vehicle ?? presetVehicle;

  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelEntryView>('/fuel-entries', { method: 'POST', body, idempotencyKey }),
    onSuccess: (created) => {
      setResult(created);
      void queryClient.invalidateQueries({ queryKey: ['fuel-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', created.vehicleId] });
      toast.success('Plein enregistré.');
    },
    onError: (error) => toast.error(isApiError(error) && error.status === 0 ? 'Non enregistré : vérifiez votre connexion puis réessayez.' : isApiError(error) ? error.message : 'Plein non enregistré.'),
  });

  if (writeCompanies.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Saisir un plein" />
        {session.isDriverOnly ? (
          <EmptyState
            title="Écran réservé au personnel du parc"
            description="Déclarez votre ticket carburant depuis l’espace « Mon véhicule » : il sera validé par le gestionnaire du parc."
            action={
              <Button asChild variant="outline">
                <Link href="/mon-vehicule">Mon véhicule</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState title="Saisie non autorisée" description="La saisie d’un plein requiert un rôle opérationnel et la permission « Saisir des coûts » sur au moins une société." />
        )}
      </div>
    );
  }

  function restart() {
    submit.reset();
    setLocal({});
    setResult(null);
    setIdempotencyKey(newIdempotencyKey());
    setDraft(emptyDraft(session.timezone));
  }

  if (result) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Saisir un plein" />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2 ref={resultHeading} tabIndex={-1} className="outline-none">
                Plein enregistré
              </h2>
            </CardTitle>
            <CardDescription>Réponse du serveur reçue : le plein et sa dépense de synthèse sont enregistrés.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-base font-semibold">
                {result.vehicleCode} · {result.vehicleRegistration}
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(result.filledAt, session.timezone)} · {formatFuelLiters(result.liters)}
                {result.totalAmount !== null ? ` · ${money(result.totalAmount)}` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <FuelStatusBadge status={result.status} />
                <FuelAnomalyBadges entry={result} />
              </div>
            </div>
            <FuelWarnings entry={result} money={money} />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild>
                <Link href={`/carburant/${result.id}`}>Voir le plein</Link>
              </Button>
              <Button type="button" variant="outline" onClick={restart}>
                Saisir un autre plein
              </Button>
              <Button variant="ghost" asChild>
                <Link href="/carburant">Retour à la liste</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const errors = { ...errorsOf(submit.error), ...local };
  const bodyMismatch = isApiError(submit.error) && submit.error.code === 'IDEMPOTENCE_CORPS_DIFFERENT';

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    const filledIso = localInputToIso(draft.filledAt, session.timezone);
    const liters = normalizeDecimal(draft.liters);
    const total = normalizeDecimal(draft.totalAmount);
    const unitPrice = normalizeDecimal(draft.unitPrice);
    const km = normalizeDecimal(draft.odometerKm);
    if (!selected) next.vehicleId = ['Choisissez le véhicule.'];
    if (!filledIso) next.filledAt = ['Indiquez la date et l’heure du plein.'];
    if (!liters) next.liters = ['Indiquez les litres achetés.'];
    else if (!isDecimal3(liters)) next.liters = ['Nombre positif attendu, 3 décimales au plus (ex. 40,250).'];
    if (!total) next.totalAmount = ['Indiquez le montant total TTC.'];
    else if (!isDecimal3(total)) next.totalAmount = ['Montant positif attendu, 3 décimales au plus (ex. 101,000).'];
    if (unitPrice && !isDecimal3(unitPrice)) next.unitPrice = ['Prix positif attendu, 3 décimales au plus (ex. 2,525).'];
    if (km && !isDecimal3(km)) next.odometerKm = ['Nombre positif attendu, par exemple 45230.'];
    if (draft.isFullTank === null) next.isFullTank = ['Indiquez si le plein est complet ou partiel.'];
    setLocal(next);
    if (Object.keys(next).length > 0 || !selected || !filledIso || draft.isFullTank === null) return;
    submit.mutate({
      vehicleId: selected.id,
      filledAt: filledIso,
      liters,
      totalAmount: total,
      unitPrice: unitPrice || undefined,
      odometerKm: km || undefined,
      energy: draft.energy || undefined,
      isFullTank: draft.isFullTank,
      supplierId: draft.supplierId || undefined,
      driverId: draft.driverId || undefined,
      ticketAttachmentId: draft.ticket?.id,
      notes: draft.notes.trim() || undefined,
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Saisir un plein" description="Plein enregistré directement comme validé, avec sa dépense de synthèse au registre. Les tickets des conducteurs se valident depuis la liste des pleins." />
      <Card>
        <CardContent className="pt-6">
          <form className="space-y-5" noValidate onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="fuel-vehicle">Véhicule *</Label>
              <VehiclePicker
                id="fuel-vehicle"
                vehicle={selected}
                allowedCompanyIds={writeCompanies}
                onChange={(v) => {
                  setVehicle(v);
                  // Fournisseur et conducteur dépendent de la société du véhicule.
                  if (v.companyId !== selected?.companyId) update({ supplierId: '', driverId: '' });
                }}
                invalid={invalid(errors, 'vehicleId')}
                describedBy={describedBy(errors, 'vehicleId', 'fuel-vehicle-hint')}
              />
              <p id="fuel-vehicle-hint" className="text-xs text-muted-foreground">
                {selected ? `Société ${selected.companyCode} · réservoir ${selected.tankCapacityLiters ? formatFuelLiters(selected.tankCapacityLiters) : 'non renseigné'}.` : 'Véhicules des sociétés où vous pouvez saisir des coûts.'}
              </p>
              <FieldError errors={errors} name="vehicleId" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="fuel-filled-at">Date et heure du plein *</Label>
                <Input id="fuel-filled-at" type="datetime-local" value={draft.filledAt} onChange={(e) => update({ filledAt: e.target.value })} aria-invalid={invalid(errors, 'filledAt')} aria-describedby={describedBy(errors, 'filledAt', 'fuel-filled-at-hint')} />
                <p id="fuel-filled-at-hint" className="text-xs text-muted-foreground">
                  Heure locale ({session.timezone}) figurant sur le ticket. Une date future est refusée.
                </p>
                <FieldError errors={errors} name="filledAt" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fuel-km">Kilométrage au compteur</Label>
                <Input id="fuel-km" inputMode="decimal" autoComplete="off" value={draft.odometerKm} onChange={(e) => update({ odometerKm: e.target.value })} aria-invalid={invalid(errors, 'odometerKm')} aria-describedby={describedBy(errors, 'odometerKm', 'fuel-km-hint')} />
                <p id="fuel-km-hint" className="text-xs text-muted-foreground">
                  Compteur affiché lors du plein : il est contrôlé comme un relevé. Sans compteur validé, le plein ne sert pas au calcul de consommation.
                </p>
                <FieldError errors={errors} name="odometerKm" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="fuel-liters">Litres *</Label>
                <Input id="fuel-liters" inputMode="decimal" autoComplete="off" value={draft.liters} onChange={(e) => update({ liters: e.target.value })} aria-invalid={invalid(errors, 'liters')} aria-describedby={describedBy(errors, 'liters')} />
                <FieldError errors={errors} name="liters" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fuel-unit-price">Prix unitaire TTC ({session.currency})</Label>
                <Input id="fuel-unit-price" inputMode="decimal" autoComplete="off" value={draft.unitPrice} onChange={(e) => update({ unitPrice: e.target.value })} aria-invalid={invalid(errors, 'unitPrice')} aria-describedby={describedBy(errors, 'unitPrice', 'fuel-unit-price-hint')} />
                <p id="fuel-unit-price-hint" className="text-xs text-muted-foreground">
                  Facultatif : permet au serveur de signaler un écart avec le total.
                </p>
                <FieldError errors={errors} name="unitPrice" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fuel-total">Montant total TTC ({session.currency}) *</Label>
                <Input id="fuel-total" inputMode="decimal" autoComplete="off" value={draft.totalAmount} onChange={(e) => update({ totalAmount: e.target.value })} aria-invalid={invalid(errors, 'totalAmount')} aria-describedby={describedBy(errors, 'totalAmount', 'fuel-total-hint')} />
                <p id="fuel-total-hint" className="text-xs text-muted-foreground">
                  Montant du ticket, jamais recalculé.
                </p>
                <FieldError errors={errors} name="totalAmount" />
              </div>
            </div>

            <FullTankField idPrefix="fuel-full" value={draft.isFullTank} onChange={(v) => update({ isFullTank: v })} errors={errors} />

            <div className="grid gap-4 sm:grid-cols-2">
              <EnergySelect id="fuel-energy" value={draft.energy} onChange={(v) => update({ energy: v })} vehicleEnergy={selected?.energy ?? null} errors={errors} />
              <SupplierSelect id="fuel-supplier" companyId={selected?.companyId ?? null} value={draft.supplierId} onChange={(v) => update({ supplierId: v })} errors={errors} />
            </div>

            <DriverSelect id="fuel-driver" companyId={selected?.companyId ?? null} value={draft.driverId} onChange={(v) => update({ driverId: v })} errors={errors} />

            {selected ? (
              <AttachmentField
                id="fuel-ticket"
                label="Ticket (photo ou PDF)"
                hint="Justificatif privé, joint au plein et à sa dépense. JPEG, PNG ou PDF, 10 Mo au plus ; les photos sont réduites avant l’envoi."
                companyId={selected.companyId}
                accept="image/*,application/pdf"
                capture
                value={draft.ticket}
                onChange={(ticket) => update({ ticket })}
                errors={errors}
                errorName="ticketAttachmentId"
              />
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium">Ticket (photo ou PDF)</p>
                <p className="text-xs text-muted-foreground">Choisissez d’abord le véhicule : le ticket est rattaché à sa société.</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="fuel-notes">Remarques</Label>
              <Textarea id="fuel-notes" rows={2} maxLength={2000} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} aria-invalid={invalid(errors, 'notes')} aria-describedby={describedBy(errors, 'notes')} />
              <FieldError errors={errors} name="notes" />
            </div>

            {submit.error ? (
              <ApiErrorAlert error={submit.error}>
                {isApiError(submit.error) && (submit.error.status === 0 || submit.error.status >= 500) ? <p className="mt-1 text-muted-foreground">Votre saisie est conservée. Le nouvel envoi réutilise la même clé : aucun doublon ne sera créé.</p> : null}
                {bodyMismatch ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-muted-foreground">Ce formulaire a déjà servi à enregistrer un plein : vérifiez la liste des pleins avant de recommencer.</p>
                    <Button type="button" variant="outline" size="sm" onClick={restart}>
                      Recommencer une nouvelle saisie
                    </Button>
                  </div>
                ) : null}
              </ApiErrorAlert>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={submit.isPending}>
                {submit.isPending ? 'Enregistrement…' : 'Enregistrer le plein'}
              </Button>
              <Button variant="outline" asChild>
                <Link href="/carburant">Annuler</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
