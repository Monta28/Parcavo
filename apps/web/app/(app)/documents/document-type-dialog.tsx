'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { DOCUMENT_TYPES_KEY, DOCUMENTS_KEY, collectErrors, type FieldErrors } from '@/components/documents/document-helpers';
import { FormAlert } from '@/components/documents/document-form';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { DOCUMENT_OWNER_TYPE_LABELS, type DocumentOwnerType, type DocumentTypeView } from '@/lib/documents-types';
import type { VehicleCategory } from '@/lib/vehicles-types';

interface FormState {
  code: string;
  label: string;
  ownerType: DocumentOwnerType;
  hasExpiry: boolean;
  required: boolean;
  blocksCheckout: boolean;
  noticeDays: string;
  visibleToDriver: boolean;
  vehicleCategoryIds: string[];
  companyIds: string[];
}

function initial(type: DocumentTypeView | undefined): FormState {
  return {
    code: type?.code ?? '',
    label: type?.label ?? '',
    ownerType: type?.ownerType ?? 'VEHICULE',
    hasExpiry: type?.hasExpiry ?? true,
    required: type?.required ?? false,
    blocksCheckout: type?.blocksCheckout ?? false,
    noticeDays: type ? type.noticeDays.join(', ') : '',
    visibleToDriver: type?.visibleToDriver ?? false,
    vehicleCategoryIds: type?.vehicleCategoryIds ?? [],
    companyIds: type?.companyIds ?? [],
  };
}

