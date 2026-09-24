'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { NONE, type FieldErrors, describedBy, errorsOf, invalid, useOpsRights } from '@/components/incidents/ops-helpers';
import { PhotoUploader, type UploadedPhoto } from '@/components/incidents/photo-uploader';
import { useAppScope } from '@/components/layout/session-context';
import { MaintenanceVehiclePicker } from '@/components/maintenance/vehicle-picker';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { DriverSummary, IncidentSeverity, IncidentType, IncidentView } from '@/lib/incidents-types';
import type { UsageView } from '@/lib/usages-types';
import type { SiteView, VehicleView } from '@/lib/vehicles-types';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { FollowUpField } from '../follow-up-field';

/** Gravité laissée au serveur : il applique sa valeur par défaut selon le type. */
const AUTO = '__defaut__';
const FREE = '__libre__';

interface Draft {
  vehicleId: string;
  type: IncidentType | '';
  severity: IncidentSeverity | typeof AUTO;
  occurredAt: string;
  siteId: string;
  locationLabel: string;
  description: string;
  driverId: string;
  usageId: string;
  followUpUserId: string;
  photos: UploadedPhoto[];
}

/**
 * Déclaration d'un incident par le personnel (CDC 7.3, POST /incidents) : véhicule, type, gravité
 * (défaut du serveur si non choisie), date du fait, lieu libre ou site, description, conducteur et
 * utilisation facultatifs, responsable du suivi et photos.
 */
