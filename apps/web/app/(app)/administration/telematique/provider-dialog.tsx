'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { SimulatorNotice } from '@/components/telemetry/telemetry-display';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { ProviderKind, ProviderKindView, ProviderView } from '@/lib/telemetry-types';
import { collectErrors } from '../field-errors';
import { KIND_SETTINGS } from './provider-settings';
import { SettingsEditor } from './settings-editor';

interface FormState {
  name: string;
  kind: ProviderKind | '';
  baseUrl: string;
  syncIntervalMinutes: string;
  backfillDays: string;
  companyIds: string[];
  settings: Record<string, unknown>;
}

function initial(provider: ProviderView | undefined): FormState {
  return {
    name: provider?.name ?? '',
    kind: provider?.kind ?? '',
    baseUrl: provider?.baseUrl ?? '',
    syncIntervalMinutes: provider ? String(provider.syncIntervalMinutes) : '',
    backfillDays: provider?.backfillDays !== undefined ? String(provider.backfillDays) : '',
    companyIds: provider?.companyIds ?? [],
    settings: provider?.settings ?? {},
  };
}

function optionalInt(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

function sameCompanies(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Création (POST /telemetry/providers, brouillon) ou modification (PATCH) d'un fournisseur par
 * l'administrateur (CDC 14.6 ; D-112, D-292, D-303, D-304). Le canal est déduit du type par l'API ; les
 * secrets ne sont jamais saisis ici (écriture seule, depuis la fiche du fournisseur).
 */
export function ProviderDialog({ provider, onOpenChange, onSaved }: { provider?: ProviderView; onOpenChange: (open: boolean) => void; onSaved: (saved: ProviderView) => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initial(provider));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [settingsValid, setSettingsValid] = useState(true);
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const kinds = useQuery({ queryKey: ['telemetry', 'provider-kinds'], queryFn: () => api<ProviderKindView[]>('/telemetry/provider-kinds'), enabled: !provider });
  const spec = form.kind ? KIND_SETTINGS[form.kind] : undefined;
  const usesBaseUrl = spec?.baseUrl.mode === 'required';
  const companies = session.companies.filter((c) => c.status === 'ACTIF' || form.companyIds.includes(c.id));

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: form.name.trim(),
        baseUrl: usesBaseUrl ? form.baseUrl.trim() || null : undefined,
        settings: form.settings,
        syncIntervalMinutes: optionalInt(form.syncIntervalMinutes),
        backfillDays: optionalInt(form.backfillDays),
        // En modification, les sociétés ne sont renvoyées que si elles changent : une société archivée
        // depuis reste couverte sans bloquer les autres modifications (l'API refuse d'en ajouter une).
        companyIds: provider && sameCompanies(form.companyIds, provider.companyIds) ? undefined : form.companyIds,
      };
      return provider
        ? api<ProviderView>(`/telemetry/providers/${provider.id}`, { method: 'PATCH', body: { ...common, expectedVersion: provider.version } })
        : api<ProviderView>('/telemetry/providers', { method: 'POST', body: { ...common, kind: form.kind } });
    },
    onSuccess: (saved) => {
      toast.success(provider ? 'Fournisseur mis à jour.' : 'Fournisseur créé en brouillon. Déposez ses secrets puis activez-le.');
      void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
      onSaved(saved);
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['telemetry'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{provider ? `Modifier le fournisseur ${provider.name}` : 'Nouveau fournisseur télématique'}</DialogTitle>
          <DialogDescription>
            {provider
              ? `${provider.kindLabel}. Le type n’est pas modifiable ; une version obsolète est refusée.`
              : 'Le fournisseur est créé en brouillon : aucune donnée n’est lue avant son activation, et aucune tant qu’aucune société couverte n’a activé le module.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="provider-name">Nom *</Label>
            <Input id="provider-name" required value={form.name} onChange={(e) => update({ name: e.target.value })} aria-invalid={fieldErrors.name ? true : undefined} aria-describedby="name-error" />
            <FieldError errors={fieldErrors} name="name" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-kind">Type *</Label>
            {provider ? (
              <Input id="provider-kind" value={provider.kindLabel} readOnly disabled />
            ) : (
              <Select value={form.kind} onValueChange={(v) => update({ kind: v as ProviderKind, settings: {}, baseUrl: '' })}>
                <SelectTrigger id="provider-kind" aria-invalid={fieldErrors.kind ? true : undefined} aria-describedby="kind-error kind-hint">
                  <SelectValue placeholder={kinds.isPending ? 'Chargement…' : 'Choisir le type'} />
                </SelectTrigger>
                <SelectContent>
                  {(kinds.data ?? []).map((k) => (
                    <SelectItem key={k.kind} value={k.kind} disabled={!k.available}>
                      {k.label}
                      {!k.available && k.reason ? ` — ${k.reason}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p id="kind-hint" className="text-xs text-muted-foreground">
              Le canal (API, RAPPORT ou WEBHOOK) est déduit du type. Choix selon la qualification du fournisseur (annexe A).
            </p>
            {kinds.isError ? <p className="text-sm text-destructive">{isApiError(kinds.error) ? kinds.error.message : 'Types indisponibles.'}</p> : null}
            <FieldError errors={fieldErrors} name="kind" />
          </div>

          {form.kind === 'SIMULATEUR' ? (
            <div className="sm:col-span-2">
              <SimulatorNotice />
            </div>
          ) : null}

          {spec?.baseUrl.mode === 'required' ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="provider-baseUrl">URL de base de l’API</Label>
              <Input
                id="provider-baseUrl"
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder={spec.baseUrl.placeholder}
                value={form.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                aria-invalid={fieldErrors.baseUrl ? true : undefined}
                aria-describedby="baseUrl-hint baseUrl-error"
              />
              <p id="baseUrl-hint" className="text-xs text-muted-foreground">
                {spec.baseUrl.help} Obligatoire avant l’activation.
              </p>
              <FieldError errors={fieldErrors} name="baseUrl" />
            </div>
          ) : (
            <FieldError errors={fieldErrors} name="baseUrl" />
          )}

          <div className="space-y-2">
            <Label htmlFor="provider-interval">Intervalle de synchronisation (minutes)</Label>
            <Input
              id="provider-interval"
              type="number"
              inputMode="numeric"
              min={5}
              max={1440}
              step={1}
              placeholder="Paramètre du groupe (15)"
              value={form.syncIntervalMinutes}
              onChange={(e) => update({ syncIntervalMinutes: e.target.value })}
              aria-invalid={fieldErrors.syncIntervalMinutes ? true : undefined}
              aria-describedby="interval-hint syncIntervalMinutes-error"
            />
            <p id="interval-hint" className="text-xs text-muted-foreground">
              5 minutes au minimum, selon le quota du fournisseur.
            </p>
            <FieldError errors={fieldErrors} name="syncIntervalMinutes" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-backfill">Profondeur de la reprise initiale (jours)</Label>
            <Input
              id="provider-backfill"
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              step={1}
              placeholder="7"
              value={form.backfillDays}
              onChange={(e) => update({ backfillDays: e.target.value })}
              aria-invalid={fieldErrors.backfillDays ? true : undefined}
              aria-describedby="backfill-hint backfillDays-error"
            />
            <p id="backfill-hint" className="text-xs text-muted-foreground">
              Historique récupéré à la confirmation d’une association (0 à 90 jours).
            </p>
            <FieldError errors={fieldErrors} name="backfillDays" />
          </div>

          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-sm font-medium">Sociétés couvertes</legend>
            <p className="text-xs text-muted-foreground">Au moins une société est exigée pour l’activation. Retirer une société est refusé tant que des associations y sont ouvertes.</p>
            {companies.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune société active.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {companies.map((c) => {
                  const checked = form.companyIds.includes(c.id);
                  return (
                    <div key={c.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`provider-company-${c.id}`}
                        checked={checked}
                        onCheckedChange={(v) => update({ companyIds: v === true ? [...form.companyIds, c.id] : form.companyIds.filter((id) => id !== c.id) })}
                      />
                      <Label htmlFor={`provider-company-${c.id}`} className="font-normal">
                        {c.code} — {c.name}
                        {c.status !== 'ACTIF' ? ' (archivée)' : ''}
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}
            <FieldError errors={collectErrors(fieldErrors, 'companyIds')} name="companyIds" />
          </fieldset>

          {spec ? (
            <div className="sm:col-span-2">
              <SettingsEditor key={form.kind} spec={spec} value={form.settings} onChange={(settings) => update({ settings })} errors={fieldErrors} onValidityChange={setSettingsValid} />
            </div>
          ) : null}

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || !settingsValid || (!provider && !form.kind)}>
              {save.isPending ? 'Enregistrement…' : provider ? 'Enregistrer' : 'Créer en brouillon'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
