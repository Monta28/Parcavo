'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MEASUREMENT_KIND_LABELS, READING_CONTEXT_LABELS, READING_SOURCE_LABELS } from '@parc-auto/contracts';
import { FieldError } from '@/components/forms/field-error';
import { useSession } from '@/components/layout/session-context';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import type { InterventionView } from '@/lib/interventions-types';
import type { ReadingView } from '@/lib/odometer-types';
import { civilHour, isCivilDate, localInputToIso, nowLocalInput, todayCivil } from '@/lib/zoned-time';
import { ApiErrorAlert, AttachmentsField, CostFields, type CostMode, type CostState, GarageSelect, type UploadedFile, costPayload, validateCost } from '../form-parts';
import { type FieldErrors, NONE, describedBy, isDecimalFormat, normalizeDecimalInput, useInterventionRights } from '../intervention-helpers';
import { useInterventionCache } from './action-dialogs';

type ReadingMode = 'existant' | 'nouveau' | 'aucun';

/** Nombre de relevés acceptés proposés, les plus proches de la date effective. */
const CANDIDATES = 8;

const COST_MODE_SUMMARY: Record<CostMode, string> = {
  plus_tard: 'coût à saisir plus tard',
  lignes: 'lignes pièces / main-d’œuvre (total calculé par le serveur)',
  total: 'total TTC saisi',
  sans_cout: 'sans coût (aucune dépense)',
};

/**
 * Clôture d'une intervention (CompleteIntervention, CDC 6.4 et 15.3) : transactionnelle, versionnée et
 * idempotente. La clé est générée une fois à l'ouverture du formulaire et réutilisée pour tout nouvel
 * essai du même envoi (réponse perdue, coupure réseau) : aucun doublon de clôture ni de dépense.
 */
