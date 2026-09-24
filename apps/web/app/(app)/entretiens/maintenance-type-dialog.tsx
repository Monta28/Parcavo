'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { MaintenanceTypeView } from '@/lib/maintenance-types';

/** Ajout (POST /maintenance-types) ou modification (PATCH /maintenance-types/:id) d'une opération du catalogue. */
export function MaintenanceTypeDialog({ type, onOpenChange, onSaved }: { type?: MaintenanceTypeView; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(type?.code ?? '');
  const [label, setLabel] = useState(type?.label ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      type
        ? api<MaintenanceTypeView>(`/maintenance-types/${type.id}`, { method: 'PATCH', body: { label, description: description.trim() || null, expectedVersion: type.version } })
        : api<MaintenanceTypeView>('/maintenance-types', { method: 'POST', body: { code, label, ...(description.trim() ? { description: description.trim() } : {}) } }),
    onSuccess: () => {
      toast.success(type ? 'Opération mise à jour.' : 'Opération ajoutée au catalogue.');
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['maintenance-types'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{type ? `Modifier l’opération ${type.code}` : 'Nouvelle opération d’entretien'}</DialogTitle>
          <DialogDescription>Le catalogue est commun à toutes les sociétés du groupe. Les intervalles se définissent par véhicule, dans les plans ou les modèles.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            save.mutate();
          }}
        >
          {type ? (
            <div className="space-y-2">
              <Label htmlFor="type-code">Code</Label>
              <Input id="type-code" value={type.code} readOnly disabled />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="type-code">Code *</Label>
              <Input
                id="type-code"
                required
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby="type-code-hint code-error"
              />
              <p id="type-code-hint" className="text-xs text-muted-foreground">
                Majuscules, chiffres, tirets ou soulignés ; 30 caractères maximum. Non modifiable ensuite.
              </p>
              <FieldError errors={fieldErrors} name="code" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="type-label">Libellé *</Label>
            <Input id="type-label" required value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={fieldErrors.label ? true : undefined} aria-describedby="label-error" />
            <FieldError errors={fieldErrors} name="label" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="type-description">Description</Label>
            <Textarea id="type-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={fieldErrors.description ? true : undefined} aria-describedby="description-error" />
            <FieldError errors={fieldErrors} name="description" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : type ? 'Enregistrer' : 'Ajouter l’opération'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
