'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { isApiError } from '@/lib/api-error';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ConsumptionReason, ConsumptionView, FuelEntryView, FuelPurchaseGapView } from '@/lib/fuel-types';
import { isCivilDate, localInputToIso } from '@/lib/zoned-time';
import { FuelAnomalyBadges, FuelStatusBadge, energyLabel, formatConsumption, formatFuelLiters, useFuelRights, useMoney } from '../../carburant/fuel-display';

/**
 * Onglet « Carburant » du dossier véhicule (CDC 3.2, 8.2, 8.3, D-227, D-228) : pleins du véhicule tels que
 * renvoyés par l'API (statut, anomalies, montants seulement avec costs.read), estimation L/100 km calculée
 * par l'API entre pleins complets admissibles, intervalles retenus et exclus avec leurs motifs, N/D jamais
 * remplacé par un chiffre ; périodes « achats incomplets » et leur déclaration (chef, administrateur).
 */
export function ConsumptionPanel({ vehicleId, companyId }: { vehicleId: string; companyId: string }) {
  const { session } = useAppScope();
  const rights = useFuelRights(companyId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = toQuery({ from: from && isCivilDate(from) ? from : undefined, to: to && isCivilDate(to) ? to : undefined });
  const consumption = useQuery({ queryKey: ['vehicle', vehicleId, 'consumption', query], queryFn: () => api<ConsumptionView>(`/vehicles/${vehicleId}/consumption${query}`) });
  const gaps = useQuery({ queryKey: ['vehicle', vehicleId, 'fuel-purchase-gaps'], queryFn: () => api<FuelPurchaseGapView[]>(`/vehicles/${vehicleId}/fuel-purchase-gaps`) });
  const [gapFormOpen, setGapFormOpen] = useState(false);

  return (
    <div className="space-y-4">
      <VehicleFuelEntries vehicleId={vehicleId} canCreate={rights.write} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Consommation estimée</CardTitle>
          <CardDescription>{consumption.data?.nature ?? 'Estimation fondée sur les pleins saisis.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="consumption-from" className="text-xs text-muted-foreground">
                Du
              </Label>
              <Input id="consumption-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-44" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="consumption-to" className="text-xs text-muted-foreground">
                Au
              </Label>
              <Input id="consumption-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-44" />
            </div>
            {from || to ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
              >
                Tout l’historique
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">Période en dates locales ({session.timezone}) : intervalles dont le plein de fin tombe dans la période.</p>

          {consumption.isPending ? (
            <LoadingState label="Calcul de la consommation…" />
          ) : consumption.isError ? (
            <ErrorState error={consumption.error} retry={() => void consumption.refetch()} />
          ) : (
            <ConsumptionResult data={consumption.data} timezone={session.timezone} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Périodes « achats incomplets »</CardTitle>
          <CardDescription>Périodes pendant lesquelles tous les achats de carburant n’ont pas été saisis (carte perdue, tickets non remis) : les intervalles qui les recoupent sont N/D.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {gaps.isPending ? (
            <LoadingState label="Chargement des périodes…" />
          ) : gaps.isError ? (
            <ErrorState error={gaps.error} retry={() => void gaps.refetch()} />
          ) : gaps.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune période déclarée.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {gaps.data.map((g) => (
                <li key={g.id} className="rounded-md border p-3">
                  <p className="font-medium">
                    Du {formatDateTime(g.startsAt, session.timezone)} au {formatDateTime(g.endsAt, session.timezone)}
                  </p>
                  <p>{g.reason}</p>
                  <p className="text-xs text-muted-foreground">Déclarée le {formatDateTime(g.createdAt, session.timezone)}</p>
                </li>
              ))}
            </ul>
          )}
          {rights.manager ? (
            gapFormOpen ? (
              <GapForm vehicleId={vehicleId} onClose={() => setGapFormOpen(false)} />
            ) : (
              <Button type="button" variant="outline" onClick={() => setGapFormOpen(true)}>
                Déclarer une période « achats incomplets »
              </Button>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** Pleins du véhicule (GET /fuel-entries?vehicleId=), du plus récent au plus ancien ; détail sur /carburant/:id. */
function VehicleFuelEntries({ vehicleId, canCreate }: { vehicleId: string; canCreate: boolean }) {
  const { session } = useAppScope();
  const money = useMoney();
  const [page, setPage] = useState(1);
  const query = toQuery({ vehicleId, page, pageSize: 10 });
  const entries = useQuery({ queryKey: ['fuel-entries', query], queryFn: () => api<Page<FuelEntryView>>(`/fuel-entries${query}`) });
  const items = entries.data?.items ?? [];
  const showAmounts = items.some((e) => e.totalAmount !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pleins du véhicule</CardTitle>
        <CardDescription>Pleins saisis par le personnel et tickets soumis par les conducteurs, avec leur statut et les anomalies signalées par le serveur.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/carburant?vehicule=${encodeURIComponent(vehicleId)}`}>Tous les pleins du véhicule</Link>
          </Button>
          {canCreate ? (
            <Button size="sm" asChild>
              <Link href={`/carburant/nouveau?vehicule=${encodeURIComponent(vehicleId)}`}>Saisir un plein</Link>
            </Button>
          ) : null}
        </div>
        {entries.isPending ? (
          <LoadingState label="Chargement des pleins…" />
        ) : entries.isError ? (
          <ErrorState error={entries.error} retry={() => void entries.refetch()} />
        ) : entries.data.total === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun plein enregistré pour ce véhicule.</p>
        ) : (
          <div className="rounded-md border">
            <Table aria-label="Pleins du véhicule">
              <TableHeader>
                <TableRow>
                  <TableHead>Date du plein</TableHead>
                  <TableHead className="text-right">Litres</TableHead>
                  {showAmounts ? <TableHead className="text-right">Montant</TableHead> : null}
                  <TableHead className="hidden md:table-cell">Compteur</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="hidden sm:table-cell">Anomalies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/carburant/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                        {formatDateTime(e.filledAt, session.timezone)}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {energyLabel(e.energy)} · {e.isFullTank ? 'plein complet' : 'plein partiel'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatFuelLiters(e.liters)}</TableCell>
                    {showAmounts ? <TableCell className="text-right whitespace-nowrap">{e.totalAmount === null ? <span className="text-muted-foreground">Non communiqué</span> : money(e.totalAmount)}</TableCell> : null}
                    <TableCell className="hidden md:table-cell whitespace-nowrap">{e.declaredPhysicalKm ? formatKm(e.declaredPhysicalKm) : '—'}</TableCell>
                    <TableCell>
                      <FuelStatusBadge status={e.status} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <FuelAnomalyBadges entry={e} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls page={entries.data.page} pageSize={entries.data.pageSize} total={entries.data.total} onPageChange={setPage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Reasons({ reasons }: { reasons: ConsumptionReason[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {reasons.map((r) => (
        <li key={r.code}>{r.label}</li>
      ))}
    </ul>
  );
}

function ConsumptionResult({ data, timezone }: { data: ConsumptionView; timezone: string }) {
  if (data.totals.length === 0) {
    return (
      <EmptyState title="Consommation N/D" description={data.reasons.map((r) => r.label).join(' ') || 'Aucun plein exploitable pour cette période.'} />
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.totals.map((t) => (
          <div key={t.energy} className="rounded-md border p-3 text-sm">
            <p className="text-muted-foreground">{energyLabel(t.energy)}</p>
            <p className="text-2xl font-semibold">{t.available ? formatConsumption(t.litersPer100Km, data.unit) : 'N/D'}</p>
            {t.available ? (
              <p className="text-muted-foreground">
                {formatFuelLiters(t.liters)} sur {formatKm(t.distanceKm)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Intervalles retenus : {t.retainedIntervals} · exclus : {t.excludedIntervals}
            </p>
            {!t.available ? (
              <div className="mt-2">
                <p className="font-medium">Motif :</p>
                <Reasons reasons={t.reasons} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {!data.available && data.reasons.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="font-medium">Consommation N/D</p>
          <Reasons reasons={data.reasons} />
        </div>
      ) : null}

      <div className="rounded-md border">
        <Table aria-label="Intervalles de consommation">
          <TableHeader>
            <TableRow>
              <TableHead>Intervalle (plein complet A → B)</TableHead>
              <TableHead className="hidden md:table-cell">Carburant</TableHead>
              <TableHead className="text-right">Distance</TableHead>
              <TableHead className="text-right">Litres</TableHead>
              <TableHead className="text-right">Consommation</TableHead>
              <TableHead>Retenu</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.intervals.map((i) => (
              <TableRow key={`${i.energy}-${i.endFuelEntryId}`}>
                <TableCell className="text-sm">
                  <span className="block whitespace-nowrap">
                    {i.startFilledAt && i.startFuelEntryId ? (
                      <Link href={`/carburant/${i.startFuelEntryId}`} className="underline-offset-4 hover:underline">
                        {formatDateTime(i.startFilledAt, timezone)}
                      </Link>
                    ) : (
                      'Aucune référence'
                    )}{' '}
                    →{' '}
                    <Link href={`/carburant/${i.endFuelEntryId}`} className="underline-offset-4 hover:underline">
                      {formatDateTime(i.endFilledAt, timezone)}
                    </Link>
                  </span>
                  {i.startKm || i.endKm ? (
                    <span className="block text-xs text-muted-foreground">
                      {formatKm(i.startKm)} → {formatKm(i.endKm)}
                    </span>
                  ) : null}
                  {!i.retained ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <Reasons reasons={i.reasons} />
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="hidden md:table-cell">{energyLabel(i.energy)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{formatKm(i.distanceKm)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{formatFuelLiters(i.liters)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{i.retained ? formatConsumption(i.litersPer100Km, data.unit) : 'N/D'}</TableCell>
                <TableCell>{i.retained ? <StatusBadge label="Retenu" tone="success" /> : <StatusBadge label="Exclu" tone="neutral" />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Déclaration motivée d'une période « achats incomplets » (POST /vehicles/:id/fuel-purchase-gaps). */
function GapForm({ vehicleId, onClose }: { vehicleId: string; onClose: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<FuelPurchaseGapView>(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Période « achats incomplets » déclarée.');
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'fuel-purchase-gaps'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId, 'consumption'] });
      onClose();
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Déclaration non enregistrée.'),
  });
  const errors = { ...errorsOf(create.error), ...local };

  return (
    <form
      className="space-y-4 rounded-md border p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const next: FieldErrors = {};
        const startIso = localInputToIso(startsAt, session.timezone);
        const endIso = localInputToIso(endsAt, session.timezone);
        if (!startIso) next.startsAt = ['Indiquez le début de la période.'];
        if (!endIso) next.endsAt = ['Indiquez la fin de la période.'];
        if (reason.trim().length < 3) next.reason = ['Indiquez le motif (3 caractères au moins).'];
        setLocal(next);
        if (Object.keys(next).length > 0) return;
        create.mutate({ startsAt: startIso, endsAt: endIso, reason: reason.trim() });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gap-starts-at">Début *</Label>
          <Input id="gap-starts-at" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-invalid={invalid(errors, 'startsAt')} aria-describedby={describedBy(errors, 'startsAt')} />
          <FieldError errors={errors} name="startsAt" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gap-ends-at">Fin *</Label>
          <Input id="gap-ends-at" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={invalid(errors, 'endsAt')} aria-describedby={describedBy(errors, 'endsAt')} />
          <FieldError errors={errors} name="endsAt" />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="gap-reason">Motif *</Label>
        <Textarea id="gap-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. carte carburant perdue, tickets non remis" aria-invalid={invalid(errors, 'reason')} aria-describedby={describedBy(errors, 'reason')} />
        <FieldError errors={errors} name="reason" />
      </div>
      {create.error ? <ApiErrorAlert error={create.error} /> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Enregistrement…' : 'Déclarer la période'}
        </Button>
        <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
