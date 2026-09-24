'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { NONE, type FieldErrors, describedBy, errorsOf, invalid, useOpsRights } from '@/components/incidents/ops-helpers';
import { PhotoUploader, type UploadedPhoto } from '@/components/incidents/photo-uploader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DriverSummary, IncidentSeverity, IncidentType, IncidentView } from '@/lib/incidents-types';
import type { SiteView } from '@/lib/vehicles-types';
import { FollowUpField } from '../follow-up-field';
import { useIncidentCache } from './incident-cache';

const FREE = '__libre__';

interface FormState {
  type: IncidentType;
  severity: IncidentSeverity;
  description: string;
  siteId: string;
  locationLabel: string;
  followUpUserId: string;
  driverId: string;
  photos: UploadedPhoto[];
}

function initial(i: IncidentView): FormState {
  return {
    type: i.type,
    severity: i.severity,
    description: i.description,
    siteId: i.siteId ?? FREE,
    locationLabel: i.locationLabel ?? '',
    followUpUserId: i.followUpUserId ?? NONE,
    driverId: i.driverId ?? NONE,
    photos: [],
  };
}

/**
 * Modification d'un incident (PATCH /incidents/:id, expectedVersion) : seuls les champs changés sont
 * envoyés. Requalification de la gravité et lien explicite avec un conducteur : chef de parc ou administrateur.
 */