/** Lecture de la liste de préavis saisie (« 30, 15, 7 ») : format seulement, bornes contrôlées par l'API. */
function parseNoticeDays(raw: string): number[] | null {
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

const TOP_LEVEL = ['code', 'label', 'ownerType', 'hasExpiry', 'required', 'blocksCheckout', 'noticeDays', 'visibleToDriver', 'vehicleCategoryIds', 'companyIds'];

/** Création (POST /document-types) ou modification (PATCH /document-types/:id, expectedVersion) d'un type de document. */
export function DocumentTypeDialog({ type, categories, categoriesPending, categoriesError, onClose }: { type?: DocumentTypeView; categories: VehicleCategory[]; categoriesPending: boolean; categoriesError: unknown; onClose: () => void }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initial(type));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: 'vehicleCategoryIds' | 'companyIds', id: string, checked: boolean) => setForm((f) => ({ ...f, [key]: checked ? (f[key].includes(id) ? f[key] : [...f[key], id]) : f[key].filter((x) => x !== id) }));
  const errors: FieldErrors = { ...fieldErrors, ...Object.fromEntries(['noticeDays', 'vehicleCategoryIds', 'companyIds'].map((k) => [k, collectErrors(fieldErrors, k)]).filter(([, v]) => (v as string[]).length > 0)) };

  const shownCategories = categories.filter((c) => c.status === 'ACTIF' || form.vehicleCategoryIds.includes(c.id));
  const shownCompanies = session.companies.filter((c) => c.status === 'ACTIF' || form.companyIds.includes(c.id));
  const hasExpiry = type ? type.hasExpiry : form.hasExpiry;
  const ownerType = type ? type.ownerType : form.ownerType;

  const save = useMutation({
    mutationFn: (noticeDays: number[] | undefined) =>
      type
        ? api<DocumentTypeView>(`/document-types/${type.id}`, {
            method: 'PATCH',
            body: {
              label: form.label.trim(),
              required: form.required,
              blocksCheckout: form.blocksCheckout,
              noticeDays,
              visibleToDriver: form.visibleToDriver,
              vehicleCategoryIds: type.ownerType === 'VEHICULE' ? form.vehicleCategoryIds : undefined,
              companyIds: form.companyIds,
              expectedVersion: type.version,
            },
          })
        : api<DocumentTypeView>('/document-types', {
            method: 'POST',
            body: {
              code: form.code.trim(),
              label: form.label.trim(),
              ownerType: form.ownerType,
              hasExpiry: form.hasExpiry,
              required: form.required,
              blocksCheckout: form.blocksCheckout,
              noticeDays,
              visibleToDriver: form.visibleToDriver,
              vehicleCategoryIds: form.ownerType === 'VEHICULE' ? form.vehicleCategoryIds : [],
              companyIds: form.companyIds,
            },
          }),
    onSuccess: (saved) => {
      toast.success(type ? `Type « ${saved.label} » mis à jour.` : `Type « ${saved.label} » créé.`);
      void queryClient.invalidateQueries({ queryKey: [DOCUMENT_TYPES_KEY] });
      void queryClient.invalidateQueries({ queryKey: [DOCUMENTS_KEY] });
      onClose();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setFormError('Enregistrement impossible.');
        toast.error('Enregistrement impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      const attached = Object.keys(error.fieldErrors).some((k) => TOP_LEVEL.includes(k.split('.')[0] ?? k));
      setFormError(attached ? null : error.message);
      toast.error(error.message);
      // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
      if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        void queryClient.invalidateQueries({ queryKey: [DOCUMENT_TYPES_KEY] });
        onClose();
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{type ? `Modifier le type « ${type.label} »` : 'Nouveau type de document'}</DialogTitle>
          <DialogDescription>
            {type ? 'Le code, l’objet et la présence d’une expiration ne sont pas modifiables. La conformité et les alertes sont recalculées après enregistrement.' : 'Le code, l’objet et la présence d’une expiration ne pourront plus être modifiés.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            setFormError(null);
            const local: FieldErrors = {};
            let noticeDays: number[] | undefined;
            // Préavis sans objet (champ masqué) pour un type sans date de fin : rien n'est lu ni envoyé.
            if (hasExpiry && form.noticeDays.trim()) {
              const parsed = parseNoticeDays(form.noticeDays);
              if (!parsed) local.noticeDays = ['Saisissez des nombres entiers de jours séparés par des virgules (ex. 30, 15, 7).'];
              else noticeDays = parsed;
            }
            if (!type && !form.code.trim()) local.code = ['Code requis.'];
            if (form.label.trim().length < 2) local.label = ['Libellé requis (2 caractères minimum).'];
            if (Object.keys(local).length > 0) {
              setFieldErrors(local);
              return;
            }
            save.mutate(noticeDays);
          }}
        >
          <FormAlert message={formError} />
          <div className="space-y-2">
            <Label htmlFor="doctype-code">Code{type ? '' : ' *'}</Label>
            <Input
              id="doctype-code"
              value={form.code}
              disabled={Boolean(type)}
              autoComplete="off"
              maxLength={30}
              onChange={(e) => update({ code: e.target.value.toUpperCase() })}
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={['doctype-code-hint', errors.code ? 'code-error' : ''].filter(Boolean).join(' ')}
            />
            <p id="doctype-code-hint" className="text-xs text-muted-foreground">
              Majuscules, chiffres, tirets ou soulignés (ex. ASSURANCE) ; 30 caractères maximum.
            </p>
            <FieldError errors={errors} name="code" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="doctype-label">Libellé *</Label>
            <Input id="doctype-label" value={form.label} maxLength={120} onChange={(e) => update({ label: e.target.value })} aria-invalid={errors.label ? true : undefined} aria-describedby={errors.label ? 'label-error' : undefined} />
            <FieldError errors={errors} name="label" />
          </div>

          <fieldset className="space-y-2 sm:col-span-2" aria-describedby={errors.ownerType ? 'ownerType-error' : undefined}>
            <legend className="text-sm font-medium">Objet concerné{type ? '' : ' *'}</legend>
            <RadioGroup value={ownerType} onValueChange={(v) => update({ ownerType: v as DocumentOwnerType })} disabled={Boolean(type)} className="flex flex-wrap gap-4">
              {(Object.keys(DOCUMENT_OWNER_TYPE_LABELS) as DocumentOwnerType[]).map((o) => (
                <div key={o} className="flex items-center gap-2">
                  <RadioGroupItem id={`doctype-owner-${o}`} value={o} />
                  <Label htmlFor={`doctype-owner-${o}`} className="font-normal">
                    {DOCUMENT_OWNER_TYPE_LABELS[o]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
            <FieldError errors={errors} name="ownerType" />
          </fieldset>

          <SwitchField id="doctype-hasExpiry" label="A une date de fin de validité" hint="Sans expiration : aucune date de fin saisie, aucune alerte d’échéance." checked={hasExpiry} disabled={Boolean(type)} onChange={(v) => update({ hasExpiry: v })} errors={errors} name="hasExpiry" />
          <SwitchField
            id="doctype-required"
            label="Requis"
            hint="Attendu pour chaque objet concerné : son absence donne « Manquant »."
            checked={form.required}
            onChange={(v) => update({ required: v, blocksCheckout: v ? form.blocksCheckout : false })}
            errors={errors}
            name="required"
          />
          <SwitchField
            id="doctype-blocksCheckout"
            label="Bloque un départ"
            hint="Absence ou expiration refusent un nouveau départ (jamais une restitution). Implique « requis »."
            checked={form.blocksCheckout}
            onChange={(v) => update({ blocksCheckout: v, required: v ? true : form.required })}
            errors={errors}
            name="blocksCheckout"
          />
          <SwitchField id="doctype-visibleToDriver" label="Visible par le conducteur" hint="Document d’un véhicule consultable par son conducteur pendant l’utilisation en cours. Un conducteur voit toujours ses propres documents." checked={form.visibleToDriver} onChange={(v) => update({ visibleToDriver: v })} errors={errors} name="visibleToDriver" />

          {hasExpiry ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="doctype-noticeDays">Préavis en jours</Label>
              <Input
                id="doctype-noticeDays"
                inputMode="numeric"
                placeholder="30, 15, 7"
                value={form.noticeDays}
                onChange={(e) => update({ noticeDays: e.target.value })}
                aria-invalid={errors.noticeDays ? true : undefined}
                aria-describedby={['doctype-noticeDays-hint', errors.noticeDays ? 'noticeDays-error' : ''].filter(Boolean).join(' ')}
              />
              <p id="doctype-noticeDays-hint" className="text-xs text-muted-foreground">
                Jusqu’à 5 paliers séparés par des virgules (0 à 365 jours).{' '}
                {type ? 'Laisser vide pour conserver les paliers actuels.' : 'Laisser vide pour appliquer le paramètre de l’organisation (préavis documents).'}
              </p>
              <FieldError errors={errors} name="noticeDays" />
            </div>
          ) : null}

          {ownerType === 'VEHICULE' ? (
            <fieldset className="space-y-2 sm:col-span-2" aria-describedby={['doctype-categories-hint', errors.vehicleCategoryIds ? 'vehicleCategoryIds-error' : ''].filter(Boolean).join(' ')}>
              <legend className="text-sm font-medium">Catégories de véhicule concernées</legend>
              <p id="doctype-categories-hint" className="text-xs text-muted-foreground">
                Aucune case cochée : toutes les catégories.
              </p>
              {categoriesPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Chargement des catégories…
                </p>
              ) : categoriesError ? (
                <p role="alert" className="text-sm text-destructive">
                  {isApiError(categoriesError) ? categoriesError.message : 'Catégories de véhicule indisponibles.'}
                </p>
              ) : shownCategories.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune catégorie de véhicule paramétrée.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {shownCategories.map((c) => (
                    <div key={c.id} className="flex items-center gap-2">
                      <Checkbox id={`doctype-cat-${c.id}`} checked={form.vehicleCategoryIds.includes(c.id)} onCheckedChange={(v) => toggle('vehicleCategoryIds', c.id, v === true)} />
                      <Label htmlFor={`doctype-cat-${c.id}`} className="font-normal">
                        {c.label}
                        {c.status !== 'ACTIF' ? ' (archivée)' : ''}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
              <FieldError errors={errors} name="vehicleCategoryIds" />
            </fieldset>
          ) : null}

          <fieldset className="space-y-2 sm:col-span-2" aria-describedby={['doctype-companies-hint', errors.companyIds ? 'companyIds-error' : ''].filter(Boolean).join(' ')}>
            <legend className="text-sm font-medium">Sociétés concernées</legend>
            <p id="doctype-companies-hint" className="text-xs text-muted-foreground">
              Aucune case cochée : toutes les sociétés.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {shownCompanies.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <Checkbox id={`doctype-company-${c.id}`} checked={form.companyIds.includes(c.id)} onCheckedChange={(v) => toggle('companyIds', c.id, v === true)} />
                  <Label htmlFor={`doctype-company-${c.id}`} className="font-normal">
                    {c.code} — {c.name}
                  </Label>
                </div>
              ))}
            </div>
            <FieldError errors={errors} name="companyIds" />
          </fieldset>

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : type ? 'Enregistrer' : 'Créer le type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SwitchField({ id, label, hint, checked, disabled, onChange, errors, name }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; errors: FieldErrors; name: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3 rounded-md border p-3">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-describedby={[`${id}-hint`, errors[name]?.length ? `${name}-error` : ''].filter(Boolean).join(' ')} />
        <div className="space-y-1">
          <Label htmlFor={id}>{label}</Label>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        </div>
      </div>
      <FieldError errors={errors} name={name} />
    </div>
  );
}
