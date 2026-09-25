'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { FUEL_EVENT_TYPE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { SimulatorBadge, formatPercentValue, useCompanyCodes } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime, formatLiters } from '@/lib/format';
import {
  FUEL_EVENT_QUALIFICATION_HELP,
  FUEL_EVENT_QUALIFICATION_LABELS,
  FUEL_EVENT_STATUS_LABELS,
  type FuelEventQualification,
  type FuelEventView,
} from '@/lib/telemetry-types';
import { useListParams } from '@/lib/use-list-params';
import { useManagedCompanies } from './mapping-fields';

const ALL = '__all__';
const QUALIFICATIONS: readonly FuelEventQualification[] = ['JUSTIFIE', 'ANOMALIE_CONFIRMEE', 'ERREUR_CAPTEUR'];

/** Résultat du rapprochement avec les pleins saisis, tel qu'enregistré par l'API (details.rapprochement). */
function matchLabel(details: Record<string, unknown> | null): string | null {
  const r = details?.['rapprochement'];
  if (!r || typeof r !== 'object') return null;
  const m = r as Record<string, unknown>;
  const hours = typeof m['fenetreHeures'] === 'number' ? m['fenetreHeures'] : null;
  const gap = typeof m['ecartLitres'] === 'string' ? formatLiters(m['ecartLitres']) : null;
  switch (m['resultat']) {
    case 'RAPPROCHE':
      return `Rapproché d’un plein saisi${gap ? ` (écart ${gap})` : ''}.`;
    case 'ECART_LITRES':
      return `Écart de ${gap ?? '—'} avec le plein le plus proche, au-delà de la tolérance.`;
    case 'ABSENCE_TICKET':
      return `Aucun plein saisi dans la fenêtre${hours !== null ? ` de ${hours} h` : ''}.`;
    default:
      return null;
  }
}

/**
 * Événements carburant dérivés (CDC 8.5 ; D-112, D-240, D-242 ; T43) : remplissage détecté, baisse
 * anormale à l'arrêt et écart remplissage / ticket, à qualifier par le chef de parc avec une note.
 * Aucune dépense, responsabilité ni retenue n'est jamais déduite.
 */
