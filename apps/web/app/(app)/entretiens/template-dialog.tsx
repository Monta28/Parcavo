'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { MaintenanceTemplateView, MaintenanceTypeView } from '@/lib/maintenance-types';
import { collectErrors } from '../administration/field-errors';
import { EMPTY_INTERVALS, IntervalFields, intervalsFrom, intervalsPayloadWithoutEmpty, type IntervalsForm } from './interval-fields';

interface ItemForm {
  key: number;
  maintenanceTypeId: string;
  intervals: IntervalsForm;
}

/**
 * Création (POST /maintenance-templates) ou modification (PATCH /maintenance-templates/:id) d'un modèle
 * de plan (administrateur). Les plans déjà copiés ne changent pas : la copie est un instantané (D-198).
 */
export function TemplateDialog({ template, onOpenChange, onSaved }: { template?: MaintenanceTemplateView; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const nextKey = useRef(0);
  const newKey = () => {
    nextKey.current += 1;
    return nextKey.current;
  };
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [items, setItems] = useState<ItemForm[]>(() =>
    template && template.items.length > 0
      ? template.items.map((i, index) => ({ key: -(index + 1), maintenanceTypeId: i.maintenanceTypeId, intervals: intervalsFrom(i) }))
      : [{ key: 0, maintenanceTypeId: '', intervals: EMPTY_INTERVALS }],
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const types = useQuery({ queryKey: ['maintenance-types', 'actifs'], queryFn: () => api<MaintenanceTypeView[]>('/maintenance-types') });
  const activeIds = new Set((types.data ?? []).map((t) => t.id));
  // Lignes existantes dont l'opération a été archivée depuis au catalogue (statut renvoyé par l'API) : l'API
  // les accepte inchangées (elles ne sont plus copiées) et refuse toute modification (TYPE_ARCHIVE, sur la ligne).
  const archivedItems = (template?.items ?? []).filter((i) => i.maintenanceTypeStatus === 'ARCHIVE');
  const archivedIds = new Set(archivedItems.map((i) => i.maintenanceTypeId));
  // Options de sélection ajoutées une fois le catalogue chargé (sinon toutes les lignes du modèle sont déjà proposées).
  const archivedOptions = types.data ? archivedItems.filter((i) => !activeIds.has(i.maintenanceTypeId)) : [];

  const updateItem = (key: number, patch: Partial<ItemForm>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const save = useMutation({
    mutationFn: () => {
      const payloadItems = items.map((i) => ({ maintenanceTypeId: i.maintenanceTypeId, ...intervalsPayloadWithoutEmpty(i.intervals) }));
      return template
        ? api<MaintenanceTemplateView>(`/maintenance-templates/${template.id}`, {
            method: 'PATCH',
            body: { name, description: description.trim() || null, items: payloadItems, expectedVersion: template.version },
          })
        : api<MaintenanceTemplateView>('/maintenance-templates', { method: 'POST', body: { name, ...(description.trim() ? { description: description.trim() } : {}), items: payloadItems } });
    },
    onSuccess: () => {
      toast.success(template ? 'Modèle mis à jour. Les plans déjà copiés ne sont pas modifiés.' : 'Modèle créé.');
      onSaved();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        toast.error('Enregistrement impossible.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);
      toast.error(error.message);
      if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
        void queryClient.invalidateQueries({ queryKey: ['maintenance-templates'] });
        onOpenChange(false);
      }
    },
  });

  const itemsErrors: Record<string, string[]> = fieldErrors.items ? { items: fieldErrors.items } : {};

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{template ? `Modifier le modèle « ${template.name} »` : 'Nouveau modèle de plan'}</DialogTitle>
          <DialogDescription>Un modèle regroupe des opérations et leurs intervalles, à copier vers plusieurs véhicules. La copie ne modifie pas les historiques ; aucun intervalle universel n’est imposé.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            const missing: Record<string, string[]> = {};
            items.forEach((item, index) => {
              if (!item.maintenanceTypeId) missing[`items.${index}.maintenanceTypeId`] = ['Choisissez une opération.'];
            });
            setFieldErrors(missing);
            if (Object.keys(missing).length === 0) save.mutate();
          }}
        >
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="template-name">Nom *</Label>
              <Input id="template-name" required value={name} onChange={(e) => setName(e.target.value)} aria-invalid={fieldErrors.name ? true : undefined} aria-describedby="name-error" />
              <FieldError errors={fieldErrors} name="name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-description">Description</Label>
              <Textarea id="template-description" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby="description-error" />
              <FieldError errors={fieldErrors} name="description" />
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Opérations du modèle</legend>
            {types.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Catalogue indisponible : {isApiError(types.error) ? types.error.message : 'réessayez plus tard.'}
              </p>
            ) : types.data && types.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">Catalogue vide : ajoutez d’abord des opérations (onglet Catalogue).</p>
            ) : null}
            <FieldError errors={itemsErrors} name="items" />
            {items.map((item, index) => {
              const prefix = `items.${index}.`;
              const typeErrors = collectErrors(fieldErrors, `${prefix}maintenanceTypeId`);
              return (
                <div key={item.key} className="space-y-3 rounded-md border p-3">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Label htmlFor={`template-item-${item.key}-type`}>Opération {index + 1} *</Label>
                      <Select value={item.maintenanceTypeId} onValueChange={(v) => updateItem(item.key, { maintenanceTypeId: v })}>
                        <SelectTrigger
                          id={`template-item-${item.key}-type`}
                          className="w-full"
                          aria-invalid={typeErrors[`${prefix}maintenanceTypeId`] ? true : undefined}
                          aria-describedby={`${prefix}maintenanceTypeId-error`}
                        >
                          <SelectValue placeholder={types.isPending ? 'Chargement…' : 'Choisir une opération'} />
                        </SelectTrigger>
                        <SelectContent>
                          {(types.data ?? []).map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.label}
                            </SelectItem>
                          ))}
                          {archivedOptions.map((i) => (
                            <SelectItem key={i.maintenanceTypeId} value={i.maintenanceTypeId}>
                              {i.maintenanceTypeLabel} (hors catalogue actif)
                            </SelectItem>
                          ))}
                          {/* Catalogue non encore chargé (ou indisponible) : les opérations actuelles du modèle restent lisibles. */}
                          {!types.data
                            ? (template?.items ?? []).map((i) => (
                                <SelectItem key={i.maintenanceTypeId} value={i.maintenanceTypeId}>
                                  {i.maintenanceTypeLabel}
                                </SelectItem>
                              ))
                            : null}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={items.length <= 1}
                      onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                      aria-label={`Retirer l’opération ${index + 1}`}
                      title="Retirer cette opération"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  {archivedIds.has(item.maintenanceTypeId) ? (
                    <p className="text-xs text-warning-foreground">
                      Opération archivée au catalogue : la ligne peut être conservée telle quelle (elle n’est plus copiée vers les véhicules), mais toute modification de ses intervalles sera refusée. Retirez-la ou réactivez l’opération (onglet Catalogue).
                    </p>
                  ) : null}
                  <FieldError errors={typeErrors} name={`${prefix}maintenanceTypeId`} />
                  <IntervalFields value={item.intervals} onChange={(patch) => updateItem(item.key, { intervals: { ...item.intervals, ...patch } })} errors={fieldErrors} idPrefix={`template-item-${item.key}`} errorPrefix={prefix} />
                </div>
              );
            })}
            <Button type="button" variant="outline" size="sm" disabled={items.length >= 50} onClick={() => setItems((list) => [...list, { key: newKey(), maintenanceTypeId: '', intervals: EMPTY_INTERVALS }])}>
              <Plus className="size-4" aria-hidden="true" /> Ajouter une opération
            </Button>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : template ? 'Enregistrer' : 'Créer le modèle'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