export function DeclareIncident() {
  const { session, companyId } = useAppScope();
  const rights = useOpsRights(companyId);
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => ({
    vehicleId: params.get('vehicule') ?? '',
    type: '',
    severity: AUTO,
    occurredAt: nowLocalInput(session.timezone),
    siteId: FREE,
    locationLabel: '',
    description: '',
    driverId: NONE,
    usageId: NONE,
    followUpUserId: NONE,
    photos: [],
  }));
  const [local, setLocal] = useState<FieldErrors>({});
  // Une clé d'idempotence par formulaire ouvert (D-308) : un nouvel envoi après une coupure ne crée pas de doublon.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const vehicle = useQuery({ queryKey: ['vehicle', draft.vehicleId, 'view'], queryFn: () => api<VehicleView>(`/vehicles/${draft.vehicleId}`), enabled: Boolean(draft.vehicleId) });
  const vehicleCompanyId = vehicle.data?.companyId ?? null;
  const sites = useQuery({
    queryKey: ['sites', 'actifs', vehicleCompanyId],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: vehicleCompanyId, status: 'ACTIF', pageSize: 100 })}`),
    enabled: Boolean(vehicleCompanyId),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'summaries', vehicleCompanyId],
    queryFn: () => api<DriverSummary[]>(`/drivers/summaries${toQuery({ companyId: vehicleCompanyId })}`),
    enabled: Boolean(vehicleCompanyId),
  });
  const usages = useQuery({
    queryKey: ['usages', 'vehicle', draft.vehicleId, 'recent'],
    queryFn: () => api<Page<UsageView>>(`/usages${toQuery({ vehicleId: draft.vehicleId, pageSize: 20 })}`),
    enabled: Boolean(draft.vehicleId),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentView>('/incidents', { method: 'POST', body, idempotencyKey }),
    onSuccess: (created) => {
      toast.success(`Incident ${created.reference} déclaré.`);
      queryClient.setQueryData(['incident', created.id], created);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['vehicle', created.vehicleId] });
      router.push(`/incidents/${created.id}`);
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Déclaration impossible.'),
  });

  if (!rights.operational) {
    return (
      <div>
        <PageHeader title="Déclarer un incident" />
        <EmptyState title="Action non autorisée" description="La déclaration d’un incident par le personnel est réservée aux opérateurs, chefs de parc et administrateurs. Un conducteur signale un problème depuis « Mon véhicule »." />
      </div>
    );
  }

  const errors: FieldErrors = { ...errorsOf(create.error), ...local };

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    const occurredIso = localInputToIso(draft.occurredAt, session.timezone);
    if (!draft.vehicleId) next.vehicleId = ['Choisissez le véhicule.'];
    if (!draft.type) next.type = ['Choisissez le type d’incident.'];
    if (!occurredIso) next.occurredAt = ['Indiquez la date et l’heure du fait.'];
    if (draft.description.trim().length < 5) next.description = ['Décrivez l’incident (5 caractères au moins).'];
    setLocal(next);
    if (Object.keys(next).length > 0) return;
    create.mutate({
      vehicleId: draft.vehicleId,
      type: draft.type,
      severity: draft.severity === AUTO ? undefined : draft.severity,
      occurredAt: occurredIso ?? undefined,
      siteId: draft.siteId !== FREE ? draft.siteId : undefined,
      locationLabel: draft.siteId === FREE && draft.locationLabel.trim() ? draft.locationLabel.trim() : undefined,
      description: draft.description.trim(),
      driverId: draft.driverId !== NONE ? draft.driverId : undefined,
      usageId: draft.usageId !== NONE ? draft.usageId : undefined,
      followUpUserId: draft.followUpUserId !== NONE ? draft.followUpUserId : undefined,
      photoAttachmentIds: draft.photos.length > 0 ? draft.photos.map((p) => p.id) : undefined,
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Déclarer un incident" description="Le dossier est créé au statut « Ouvert ». Une contravention reste une information de suivi : aucune responsabilité n’est déduite automatiquement." />
      <Card>
        <CardContent>
          <form className="grid gap-5 sm:grid-cols-2" noValidate onSubmit={onSubmit}>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="incident-vehicle">Véhicule *</Label>
              <MaintenanceVehiclePicker
                id="incident-vehicle"
                value={draft.vehicleId}
                companyId={companyId}
                onChange={(v) => update({ vehicleId: v?.id ?? '', siteId: FREE, driverId: NONE, usageId: NONE, followUpUserId: NONE })}
                invalid={Boolean(errors.vehicleId?.length)}
                describedBy={describedBy(errors, 'vehicleId')}
              />
              <FieldError errors={errors} name="vehicleId" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="incident-type">Type *</Label>
              <Select value={draft.type} onValueChange={(v) => update({ type: v as IncidentType })}>
                <SelectTrigger id="incident-type" className="w-full" aria-invalid={invalid(errors, 'type')} aria-describedby={describedBy(errors, 'type')}>
                  <SelectValue placeholder="Choisir un type" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(INCIDENT_TYPE_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="type" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="incident-severity">Gravité</Label>
              <Select value={draft.severity} onValueChange={(v) => update({ severity: v as Draft['severity'] })}>
                <SelectTrigger id="incident-severity" className="w-full" aria-invalid={invalid(errors, 'severity')} aria-describedby={describedBy(errors, 'severity', 'incident-severity-hint')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>Gravité par défaut (proposée par le serveur)</SelectItem>
                  {Object.entries(INCIDENT_SEVERITY_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="incident-severity-hint" className="text-xs text-muted-foreground">
                Sans choix, le serveur applique la gravité par défaut du type. Un incident critique non pris en charge déclenche une alerte.
              </p>
              <FieldError errors={errors} name="severity" />
            </div>

            {draft.type === 'CONTRAVENTION' ? (
              <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm sm:col-span-2">
                Contravention : l’utilisation en cours à l’instant déclaré sera affichée sur la fiche à titre d’information. Le lien avec un conducteur ne se pose que par une action explicite du chef de parc.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="incident-occurred">Date et heure du fait *</Label>
              <Input
                id="incident-occurred"
                type="datetime-local"
                value={draft.occurredAt}
                onChange={(e) => update({ occurredAt: e.target.value })}
                aria-invalid={invalid(errors, 'occurredAt')}
                aria-describedby={describedBy(errors, 'occurredAt', 'incident-occurred-hint')}
              />
              <p id="incident-occurred-hint" className="text-xs text-muted-foreground">
                Fuseau de l’organisation ({session.timezone}). Une date future est refusée.
              </p>
              <FieldError errors={errors} name="occurredAt" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="incident-site">Lieu déclaré</Label>
              <Select value={draft.siteId} onValueChange={(v) => update({ siteId: v })} disabled={!vehicleCompanyId}>
                <SelectTrigger id="incident-site" className="w-full" aria-invalid={invalid(errors, 'siteId')} aria-describedby={describedBy(errors, 'siteId')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FREE}>Lieu libre</SelectItem>
                  {(sites.data?.items ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      Site : {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="siteId" />
            </div>

            {draft.siteId === FREE ? (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="incident-location">Lieu (texte libre)</Label>
                <Input
                  id="incident-location"
                  maxLength={200}
                  value={draft.locationLabel}
                  onChange={(e) => update({ locationLabel: e.target.value })}
                  placeholder="Ex. autoroute A1 sortie 12, parking client"
                  aria-invalid={invalid(errors, 'locationLabel')}
                  aria-describedby={describedBy(errors, 'locationLabel')}
                />
                <FieldError errors={errors} name="locationLabel" />
              </div>
            ) : null}

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="incident-description">Description *</Label>
              <Textarea
                id="incident-description"
                rows={4}
                maxLength={4000}
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
                aria-invalid={invalid(errors, 'description')}
                aria-describedby={describedBy(errors, 'description')}
              />
              <FieldError errors={errors} name="description" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="incident-usage">Utilisation concernée</Label>
              <Select value={draft.usageId} onValueChange={(v) => update({ usageId: v })} disabled={!draft.vehicleId}>
                <SelectTrigger id="incident-usage" className="w-full" aria-invalid={invalid(errors, 'usageId')} aria-describedby={describedBy(errors, 'usageId', 'incident-usage-hint')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Aucune (facultatif)</SelectItem>
                  {(usages.data?.items ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.driverName} · {formatDateTime(u.checkedOutAt, session.timezone)} → {u.returnedAt ? formatDateTime(u.returnedAt, session.timezone) : 'en cours'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="incident-usage-hint" className="text-xs text-muted-foreground">
                Dernières utilisations du véhicule. Sans conducteur choisi, celui de l’utilisation est repris.
              </p>
              <FieldError errors={errors} name="usageId" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="incident-driver">Conducteur concerné</Label>
              <Select value={draft.driverId} onValueChange={(v) => update({ driverId: v })} disabled={!vehicleCompanyId}>
                <SelectTrigger id="incident-driver" className="w-full" aria-invalid={invalid(errors, 'driverId')} aria-describedby={describedBy(errors, 'driverId')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Aucun (facultatif)</SelectItem>
                  {(drivers.data ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.lastName} {d.firstName} · {d.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} name="driverId" />
            </div>

            <div className="sm:col-span-2">
              <FollowUpField id="incident-follow-up" companyId={vehicleCompanyId} value={draft.followUpUserId} onChange={(v) => update({ followUpUserId: v })} errors={errors} />
            </div>

            <div className="sm:col-span-2">
              <PhotoUploader
                id="incident-photos"
                label="Photos"
                companyId={vehicleCompanyId}
                photos={draft.photos}
                onChange={(photos) => update({ photos })}
                errors={errors}
                disabledReason="Choisissez d’abord le véhicule pour joindre des photos."
              />
            </div>

            {create.error ? (
              <div className="sm:col-span-2">
                <ApiErrorAlert error={create.error} />
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Enregistrement…' : 'Déclarer l’incident'}
              </Button>
              <Button variant="outline" asChild>
                <Link href="/incidents">Annuler</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