export function FuelEventsTab() {
  const { companyId, session } = useAppScope();
  const companyCode = useCompanyCodes();
  const { canManage } = useManagedCompanies();
  const { get, set, page } = useListParams();
  const status = get('statut', 'A_QUALIFIER');
  const type = get('type');
  // Événement ouvert depuis le lien d'une alerte carburant (/telematique/carburant?evenement=…).
  const focusId = get('evenement');
  // Véhicule choisi depuis les pages carburant ou la fiche véhicule (/telematique?onglet=carburant&vehicule=…).
  const vehicleId = get('vehicule');
  const query = toQuery({ companyId, vehicleId, status: status === ALL ? undefined : status, type, page, pageSize: 25 });
  const events = useQuery({ queryKey: ['telemetry', 'fuel-events', query], queryFn: () => api<Page<FuelEventView>>(`/telemetry/fuel-events${query}`) });
  const focused = useQuery({ queryKey: ['telemetry', 'fuel-events', 'evenement', focusId], queryFn: () => api<FuelEventView>(`/telemetry/fuel-events/${focusId}`), enabled: focusId !== '' });
  const [qualifying, setQualifying] = useState<FuelEventView | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Anomalies à qualifier, jamais des dépenses. Un remplissage rapproché d’un plein saisi est justifié automatiquement ; la consommation officielle reste calculée sur les pleins validés.
      </p>
      {focusId ? (
        <section aria-labelledby="focused-event-title" className="space-y-2 rounded-md border border-primary/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="focused-event-title" className="text-sm font-semibold">
              Événement signalé par l’alerte
            </h2>
            <Button variant="ghost" size="sm" onClick={() => set({ evenement: '' })}>
              Fermer
            </Button>
          </div>
          {focused.isPending ? (
            <LoadingState />
          ) : focused.isError ? (
            <ErrorState error={focused.error} retry={() => void focused.refetch()} />
          ) : (
            <FuelEventTable events={[focused.data]} timezone={session.timezone} showCompany={companyId === null} companyCode={companyCode} canManage={canManage} onQualify={setQualifying} />
          )}
        </section>
      ) : null}
      {vehicleId ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <p>
            Événements du véhicule{' '}
            {events.data?.items[0] ? (
              <Link href={`/vehicules/${vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                {events.data.items[0].vehicleCode} · {events.data.items[0].vehicleRegistration}
              </Link>
            ) : (
              'sélectionné'
            )}
            .
          </p>
          <Button variant="ghost" size="sm" onClick={() => set({ vehicule: '' })}>
            Tous les véhicules
          </Button>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Select value={status} onValueChange={(v) => set({ statut: v })}>
          <SelectTrigger aria-label="Statut">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="A_QUALIFIER">À qualifier</SelectItem>
            <SelectItem value="QUALIFIE">Qualifiés</SelectItem>
            <SelectItem value={ALL}>Tous</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type || ALL} onValueChange={(v) => set({ type: v === ALL ? '' : v })}>
          <SelectTrigger aria-label="Type d’événement">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les types</SelectItem>
            {Object.entries(FUEL_EVENT_TYPE_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {events.isPending ? (
        <LoadingState />
      ) : events.isError ? (
        <ErrorState error={events.error} retry={() => void events.refetch()} />
      ) : events.data.total === 0 ? (
        <EmptyState title="Aucun événement carburant" description={status === 'A_QUALIFIER' ? 'Aucune anomalie carburant à qualifier dans votre périmètre.' : 'Aucun événement ne correspond aux filtres.'} />
      ) : (
        <div className="rounded-md border">
          <FuelEventTable events={events.data.items} timezone={session.timezone} showCompany={companyId === null} companyCode={companyCode} canManage={canManage} onQualify={setQualifying} />
          <PaginationControls page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPageChange={(p) => set({ page: p })} />
        </div>
      )}
      {qualifying ? <QualifyDialog event={qualifying} onClose={() => setQualifying(null)} /> : null}
    </div>
  );
}

function FuelEventTable({
  events,
  timezone,
  showCompany,
  companyCode,
  canManage,
  onQualify,
}: {
  events: readonly FuelEventView[];
  timezone: string;
  showCompany: boolean;
  companyCode: (id: string) => string;
  canManage: (companyId: string | null | undefined) => boolean;
  onQualify: (event: FuelEventView) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Détecté le</TableHead>
          <TableHead>Véhicule</TableHead>
          <TableHead>Événement</TableHead>
          <TableHead>Variation</TableHead>
          <TableHead className="hidden lg:table-cell">Rapprochement</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const variation = [e.litersDelta !== null ? formatLiters(e.litersDelta) : null, formatPercentValue(e.percentDelta)].filter(Boolean).join(' · ');
          return (
            <TableRow key={e.id}>
              <TableCell className="whitespace-normal">
                {formatDateTime(e.detectedAt, timezone)}
                <span className="block text-xs text-muted-foreground">
                  fenêtre {formatDateTime(e.windowStart, timezone)} → {formatDateTime(e.windowEnd, timezone)}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">
                <Link href={`/vehicules/${e.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                  {e.vehicleCode}
                </Link>{' '}
                · {e.vehicleRegistration}
                {showCompany ? <span className="block text-xs text-muted-foreground">{companyCode(e.companyId)}</span> : null}
              </TableCell>
              <TableCell className="whitespace-normal">
                {e.typeLabel}
                <span className="block text-xs text-muted-foreground">Mesure : {e.measureKindLabel}</span>
                {e.isSimulator ? <SimulatorBadge className="mt-1" /> : null}
              </TableCell>
              <TableCell>{variation || '—'}</TableCell>
              <TableCell className="hidden max-w-xs whitespace-normal text-xs lg:table-cell">{matchLabel(e.details) ?? '—'}</TableCell>
              <TableCell className="whitespace-normal">
                <StatusBadge label={e.qualification ? FUEL_EVENT_QUALIFICATION_LABELS[e.qualification] : FUEL_EVENT_STATUS_LABELS[e.status]} tone={e.status === 'A_QUALIFIER' ? 'warning' : e.qualification === 'ANOMALIE_CONFIRMEE' ? 'danger' : 'neutral'} />
                {e.status === 'QUALIFIE' ? (
                  <span className="block text-xs text-muted-foreground">
                    {e.qualifiedById ? `le ${formatDateTime(e.qualifiedAt, timezone)}` : 'automatiquement (plein rapproché)'}
                    {e.qualificationNote ? ` — ${e.qualificationNote}` : ''}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right">
                {e.status === 'A_QUALIFIER' && canManage(e.companyId) ? (
                  <Button size="sm" onClick={() => onQualify(e)} aria-label={`Qualifier l’événement ${e.typeLabel} de ${e.vehicleCode}`}>
                    Qualifier
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function QualifyDialog({ event, onClose }: { event: FuelEventView; onClose: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const [qualification, setQualification] = useState<FuelEventQualification | ''>('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const mutation = useMutation({
    mutationFn: () => api<FuelEventView>(`/telemetry/fuel-events/${event.id}/qualify`, { method: 'POST', body: { qualification, note: note.trim(), expectedVersion: event.version } }),
    onSuccess: (saved) => {
      toast.success(`Événement qualifié : ${saved.qualification ? FUEL_EVENT_QUALIFICATION_LABELS[saved.qualification] : ''}. Aucune dépense créée.`);
      void queryClient.invalidateQueries({ queryKey: ['telemetry', 'fuel-events'] });
      onClose();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Qualification impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      toast.error(error.message);
      if (error.status === 409 || error.status === 422) void queryClient.invalidateQueries({ queryKey: ['telemetry', 'fuel-events'] });
      if (error.status === 409) onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Qualifier : {event.typeLabel}</DialogTitle>
          <DialogDescription>
            {event.vehicleCode} · détecté le {formatDateTime(event.detectedAt, session.timezone)} · mesure {event.measureKindLabel}. La qualification est auditée ; elle ne crée ni dépense, ni responsabilité, ni retenue.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            mutation.mutate();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Qualification *</legend>
            <RadioGroup value={qualification} onValueChange={(v) => setQualification(v as FuelEventQualification)} aria-label="Qualification" className="gap-2">
              {QUALIFICATIONS.map((q) => (
                <div key={q} className="flex items-start gap-2">
                  <RadioGroupItem id={`qualify-${q}`} value={q} className="mt-0.5" />
                  <div>
                    <Label htmlFor={`qualify-${q}`} className="font-normal">
                      {FUEL_EVENT_QUALIFICATION_LABELS[q]}
                    </Label>
                    <p className="text-xs text-muted-foreground">{FUEL_EVENT_QUALIFICATION_HELP[q]}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
            <FieldError errors={fieldErrors} name="qualification" />
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="qualify-note">Note *</Label>
            <Textarea id="qualify-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={fieldErrors.note ? true : undefined} aria-describedby="note-error" />
            <FieldError errors={fieldErrors} name="note" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={mutation.isPending || qualification === '' || note.trim().length < 3}>
              {mutation.isPending ? 'Enregistrement…' : 'Qualifier'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