export function CompleteForm({ intervention, onClose }: { intervention: InterventionView; onClose: () => void }) {
  const session = useSession();
  const rights = useInterventionRights(intervention.companyId);
  const cache = useInterventionCache(intervention.id);
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const heading = useRef<HTMLHeadingElement>(null);
  const [today] = useState(() => todayCivil(session.timezone));

  const [performedOn, setPerformedOn] = useState(today);
  const [notDone, setNotDone] = useState<Record<string, boolean>>({});
  const [readingMode, setReadingMode] = useState<ReadingMode>('nouveau');
  const [readingId, setReadingId] = useState('');
  const [km, setKm] = useState('');
  const [observedAt, setObservedAt] = useState(() => nowLocalInput(session.timezone));
  const [readingPhoto, setReadingPhoto] = useState<UploadedFile[]>([]);
  const [cost, setCost] = useState<CostState>({ mode: 'plus_tard', lines: [], total: '' });
  const [supplierId, setSupplierId] = useState(intervention.supplierId ?? NONE);
  const [workDescription, setWorkDescription] = useState(intervention.workDescription ?? '');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [endImmobilization, setEndImmobilization] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const readings = useQuery({
    queryKey: ['vehicle', intervention.vehicleId, 'readings', 'accepted'],
    queryFn: () => api<Page<ReadingView>>(`/vehicles/${intervention.vehicleId}/readings${toQuery({ status: 'ACCEPTE', pageSize: 100 })}`),
  });

  // Relevés physiques acceptés (jamais une estimation GPS), triés par proximité avec la date effective.
  const candidates = useMemo(() => {
    const items = (readings.data?.items ?? []).filter((r) => r.status === 'ACCEPTE' && !r.isEstimate && r.measurementKind !== 'DISTANCE_GPS');
    const reference = isCivilDate(performedOn) ? civilHour(performedOn, 12, session.timezone).getTime() : Number.NaN;
    const sorted = Number.isNaN(reference) ? items : [...items].sort((a, b) => Math.abs(new Date(a.observedAt).getTime() - reference) - Math.abs(new Date(b.observedAt).getTime() - reference));
    const top = sorted.slice(0, CANDIDATES);
    const selected = items.find((r) => r.id === readingId);
    return selected && !top.includes(selected) ? [...top, selected] : top;
  }, [readings.data, performedOn, readingId, session.timezone]);

  const completedTasks = intervention.tasks.filter((t) => !notDone[t.id]);
  const selectedReading = candidates.find((r) => r.id === readingId) ?? null;
  const hasCauseToEnd = Boolean(intervention.openImmobilizationCauseId);

  const complete = useMutation({
    mutationFn: () =>
      api<InterventionView>(`/interventions/${intervention.id}/complete`, {
        method: 'POST',
        idempotencyKey,
        body: {
          performedOn,
          acceptedReadingId: readingMode === 'existant' ? readingId : undefined,
          newReading:
            readingMode === 'nouveau'
              ? { physicalKm: normalizeDecimalInput(km), observedAt: localInputToIso(observedAt, session.timezone), ...(readingPhoto[0] ? { attachmentId: readingPhoto[0].id } : {}) }
              : undefined,
          completedTaskIds: completedTasks.map((t) => t.id),
          ...costPayload(cost),
          supplierId: supplierId !== NONE && supplierId !== intervention.supplierId ? supplierId : undefined,
          attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
          endImmobilization: hasCauseToEnd ? endImmobilization : undefined,
          workDescription: workDescription.trim() !== (intervention.workDescription ?? '') ? workDescription.trim() : undefined,
          expectedVersion: intervention.version,
        },
      }),
    onSuccess: (updated) => {
      setConfirmOpen(false);
      cache.saved(updated, `Intervention ${updated.reference} terminée le ${formatDate(updated.performedOn)} : plans des lignes réalisées recalculés.`);
      if (updated.costStatus === 'A_SAISIR') toast.info('Le coût reste à saisir : utilisez « Saisir le coût » dès réception de la facture.');
      onClose();
    },
    onError: (error) => {
      setConfirmOpen(false);
      setSubmitError(error);
      if (isApiError(error)) setFieldErrors(error.fieldErrors);
      cache.failed(error, 'Clôture impossible.');
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const local: FieldErrors = { ...validateCost(cost) };
    if (!isCivilDate(performedOn)) local.performedOn = ['Indiquez la date effective de réalisation.'];
    if (completedTasks.length === 0) local.completedTaskIds = ['Cochez au moins une ligne de travail réalisée.'];
    if (readingMode === 'existant' && !readingId) local.acceptedReadingId = ['Choisissez le relevé accepté correspondant, ou une autre option.'];
    if (readingMode === 'nouveau') {
      if (!isDecimalFormat(normalizeDecimalInput(km))) local['newReading.physicalKm'] = ['Saisissez la valeur affichée au compteur (ex. 90 000).'];
      if (!localInputToIso(observedAt, session.timezone)) local['newReading.observedAt'] = ['Indiquez la date et l’heure du relevé.'];
    }
    setFieldErrors(local);
    if (Object.keys(local).length > 0) {
      toast.error('Certains champs sont à compléter.');
      return;
    }
    setConfirmOpen(true);
  }

  const readingSummary =
    readingMode === 'existant' && selectedReading
      ? `relevé accepté du ${formatDateTime(selectedReading.observedAt, session.timezone)} (${formatKm(selectedReading.physicalKm)})`
      : readingMode === 'nouveau'
        ? `nouveau relevé de ${formatKm(normalizeDecimalInput(km))} le ${formatDateTime(localInputToIso(observedAt, session.timezone), session.timezone)}`
        : 'aucun relevé';

  return (
    <Card id="cloture">
      <CardHeader>
        <CardTitle className="text-base">
          <h2 ref={heading} tabIndex={-1} className="outline-none">
            Terminer l’intervention {intervention.reference}
          </h2>
        </CardTitle>
        <CardDescription>
          La clôture enregistre les travaux effectués et, dans une seule transaction, met à jour les bases et échéances des seuls plans réalisés, la dépense liée et les alertes. Un relevé validé correspondant est exigé dès qu’une ligne réalisée correspond à un plan avec intervalle en kilomètres.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" noValidate onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="performedOn">Date effective de réalisation *</Label>
              <Input
                id="performedOn"
                type="date"
                value={performedOn}
                max={today}
                onChange={(e) => setPerformedOn(e.target.value)}
                aria-invalid={Boolean(fieldErrors.performedOn?.length) || undefined}
                aria-describedby={describedBy(fieldErrors, 'performedOn', 'performedOn-hint')}
              />
              <p id="performedOn-hint" className="text-xs text-muted-foreground">
                Date civile locale ({session.timezone}) ; jamais postérieure à aujourd’hui.
              </p>
              <FieldError errors={fieldErrors} name="performedOn" />
            </div>
            <GarageSelect
              id="complete-supplier"
              companyId={intervention.companyId}
              value={supplierId}
              onChange={setSupplierId}
              current={intervention.supplierId && intervention.supplierName ? { id: intervention.supplierId, name: intervention.supplierName } : null}
              allowNone={!intervention.supplierId}
              errors={fieldErrors}
            />
          </div>

          <fieldset className="space-y-2" aria-describedby={describedBy(fieldErrors, 'completedTaskIds', 'tasks-done-hint')}>
            <legend className="text-sm font-medium">Lignes de travail réalisées *</legend>
            <p id="tasks-done-hint" className="text-xs text-muted-foreground">
              Seules les lignes cochées mettent à jour leur propre plan (changer une batterie ne remet pas la vidange à zéro).
            </p>
            {intervention.tasks.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Aucune ligne de travail.{' '}
                {rights.operational ? (
                  <>
                    <Link href={`/interventions/${intervention.id}/modifier`} className="underline underline-offset-4">
                      Ajoutez une ligne
                    </Link>{' '}
                    avant de terminer.
                  </>
                ) : (
                  'Un opérateur ou un chef de parc doit en ajouter une avant la clôture.'
                )}
              </p>
            ) : (
              <ul className="space-y-2">
                {intervention.tasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <Checkbox id={`done-${t.id}`} checked={!notDone[t.id]} onCheckedChange={(v) => setNotDone((m) => ({ ...m, [t.id]: v !== true }))} className="mt-0.5" />
                    <Label htmlFor={`done-${t.id}`} className="font-normal">
                      <span>
                        {t.label}
                        <span className="block text-xs text-muted-foreground">{t.planId ? `Plan du véhicule : ${t.maintenanceTypeLabel ?? t.label}` : t.maintenanceTypeId ? `Opération du catalogue : ${t.maintenanceTypeLabel ?? t.label}` : 'Libellé libre (aucun plan)'}</span>
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
            )}
            <FieldError errors={fieldErrors} name="completedTaskIds" />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Relevé d’exécution</legend>
            <RadioGroup value={readingMode} onValueChange={(v) => setReadingMode(v as ReadingMode)} aria-label="Relevé d’exécution" className="gap-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="reading-new" value="nouveau" />
                <Label htmlFor="reading-new" className="font-normal">
                  Saisir le relevé lu au compteur
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="reading-existing" value="existant" />
                <Label htmlFor="reading-existing" className="font-normal">
                  Choisir un relevé accepté existant
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="reading-none" value="aucun" aria-describedby="reading-none-hint" />
                <Label htmlFor="reading-none" className="font-normal">
                  Sans relevé
                </Label>
              </div>
            </RadioGroup>
            <p id="reading-none-hint" className="text-xs text-muted-foreground">
              Le relevé doit être physique (jamais une estimation GPS), accepté et observé à la date effective ; « sans relevé » n’est admis que si aucun plan réalisé n’utilise de kilomètres.
            </p>

            {readingMode === 'nouveau' ? (
              <div className="grid gap-4 rounded-md border p-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="newReading-km">Valeur affichée au compteur (km) *</Label>
                  <Input
                    id="newReading-km"
                    inputMode="decimal"
                    autoComplete="off"
                    value={km}
                    onChange={(e) => setKm(e.target.value)}
                    aria-invalid={Boolean(fieldErrors['newReading.physicalKm']?.length) || undefined}
                    aria-describedby={describedBy(fieldErrors, 'newReading.physicalKm', 'newReading-km-hint')}
                  />
                  <p id="newReading-km-hint" className="text-xs text-muted-foreground">
                    Relevé créé dans la même transaction (contexte entretien). S’il n’est pas accepté d’emblée, la clôture est refusée : faites-le valider puis clôturez.
                  </p>
                  <FieldError errors={fieldErrors} name="newReading.physicalKm" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newReading-at">Date et heure du relevé *</Label>
                  <Input
                    id="newReading-at"
                    type="datetime-local"
                    value={observedAt}
                    onChange={(e) => setObservedAt(e.target.value)}
                    aria-invalid={Boolean(fieldErrors['newReading.observedAt']?.length) || undefined}
                    aria-describedby={describedBy(fieldErrors, 'newReading.observedAt')}
                  />
                  <FieldError errors={fieldErrors} name="newReading.observedAt" />
                </div>
                <div className="md:col-span-2">
                  <AttachmentsField
                    id="newReading-photo"
                    label="Photo du compteur (facultatif)"
                    hint="JPEG, PNG ou PDF, 10 Mo maximum."
                    companyId={intervention.companyId}
                    files={readingPhoto}
                    onChange={setReadingPhoto}
                    max={1}
                    errors={fieldErrors}
                    errorName="newReading.attachmentId"
                  />
                </div>
              </div>
            ) : null}

            {readingMode === 'existant' ? (
              <div className="space-y-2 rounded-md border p-3">
                {readings.isPending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Chargement des relevés…
                  </p>
                ) : readings.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {isApiError(readings.error) ? readings.error.message : 'Relevés indisponibles.'}
                  </p>
                ) : candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucun relevé physique accepté pour ce véhicule : saisissez le relevé lu au compteur.</p>
                ) : (
                  <RadioGroup
                    value={readingId}
                    onValueChange={setReadingId}
                    aria-label="Relevés acceptés les plus proches de la date effective"
                    aria-describedby={describedBy(fieldErrors, 'acceptedReadingId')}
                    aria-invalid={Boolean(fieldErrors.acceptedReadingId?.length) || undefined}
                    className="gap-2"
                  >
                    {candidates.map((r) => (
                      <div key={r.id} className="flex items-start gap-2">
                        <RadioGroupItem id={`reading-${r.id}`} value={r.id} className="mt-0.5" />
                        <Label htmlFor={`reading-${r.id}`} className="font-normal">
                          <span>
                            <span className="font-medium">{formatKm(r.physicalKm)}</span> · observé le {formatDateTime(r.observedAt, session.timezone)}
                            <span className="block text-xs text-muted-foreground">
                              {READING_SOURCE_LABELS[r.source] ?? r.source} · {MEASUREMENT_KIND_LABELS[r.measurementKind] ?? r.measurementKind} · {READING_CONTEXT_LABELS[r.context as keyof typeof READING_CONTEXT_LABELS] ?? r.context}
                              {r.cumulativeKm && r.cumulativeKm !== r.physicalKm ? ` · cumul ${formatKm(r.cumulativeKm)}` : ''}
                            </span>
                          </span>
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
                <p className="text-xs text-muted-foreground">Relevés physiques acceptés, du plus proche au plus éloigné de la date effective.</p>
                <FieldError errors={fieldErrors} name="acceptedReadingId" />
              </div>
            ) : null}
            {readingMode === 'aucun' ? <FieldError errors={fieldErrors} name="acceptedReadingId" /> : null}
          </fieldset>

          <CostFields idPrefix="complete" state={cost} onChange={setCost} canWriteCosts={rights.can('costs.write')} allowLater tasks={intervention.tasks} errors={fieldErrors} />

          <div className="space-y-2">
            <Label htmlFor="complete-work">Travaux effectués</Label>
            <Textarea id="complete-work" value={workDescription} maxLength={4000} onChange={(e) => setWorkDescription(e.target.value)} aria-describedby={describedBy(fieldErrors, 'workDescription')} />
            <FieldError errors={fieldErrors} name="workDescription" />
          </div>

          <AttachmentsField
            id="complete-attachments"
            label="Pièces jointes (factures, bons, photos)"
            hint="PDF, JPEG ou PNG, 10 Mo maximum par fichier, 20 fichiers au plus."
            companyId={intervention.companyId}
            files={attachments}
            onChange={setAttachments}
            max={20}
            errors={fieldErrors}
            errorName="attachmentIds"
          />

          <div className="space-y-1">
            <div className="flex items-start gap-2">
              <Checkbox
                id="complete-end-immobilization"
                checked={hasCauseToEnd && endImmobilization}
                disabled={!hasCauseToEnd}
                onCheckedChange={(v) => setEndImmobilization(v === true)}
                className="mt-0.5"
                aria-describedby="complete-end-immobilization-hint"
              />
              <Label htmlFor="complete-end-immobilization" className="font-normal">
                Mettre fin à la cause d’immobilisation liée
              </Label>
            </div>
            <p id="complete-end-immobilization-hint" className="pl-6 text-xs text-muted-foreground">
              {hasCauseToEnd ? 'Cochée par défaut : le véhicule redevient disponible s’il n’a pas d’autre cause d’immobilisation ouverte.' : 'Aucune cause d’immobilisation ouverte n’est liée à cette intervention.'}
            </p>
          </div>

          <ApiErrorAlert error={submitError} />

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={complete.isPending || intervention.tasks.length === 0}>
              {complete.isPending ? 'Clôture…' : 'Terminer l’intervention'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={complete.isPending}>
              Fermer sans terminer
            </Button>
          </div>
        </form>
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !complete.isPending && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminer l’intervention {intervention.reference} ?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <ul className="list-disc space-y-1 pl-5">
                  <li>Date effective : {formatDate(performedOn)}</li>
                  <li>
                    Lignes réalisées ({completedTasks.length}/{intervention.tasks.length}) : {completedTasks.map((t) => t.label).join(', ')}
                  </li>
                  <li>Relevé d’exécution : {readingSummary}</li>
                  <li>Coût : {COST_MODE_SUMMARY[cost.mode]}</li>
                  {hasCauseToEnd ? <li>Immobilisation liée : {endImmobilization ? 'la cause sera terminée' : 'la cause reste ouverte'}</li> : null}
                </ul>
                <p>Une correction ultérieure passera par une réouverture motivée (chef de parc ou administrateur).</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={complete.isPending}>Revenir au formulaire</AlertDialogCancel>
            <Button type="button" disabled={complete.isPending} onClick={() => complete.mutate()}>
              {complete.isPending ? 'Clôture…' : 'Confirmer la clôture'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
