'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, TriangleAlert, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { IncidentComments } from '@/components/incidents/incident-comments';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid, toneForIncidentStatus, toneForSeverity } from '@/components/incidents/ops-helpers';
import { PhotoUploader, type UploadedPhoto } from '@/components/incidents/photo-uploader';
import { useSession } from '@/components/layout/session-context';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { formatDateTime } from '@/lib/format';
import type { IncidentSeverity, IncidentType, IncidentView } from '@/lib/incidents-types';
import type { UsageView } from '@/lib/usages-types';
import { useOnlineStatus } from '@/lib/use-online-status';
import { localInputToIso, nowLocalInput } from '@/lib/zoned-time';
import { HABITUAL_VEHICLE_LABEL, useSubmissionTargets } from './submission-targets';

/** Gravité laissée au serveur : il applique sa valeur par défaut selon le type. */
const AUTO = '__defaut__';

/** Véhicule proposé pour un signalement : fourni par l'API (cible de soumission ou dernière utilisation). */
interface Candidate {
  vehicleId: string;
  label: string;
  detail: string;
  /** Société de rattachement des photos (celle de l'utilisation, sinon celle de la fiche conducteur). */
  companyId: string;
}

/**
 * Véhicules proposés (D-216, D-268) : cibles de soumission renvoyées par l'API (utilisation EN_COURS, ou véhicule
 * dont le conducteur est responsable habituel si l'organisation l'autorise), et véhicule de sa dernière
 * utilisation terminée (déclaration après restitution, dans le délai paramétré). Le serveur tranche à l'envoi.
 */
function useCandidates(driverId: string) {
  const session = useSession();
  const targets = useSubmissionTargets();
  // Utilisation la plus récente (en cours d'abord) : société des photos et déclaration tardive.
  const latest = useQuery({ queryKey: ['usages', 'mon-vehicule', 'derniere'], queryFn: () => api<Page<UsageView>>(`/usages${toQuery({ pageSize: 1 })}`) });
  const driver = useQuery({ queryKey: ['driver', driverId], queryFn: () => api<DriverView>(`/drivers/${driverId}`) });
  const usage = latest.data?.items[0] ?? null;
  const candidates: Candidate[] = [];
  for (const t of targets.data ?? []) {
    const companyId = usage && t.usageId === usage.id ? usage.companyId : driver.data?.companyId;
    if (!companyId) continue;
    candidates.push({ vehicleId: t.vehicleId, label: `${t.vehicleCode} · ${t.registration}`, detail: t.basis === 'UTILISATION_EN_COURS' ? 'Utilisation en cours' : HABITUAL_VEHICLE_LABEL, companyId });
  }
  if (usage && usage.status === 'TERMINEE' && !candidates.some((c) => c.vehicleId === usage.vehicleId)) {
    candidates.push({ vehicleId: usage.vehicleId, label: `${usage.vehicleCode} · ${usage.vehicleRegistration}`, detail: `Dernière utilisation, restituée le ${formatDateTime(usage.returnedAt, session.timezone)}`, companyId: usage.companyId });
  }
  const pending = targets.isPending || latest.isPending || driver.isPending;
  const error = targets.error ?? latest.error ?? driver.error ?? null;
  return { candidates, usage, pending, error };
}

/**
 * « Signaler un problème » (CDC 10.3, 7.3, D-216, D-268) pour le conducteur sur mobile : véhicule proposé par
 * l'API, type, gravité proposée, description, lieu et photos prises avec l'appareil (POST /attachments puis
 * POST /incidents). Le serveur vérifie le véhicule et fixe l'utilisation et le conducteur. Une clé d'idempotence est générée à l'ouverture du
 * formulaire et réutilisée à chaque nouvel envoi (D-308) : un renvoi après une coupure ne crée pas de
 * doublon. Suivi « Mes signalements » avec statut et commentaires partagés (le suivi interne n'est pas
 * exposé, D-216). Hors connexion, rien n'est prétendu enregistré.
 */
