'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { formatIntervals, formatNotices } from '@/components/maintenance/plan-display';
import { isManagerOf } from '@/components/maintenance/roles';
import { PaginationControls } from '@/components/pagination-controls';
import { ErrorState, LoadingState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, newIdempotencyKey, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import {
  ACCEPTED_SOURCES_LABELS,
  ON_EXISTING_LABELS,
  expectedPlanVersions,
  type AcceptedSources,
  type ApplyTemplateResult,
  type MaintenanceTemplateView,
  type OnExisting,
} from '@/lib/maintenance-types';
import type { VehicleView } from '@/lib/vehicles-types';
import { TemplateImpactTable } from './template-impact-table';

const SOURCES_DEFAULT = '__defaut__';
const CHOICE_DEFAULT = '__defaut__';
const PAGE_SIZE = 50;

const SHORT_ON_EXISTING: Record<OnExisting, string> = {
  IGNORER: 'Ignorer',
  METTRE_A_JOUR: 'Mettre à jour',
};

/**
 * Copie d'un modèle vers des véhicules de la société (POST /maintenance-templates/:id/apply, D-198) :
 * instantané sans effet rétroactif, résultat détaillé par véhicule (créés, mis à jour, ignorés). Quand des
 * plans existants seraient mis à jour, l'impact calculé par le serveur (preview=true, rien n'est enregistré)
 * est présenté avant la confirmation (17.1).
 */
export function ApplyTemplateDialog({
  template,
  onOpenChange,
}: {
  template: MaintenanceTemplateView;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, companyId: scopeCompanyId } = useAppScope();
  const queryClient = useQueryClient();
  const managedCompanies = session.companies.filter((c) => isManagerOf(session, c.id));
  const [companyId, setCompanyId] = useState(() =>
    scopeCompanyId && managedCompanies.some((c) => c.id === scopeCompanyId)
      ? scopeCompanyId
      : (managedCompanies[0]?.id ?? ''),
  );
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, string>>(() => new Map());
  const [onExisting, setOnExisting] = useState<OnExisting>('IGNORER');
  // Choix par véhicule (D-198), prioritaire sur le choix global ; absent = choix global.
  const [perVehicle, setPerVehicle] = useState<Map<string, OnExisting>>(() => new Map());
  const [sources, setSources] = useState<string>(SOURCES_DEFAULT);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ApplyTemplateResult | null>(null);
  const [result, setResult] = useState<ApplyTemplateResult | null>(null);
  const choices = [...perVehicle.entries()]
    .filter(([vehicleId]) => selected.has(vehicleId))
    .map(([vehicleId, choice]) => ({ vehicleId, onExisting: choice }));
  // Au moins un véhicule dont les plans existants seront mis à jour : impact prévisualisé, puis confirmation explicite.
  const updatesSomePlans =
    choices.some((c) => c.onExisting === 'METTRE_A_JOUR') ||
    (onExisting === 'METTRE_A_JOUR' && selected.size > choices.length);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(term.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [term]);

  const query = toQuery({ companyId, q: debounced, page, pageSize: PAGE_SIZE, sort: 'code' });
  const vehicles = useQuery({
    queryKey: ['vehicles', 'apply-template', query],
    queryFn: () => api<Page<VehicleView>>(`/vehicles${query}`),
    enabled: Boolean(companyId),
  });

  const requestBody = () => ({
    vehicleIds: [...selected.keys()],
    onExisting,
    ...(choices.length > 0 ? { perVehicle: choices } : {}),
    ...(sources !== SOURCES_DEFAULT ? { acceptedSources: sources } : {}),
  });
  const showError = (error: unknown, fallback: string) => {
    // Refus métier (véhicule cédé ou archivé, modèle archivé, rôle insuffisant…) : message de l'API tel quel.
    if (isApiError(error)) {
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);
      toast.error(error.message);
    } else toast.error(fallback);
  };

  // Prévisualisation : même calcul que l'application, dans une transaction annulée côté serveur.
  const previewImpact = useMutation({
    mutationFn: () =>
      api<ApplyTemplateResult>(`/maintenance-templates/${template.id}/apply`, {
        method: 'POST',
        body: { ...requestBody(), preview: true },
      }),
    onSuccess: (data) => setPreview(data),
    onError: (error) => showError(error, 'Prévisualisation impossible.'),
  });

  const apply = useMutation({
    // Une clé d'idempotence par soumission : un renvoi du même corps rejoue le résultat initial (API).
    // Après une prévisualisation, les plans présentés et leurs versions sont renvoyés : si l'impact a changé
    // entre-temps (plan modifié, créé ou désactivé), l'API refuse (409) sans rien enregistrer.
    mutationFn: (idempotencyKey: string) =>
      api<ApplyTemplateResult>(`/maintenance-templates/${template.id}/apply`, {
        method: 'POST',
        idempotencyKey,
        body: { ...requestBody(), ...(preview ? { expectedPlanVersions: expectedPlanVersions(preview) } : {}) },
      }),
    onSuccess: (data) => {
      setPreview(null);
      setResult(data);
      toast.success('Modèle appliqué.');
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plans'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-plan'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance-calendar'] });
    },
    onError: (error) => {
      setPreview(null);
      showError(error, 'Application impossible.');
    },
  });
  const pending = apply.isPending || previewImpact.isPending;

  const toggle = (v: VehicleView, checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(v.id, v.code);
      else next.delete(v.id);
      return next;
    });
    if (!checked)
      setPerVehicle((current) => {
        const next = new Map(current);
        next.delete(v.id);
        return next;
      });
  };
  const setChoice = (vehicleId: string, value: string) =>
    setPerVehicle((current) => {
      const next = new Map(current);
      if (value === CHOICE_DEFAULT) next.delete(vehicleId);
      else next.set(vehicleId, value as OnExisting);
      return next;
    });
  const pageItems = vehicles.data?.items ?? [];
  const allPageSelected = pageItems.length > 0 && pageItems.every((v) => selected.has(v.id));

  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Appliquer le modèle « {template.name} »</DialogTitle>
          <DialogDescription>
            La copie ne modifie pas les historiques. Aucun intervalle universel n’est imposé : les
            intervalles copiés sont ceux du modèle, modifiables ensuite plan par plan.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <Alert>
              <AlertTitle>Résultat par véhicule</AlertTitle>
              <AlertDescription>
                Les nouveaux plans prennent pour base la dernière opération de ce type sur le
                véhicule ; à défaut, ils sont INCOMPLETS avec une alerte.
              </AlertDescription>
            </Alert>
            {result.archivedSkipped.length > 0 ? (
              <Alert>
                <AlertTitle>Opérations non copiées</AlertTitle>
                <AlertDescription>
                  Archivées au catalogue : {result.archivedSkipped.join(', ')}.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Véhicule</TableHead>
                    <TableHead>Plan existant</TableHead>
                    <TableHead>Plans créés</TableHead>
                    <TableHead>Plans mis à jour</TableHead>
                    <TableHead>Ignorés (plan actif existant)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.vehicles.map((r) => (
                    <TableRow key={r.vehicleId}>
                      <TableCell className="font-medium">{r.vehicleCode}</TableCell>
                      <TableCell>{SHORT_ON_EXISTING[r.onExisting] ?? r.onExisting}</TableCell>
                      <TableCell className="whitespace-normal">
                        {r.created.length > 0 ? r.created.join(', ') : '—'}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {r.updated.length > 0 ? r.updated.join(', ') : '—'}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {r.ignored.length > 0 ? r.ignored.join(', ') : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Terminer
              </Button>
            </DialogFooter>
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <Alert>
              <AlertTitle>Prévisualisation de l’impact — rien n’est encore enregistré</AlertTitle>
              <AlertDescription>
                Les plans existants en « mettre à jour » reçoivent les intervalles et préavis du modèle :
                leur base de calcul et l’historique sont conservés, seules les échéances futures sont
                recalculées. Chaque plan modifié sera tracé dans l’audit.
              </AlertDescription>
            </Alert>
            {preview.archivedSkipped.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Opérations archivées au catalogue, non copiées : {preview.archivedSkipped.join(', ')}.
              </p>
            ) : null}
            <TemplateImpactTable impacts={preview.impacts} timezone={session.timezone} />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={apply.isPending} onClick={() => setPreview(null)}>
                Revenir à la sélection
              </Button>
              <Button type="button" disabled={apply.isPending} onClick={() => apply.mutate(newIdempotencyKey())}>
                {apply.isPending ? 'Application…' : 'Confirmer l’application'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setFormError(null);
              if (selected.size === 0) {
                setFieldErrors({ vehicleIds: ['Sélectionnez au moins un véhicule.'] });
                return;
              }
              setFieldErrors({});
              // La mise à jour des plans existants modifie leurs intervalles et préavis : impact prévisualisé
              // (calcul serveur, rien n'est enregistré) puis confirmation explicite.
              if (updatesSomePlans) previewImpact.mutate();
              else apply.mutate(newIdempotencyKey());
            }}
          >
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <section
              aria-labelledby="apply-template-items"
              className="rounded-md border p-3 text-sm"
            >
              <h3 id="apply-template-items" className="mb-2 font-medium">
                Opérations copiées
              </h3>
              <ul className="space-y-1">
                {template.items.map((i) => (
                  <li key={i.id}>
                    <span className="font-medium">{i.maintenanceTypeLabel}</span> :{' '}
                    {formatIntervals(i)}
                    <span className="text-muted-foreground">
                      {' '}
                      · préavis{' '}
                      {formatNotices(i) === '—' ? 'par défaut (paramètres)' : formatNotices(i)}
                    </span>
                    {i.maintenanceTypeStatus === 'ARCHIVE' ? (
                      <span className="text-muted-foreground">
                        {' '}
                        · opération archivée, non copiée
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="apply-company">Société</Label>
                <Select
                  value={companyId}
                  onValueChange={(v) => {
                    setCompanyId(v);
                    setSelected(new Map());
                    setPerVehicle(new Map());
                    setPage(1);
                  }}
                  disabled={managedCompanies.length <= 1}
                >
                  <SelectTrigger id="apply-company" className="w-full">
                    <SelectValue placeholder="Aucune société gérée" />
                  </SelectTrigger>
                  <SelectContent>
                    {managedCompanies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.code} · {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="apply-search">Rechercher un véhicule</Label>
                <Input
                  id="apply-search"
                  type="search"
                  placeholder="Code, immatriculation, marque…"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
              </div>
            </div>

            <fieldset className="space-y-2" aria-describedby="vehicleIds-error">
              <legend className="text-sm font-medium">
                Véhicules ({selected.size} sélectionné{selected.size > 1 ? 's' : ''})
              </legend>
              <FieldError errors={fieldErrors} name="vehicleIds" />
              {!companyId ? (
                <p className="text-sm text-muted-foreground">
                  Aucune société où vous êtes chef de parc.
                </p>
              ) : vehicles.isPending ? (
                <LoadingState label="Chargement des véhicules…" />
              ) : vehicles.isError ? (
                <ErrorState error={vehicles.error} retry={() => void vehicles.refetch()} />
              ) : pageItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Aucun véhicule ne correspond (les véhicules cédés ou archivés ne sont pas
                  proposés).
                </p>
              ) : (
                <div className="rounded-md border">
                  <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
                    <Checkbox
                      id="apply-select-page"
                      checked={allPageSelected}
                      onCheckedChange={(checked) => {
                        for (const v of pageItems) toggle(v, checked === true);
                      }}
                    />
                    <Label htmlFor="apply-select-page" className="font-normal">
                      Sélectionner les véhicules affichés
                    </Label>
                    {selected.size > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => {
                          setSelected(new Map());
                          setPerVehicle(new Map());
                        }}
                      >
                        Tout désélectionner
                      </Button>
                    ) : null}
                  </div>
                  <ul className="max-h-64 divide-y overflow-y-auto">
                    {pageItems.map((v) => (
                      <li key={v.id} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox
                          id={`apply-vehicle-${v.id}`}
                          checked={selected.has(v.id)}
                          onCheckedChange={(checked) => toggle(v, checked === true)}
                        />
                        <Label htmlFor={`apply-vehicle-${v.id}`} className="font-normal">
                          <span className="font-medium">{v.code}</span> · {v.registration}
                          <span className="text-muted-foreground">
                            {' '}
                            · {v.make} {v.model}
                          </span>
                        </Label>
                      </li>
                    ))}
                  </ul>
                  <PaginationControls
                    page={vehicles.data.page}
                    pageSize={vehicles.data.pageSize}
                    total={vehicles.data.total}
                    onPageChange={setPage}
                  />
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Si le véhicule a déjà un plan actif pour une opération (choix par défaut)
              </legend>
              <RadioGroup
                value={onExisting}
                onValueChange={(v) => setOnExisting(v as OnExisting)}
                aria-describedby="onExisting-error"
              >
                {(Object.keys(ON_EXISTING_LABELS) as OnExisting[]).map((k) => (
                  <div key={k} className="flex items-center gap-3">
                    <RadioGroupItem id={`apply-existing-${k}`} value={k} />
                    <Label htmlFor={`apply-existing-${k}`} className="font-normal">
                      {ON_EXISTING_LABELS[k]}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <FieldError errors={fieldErrors} name="onExisting" />
            </fieldset>

            {selected.size > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Choix par véhicule (facultatif)</legend>
                <p className="text-xs text-muted-foreground">
                  Un choix propre à un véhicule remplace le choix par défaut pour ses plans
                  existants.
                </p>
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
                  {[...selected.entries()].map(([vehicleId, code]) => {
                    // L'API signale perVehicle.N par position dans les choix envoyés (et non dans la sélection).
                    const choiceIndex = choices.findIndex((c) => c.vehicleId === vehicleId);
                    return (
                      <li
                        key={vehicleId}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                      >
                        <Label htmlFor={`apply-choice-${vehicleId}`} className="font-normal">
                          {code}
                        </Label>
                        <Select
                          value={perVehicle.get(vehicleId) ?? CHOICE_DEFAULT}
                          onValueChange={(v) => setChoice(vehicleId, v)}
                        >
                          <SelectTrigger
                            id={`apply-choice-${vehicleId}`}
                            className="w-56"
                            aria-describedby={
                              choiceIndex >= 0
                                ? `perVehicle.${choiceIndex}.vehicleId-error`
                                : undefined
                            }
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={CHOICE_DEFAULT}>
                              Par défaut ({SHORT_ON_EXISTING[onExisting].toLowerCase()})
                            </SelectItem>
                            {(Object.keys(ON_EXISTING_LABELS) as OnExisting[]).map((k) => (
                              <SelectItem key={k} value={k}>
                                {SHORT_ON_EXISTING[k]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    );
                  })}
                </ul>
                {Object.keys(fieldErrors)
                  .filter((k) => k.startsWith('perVehicle.'))
                  .map((k) => (
                    <FieldError key={k} errors={fieldErrors} name={k} />
                  ))}
              </fieldset>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="apply-sources">Relevés admis pour le calcul</Label>
              <Select value={sources} onValueChange={setSources}>
                <SelectTrigger
                  id="apply-sources"
                  className="w-full"
                  aria-describedby="apply-sources-hint acceptedSources-error"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SOURCES_DEFAULT}>
                    Par défaut (tous pour les nouveaux plans, inchangé pour les plans mis à jour)
                  </SelectItem>
                  {(Object.keys(ACCEPTED_SOURCES_LABELS) as AcceptedSources[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {ACCEPTED_SOURCES_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={fieldErrors} name="acceptedSources" />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={pending || !companyId}>
                {apply.isPending
                  ? 'Application…'
                  : previewImpact.isPending
                    ? 'Calcul de l’impact…'
                    : updatesSomePlans
                      ? 'Prévisualiser l’impact'
                      : `Appliquer à ${selected.size} véhicule${selected.size > 1 ? 's' : ''}`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