export function EditIncidentDialog({ incident, onOpenChange }: { incident: IncidentView; onOpenChange: (open: boolean) => void }) {
  const rights = useOpsRights(incident.companyId);
  const cache = useIncidentCache(incident.id);
  const [start] = useState(() => initial(incident));
  const [form, setForm] = useState<FormState>(start);
  const [local, setLocal] = useState<FieldErrors>({});
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const sites = useQuery({
    queryKey: ['sites', 'actifs', incident.companyId],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: incident.companyId, status: 'ACTIF', pageSize: 100 })}`),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'summaries', incident.companyId],
    queryFn: () => api<DriverSummary[]>(`/drivers/summaries${toQuery({ companyId: incident.companyId })}`),
    enabled: rights.manager,
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentView>(`/incidents/${incident.id}`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      cache.saved(updated, `Incident ${updated.reference} mis à jour.`);
      onOpenChange(false);
    },
    onError: (error) => {
      if (cache.failed(error, 'Enregistrement impossible.')) onOpenChange(false);
    },
  });
  const errors = { ...errorsOf(save.error), ...local };
  const siteOptions = (sites.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }));
  if (incident.siteId && !siteOptions.some((s) => s.id === incident.siteId)) siteOptions.push({ id: incident.siteId, name: incident.siteName ? `${incident.siteName} (actuel)` : 'Site actuel' });
  const driverOptions = (drivers.data ?? []).map((d) => ({ id: d.id, label: `${d.lastName} ${d.firstName} · ${d.code}` }));
  if (incident.driverId && !driverOptions.some((d) => d.id === incident.driverId)) driverOptions.push({ id: incident.driverId, label: incident.driverName ?? 'Conducteur actuel' });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (form.description.trim().length < 5) next.description = ['Décrivez l’incident (5 caractères au moins).'];
    setLocal(next);
    if (Object.keys(next).length > 0) return;
    const body: Record<string, unknown> = {};
    if (form.type !== start.type) body.type = form.type;
    if (form.severity !== start.severity) body.severity = form.severity;
    if (form.description.trim() !== start.description.trim()) body.description = form.description.trim();
    const placeChanged = form.siteId !== start.siteId || (form.siteId === FREE && form.locationLabel.trim() !== start.locationLabel.trim());
    if (placeChanged) {
      body.siteId = form.siteId === FREE ? null : form.siteId;
      body.locationLabel = form.siteId === FREE ? form.locationLabel.trim() || null : null;
    }
    if (form.followUpUserId !== start.followUpUserId) body.followUpUserId = form.followUpUserId === NONE ? null : form.followUpUserId;
    if (form.driverId !== start.driverId) body.driverId = form.driverId === NONE ? null : form.driverId;
    if (form.photos.length > 0) body.photoAttachmentIds = form.photos.map((p) => p.id);
    if (Object.keys(body).length === 0) {
      toast.info('Aucune modification à enregistrer.');
      onOpenChange(false);
      return;
    }
    save.mutate({ ...body, expectedVersion: incident.version });
  }

  return (
    <Dialog open onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Modifier l’incident {incident.reference}</DialogTitle>
          <DialogDescription>Une version obsolète est refusée : la fiche est alors rechargée.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="edit-type">Type</Label>
            <Select value={form.type} onValueChange={(v) => update({ type: v as IncidentType })}>
              <SelectTrigger id="edit-type" className="w-full" aria-invalid={invalid(errors, 'type')} aria-describedby={describedBy(errors, 'type')}>
                <SelectValue />
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
            <Label htmlFor="edit-severity">Gravité</Label>
            <Select value={form.severity} onValueChange={(v) => update({ severity: v as IncidentSeverity })} disabled={!rights.manager}>
              <SelectTrigger id="edit-severity" className="w-full" aria-invalid={invalid(errors, 'severity')} aria-describedby={describedBy(errors, 'severity', 'edit-severity-hint')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INCIDENT_SEVERITY_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="edit-severity-hint" className="text-xs text-muted-foreground">
              {rights.manager ? 'Requalification de la gravité proposée à la déclaration.' : 'Requalification réservée au chef de parc ou à l’administrateur.'}
            </p>
            <FieldError errors={errors} name="severity" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="edit-description">Description *</Label>
            <Textarea id="edit-description" rows={4} maxLength={4000} value={form.description} onChange={(e) => update({ description: e.target.value })} aria-invalid={invalid(errors, 'description')} aria-describedby={describedBy(errors, 'description')} />
            <FieldError errors={errors} name="description" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-site">Lieu déclaré</Label>
            <Select value={form.siteId} onValueChange={(v) => update({ siteId: v })}>
              <SelectTrigger id="edit-site" className="w-full" aria-invalid={invalid(errors, 'siteId')} aria-describedby={describedBy(errors, 'siteId')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FREE}>Lieu libre</SelectItem>
                {siteOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    Site : {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={errors} name="siteId" />
          </div>
          {form.siteId === FREE ? (
            <div className="space-y-2">
              <Label htmlFor="edit-location">Lieu (texte libre)</Label>
              <Input id="edit-location" maxLength={200} value={form.locationLabel} onChange={(e) => update({ locationLabel: e.target.value })} aria-invalid={invalid(errors, 'locationLabel')} aria-describedby={describedBy(errors, 'locationLabel')} />
              <FieldError errors={errors} name="locationLabel" />
            </div>
          ) : (
            <div aria-hidden="true" />
          )}
          {rights.manager ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="edit-driver">Conducteur lié au dossier</Label>
              <Select value={form.driverId} onValueChange={(v) => update({ driverId: v })}>
                <SelectTrigger id="edit-driver" className="w-full" aria-invalid={invalid(errors, 'driverId')} aria-describedby={describedBy(errors, 'driverId', 'edit-driver-hint')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Aucun conducteur lié</SelectItem>
                  {driverOptions.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="edit-driver-hint" className="text-xs text-muted-foreground">
                Lien explicite posé par le chef de parc : information de suivi, sans désignation d’un responsable ni retenue.
              </p>
              <FieldError errors={errors} name="driverId" />
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <FollowUpField id="edit-follow-up" companyId={incident.companyId} value={form.followUpUserId} onChange={(v) => update({ followUpUserId: v })} errors={errors} currentName={incident.followUpUserName} />
          </div>
          <div className="sm:col-span-2">
            <PhotoUploader id="edit-photos" label="Ajouter des photos" companyId={incident.companyId} photos={form.photos} onChange={(photos) => update({ photos })} errors={errors} />
          </div>
          {save.error ? (
            <div className="sm:col-span-2">
              <ApiErrorAlert error={save.error} />
            </div>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