export function ReportIncident({ driverId }: { driverId: string }) {
  const session = useSession();

  if (!session.isDriverOnly) {
    return (
      <section aria-labelledby="report-title" className="space-y-2">
        <h2 id="report-title" className="text-lg font-semibold">
          Signaler un problème
        </h2>
        <p className="text-sm text-muted-foreground">
          Ce signalement mobile est réservé aux comptes conducteur. Le personnel déclare un incident depuis la page{' '}
          <Link href="/incidents/nouveau" className="underline underline-offset-4">
            Déclarer un incident
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <DriverReport driverId={driverId} />
      <MyReports />
    </div>
  );
}

function DriverReport({ driverId }: { driverId: string }) {
  const [formOpen, setFormOpen] = useState(false);
  // Nouvelle instance du formulaire à chaque ouverture.
  const [formKey, setFormKey] = useState(0);
  const { candidates, usage, pending, error } = useCandidates(driverId);
  const unavailable = !pending && candidates.length === 0;

  return (
    <section aria-labelledby="report-title" className="space-y-2">
      <h2 id="report-title" className="sr-only">
        Signaler un problème
      </h2>
      {formOpen && candidates.length > 0 ? (
        <ReportForm key={formKey} usage={usage} candidates={candidates} onClose={() => setFormOpen(false)} />
      ) : (
        <>
          <Button
            size="lg"
            variant="outline"
            className="h-14 w-full text-base"
            disabled={pending || candidates.length === 0}
            aria-describedby={unavailable ? 'report-unavailable' : undefined}
            onClick={() => {
              setFormKey((k) => k + 1);
              setFormOpen(true);
            }}
          >
            <TriangleAlert className="size-5" aria-hidden="true" /> Signaler un problème
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {isApiError(error) ? error.message : 'Véhicules disponibles indisponibles.'}
            </p>
          ) : unavailable ? (
            <p id="report-unavailable" className="text-sm text-muted-foreground">
              Aucun véhicule ne vous est attribué pour un signalement : un problème se signale pendant une utilisation ou juste après la restitution, ou sur le véhicule dont vous êtes responsable habituel si votre organisation l’autorise.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

interface Draft {
  vehicleId: string;
  type: IncidentType | '';
  severity: IncidentSeverity | typeof AUTO;
  description: string;
  locationLabel: string;
  occurredAt: string;
  photos: UploadedPhoto[];
}

function ReportForm({ usage, candidates, onClose }: { usage: UsageView | null; candidates: readonly Candidate[]; onClose: () => void }) {
  const session = useSession();
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => ({ vehicleId: candidates[0]?.vehicleId ?? '', type: '', severity: AUTO, description: '', locationLabel: '', occurredAt: nowLocalInput(session.timezone), photos: [] }));
  // Véhicule retenu : celui choisi s'il est toujours proposé par l'API, sinon le premier proposé.
  const candidate = candidates.find((c) => c.vehicleId === draft.vehicleId) ?? candidates[0] ?? null;
  // Clé propre à ce formulaire ouvert, réutilisée pour chaque nouvel essai du même signalement.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [local, setLocal] = useState<FieldErrors>({});
  const [result, setResult] = useState<IncidentView | null>(null);
  const typeTrigger = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    if (result) resultHeading.current?.focus();
    else typeTrigger.current?.focus();
  }, [result]);

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<IncidentView>('/incidents', { method: 'POST', body, idempotencyKey }),
    onSuccess: (created) => {
      setResult(created);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      toast.success(`Signalement ${created.reference} enregistré.`);
    },
    onError: (error) => toast.error(isApiError(error) && error.status === 0 ? 'Non envoyé : vérifiez votre connexion.' : isApiError(error) ? error.message : 'Signalement non enregistré.'),
  });

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h3 ref={resultHeading} tabIndex={-1} className="outline-none">
              Signalement enregistré
            </h3>
          </CardTitle>
          <CardDescription>Réponse du serveur reçue : le gestionnaire du parc est informé.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div role="status" className="space-y-2 rounded-md border p-3">
            <p className="text-base font-semibold">
              {result.reference} · {INCIDENT_TYPE_LABELS[result.type] ?? result.type}
            </p>
            <p className="text-muted-foreground">
              {result.vehicleCode} · {result.vehicleRegistration}
            </p>
            <div className="flex flex-wrap gap-2">
              <StatusBadge label={INCIDENT_STATUS_LABELS[result.status] ?? result.status} tone={toneForIncidentStatus(result.status)} />
              <StatusBadge label={`Gravité : ${INCIDENT_SEVERITY_LABELS[result.severity] ?? result.severity}`} tone={toneForSeverity(result.severity)} />
            </div>
            <p>Suivez son traitement et les réponses dans « Mes signalements ».</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="h-11"
              onClick={() => {
                submit.reset();
                setLocal({});
                setResult(null);
                setIdempotencyKey(newIdempotencyKey());
                setDraft({ vehicleId: candidate?.vehicleId ?? '', type: '', severity: AUTO, description: '', locationLabel: '', occurredAt: nowLocalInput(session.timezone), photos: [] });
              }}
            >
              Signaler un autre problème
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              Fermer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const errors = { ...errorsOf(submit.error), ...local };

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    const occurredIso = localInputToIso(draft.occurredAt, session.timezone);
    if (!candidate) next.vehicleId = ['Aucun véhicule disponible pour ce signalement.'];
    if (!draft.type) next.type = ['Choisissez le type de problème.'];
    if (draft.description.trim().length < 5) next.description = ['Décrivez le problème (5 caractères au moins).'];
    if (!occurredIso) next.occurredAt = ['Indiquez la date et l’heure.'];
    setLocal(next);
    if (Object.keys(next).length > 0 || !candidate || !online) return;
    submit.mutate({
      vehicleId: candidate.vehicleId,
      type: draft.type,
      severity: draft.severity === AUTO ? undefined : draft.severity,
      occurredAt: occurredIso ?? undefined,
      locationLabel: draft.locationLabel.trim() || undefined,
      description: draft.description.trim(),
      photoAttachmentIds: draft.photos.length > 0 ? draft.photos.map((p) => p.id) : undefined,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <h3>Signaler un problème</h3>
        </CardTitle>
        <CardDescription>
          {usage
            ? `Dernière utilisation : ${usage.vehicleCode} · ${usage.vehicleRegistration} — ${usage.status === 'EN_COURS' ? 'en cours' : `restitué le ${formatDateTime(usage.returnedAt, session.timezone)}`}. `
            : ''}
          Le serveur vérifie que ce véhicule vous est attribué et rattache le signalement à votre utilisation lorsqu’il y en a une.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" noValidate onSubmit={onSubmit}>
          {candidates.length > 1 ? (
            <div className="space-y-2">
              <p id="report-vehicle-label" className="text-sm leading-none font-medium">
                Véhicule concerné *
              </p>
              <RadioGroup aria-labelledby="report-vehicle-label" value={candidate?.vehicleId ?? ''} onValueChange={(v) => update({ vehicleId: v })} className="gap-2">
                {candidates.map((c) => (
                  <div key={c.vehicleId} className="flex items-center gap-3 rounded-md border p-3">
                    <RadioGroupItem id={`report-vehicle-${c.vehicleId}`} value={c.vehicleId} />
                    <Label htmlFor={`report-vehicle-${c.vehicleId}`} className="font-normal">
                      <span className="font-medium">{c.label}</span>
                      <span className="block text-xs text-muted-foreground">{c.detail}</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <FieldError errors={errors} name="vehicleId" />
            </div>
          ) : candidate ? (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{candidate.label}</p>
              <p className="text-xs text-muted-foreground">{candidate.detail}</p>
              <FieldError errors={errors} name="vehicleId" />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="report-type">Type de problème *</Label>
            <Select value={draft.type} onValueChange={(v) => update({ type: v as IncidentType })}>
              <SelectTrigger ref={typeTrigger} id="report-type" className="h-12 w-full" aria-invalid={invalid(errors, 'type')} aria-describedby={describedBy(errors, 'type')}>
                <SelectValue placeholder="Choisir" />
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
            <Label htmlFor="report-severity">Gravité proposée</Label>
            <Select value={draft.severity} onValueChange={(v) => update({ severity: v as Draft['severity'] })}>
              <SelectTrigger id="report-severity" className="h-12 w-full" aria-invalid={invalid(errors, 'severity')} aria-describedby={describedBy(errors, 'severity', 'report-severity-hint')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>Je ne sais pas (gravité par défaut)</SelectItem>
                {Object.entries(INCIDENT_SEVERITY_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="report-severity-hint" className="text-xs text-muted-foreground">
              Le gestionnaire du parc peut requalifier la gravité.
            </p>
            <FieldError errors={errors} name="severity" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="report-description">Que se passe-t-il ? *</Label>
            <Textarea id="report-description" rows={4} maxLength={4000} value={draft.description} onChange={(e) => update({ description: e.target.value })} aria-invalid={invalid(errors, 'description')} aria-describedby={describedBy(errors, 'description')} />
            <FieldError errors={errors} name="description" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="report-location">Lieu</Label>
            <Input id="report-location" className="h-12" maxLength={200} value={draft.locationLabel} onChange={(e) => update({ locationLabel: e.target.value })} placeholder="Ex. route de Sousse, parking du client" aria-invalid={invalid(errors, 'locationLabel')} aria-describedby={describedBy(errors, 'locationLabel')} />
            <FieldError errors={errors} name="locationLabel" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="report-occurred">Date et heure *</Label>
            <Input id="report-occurred" type="datetime-local" className="h-12" value={draft.occurredAt} onChange={(e) => update({ occurredAt: e.target.value })} aria-invalid={invalid(errors, 'occurredAt')} aria-describedby={describedBy(errors, 'occurredAt', 'report-occurred-hint')} />
            <p id="report-occurred-hint" className="text-xs text-muted-foreground">
              Par défaut, maintenant.
            </p>
            <FieldError errors={errors} name="occurredAt" />
          </div>

          <PhotoUploader
            id="report-photos"
            label="Photos (recommandées)"
            companyId={candidate?.companyId ?? null}
            photos={draft.photos}
            onChange={(photos) => update({ photos })}
            errors={errors}
            large
            disabledReason="Photos indisponibles : le véhicule concerné n’a pas pu être chargé. Vous pouvez envoyer le signalement sans photo."
          />

          {!online ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Hors connexion : le signalement ne peut pas être envoyé et rien n’est enregistré. Votre saisie reste affichée ; envoyez-la quand la connexion revient.
            </p>
          ) : null}

          {submit.error ? (
            <ApiErrorAlert error={submit.error}>
              {isApiError(submit.error) && submit.error.status === 0 ? <p className="mt-1 text-muted-foreground">Aucune confirmation reçue : renvoyez le signalement sans le modifier quand la connexion revient ; s’il a déjà été enregistré, le serveur renvoie le même signalement, sans doublon.</p> : null}
              {isApiError(submit.error) && submit.error.code === 'IDEMPOTENCE_CORPS_DIFFERENT' ? <p className="mt-1 text-muted-foreground">Ce formulaire a déjà servi à envoyer un signalement : vérifiez « Mes signalements », puis ouvrez un nouveau formulaire pour un autre problème.</p> : null}
            </ApiErrorAlert>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" className="h-12 text-base" disabled={submit.isPending || !online}>
              {submit.isPending ? 'Envoi…' : 'Envoyer le signalement'}
            </Button>
            <Button type="button" variant="outline" className="h-12" onClick={onClose} disabled={submit.isPending}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** « Mes signalements » : incidents déclarés par le conducteur ou le concernant (GET /incidents, périmètre du conducteur). */
function MyReports() {
  const session = useSession();
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = toQuery({ page, pageSize: 10 });
  const reports = useQuery({ queryKey: ['incidents', 'mes-signalements', query], queryFn: () => api<Page<IncidentView>>(`/incidents${query}`) });

  return (
    <section aria-labelledby="my-reports-title" className="space-y-3">
      <div>
        <h2 id="my-reports-title" className="text-lg font-semibold">
          Mes signalements
        </h2>
        <p className="text-sm text-muted-foreground">Statut de chaque signalement et réponses partagées par le gestionnaire du parc.</p>
      </div>
      {reports.isPending ? (
        <LoadingState label="Chargement des signalements…" />
      ) : reports.isError ? (
        <ErrorState error={reports.error} retry={() => void reports.refetch()} />
      ) : reports.data.total === 0 ? (
        <EmptyState title="Aucun signalement" description="Les problèmes que vous signalez apparaîtront ici avec leur statut." />
      ) : (
        <div>
          <ul className="space-y-2">
            {reports.data.items.map((r) => {
              const open = expanded === r.id;
              return (
                <li key={r.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-semibold">
                        {INCIDENT_TYPE_LABELS[r.type] ?? r.type} · {r.reference}
                      </p>
                      <p className="text-muted-foreground">
                        {r.vehicleCode} · {formatDateTime(r.occurredAt, session.timezone)}
                      </p>
                      <p className="mt-1 line-clamp-2 break-words">{r.description}</p>
                    </div>
                    <StatusBadge label={INCIDENT_STATUS_LABELS[r.status] ?? r.status} tone={toneForIncidentStatus(r.status)} />
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="mt-2 h-10" aria-expanded={open} aria-controls={`report-${r.id}-comments`} onClick={() => setExpanded(open ? null : r.id)}>
                    <MessageSquare className="size-4" aria-hidden="true" />
                    {open ? 'Masquer les échanges' : 'Voir les échanges et commenter'}
                  </Button>
                  {open ? (
                    <div id={`report-${r.id}-comments`} className="mt-3 border-t pt-3">
                      <IncidentComments incident={r} canComment idPrefix={`report-${r.id}-comment`} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <PaginationControls page={reports.data.page} pageSize={reports.data.pageSize} total={reports.data.total} onPageChange={setPage} />
        </div>
      )}
    </section>
  );
}
