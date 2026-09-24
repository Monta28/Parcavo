'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { VehicleCategory } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { collectErrors } from '../field-errors';

function parsePermits(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Création (POST /vehicle-categories) ou modification (PATCH /vehicle-categories/:id) d'une catégorie. */
export function CategoryDialog({ category, onOpenChange, onSaved }: { category?: VehicleCategory; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(category?.code ?? '');
  const [label, setLabel] = useState(category?.label ?? '');
  const [permits, setPermits] = useState((category?.requiredPermitCategories ?? []).join(', '));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const parsed = parsePermits(permits);

  const save = useMutation({
    mutationFn: () =>
      category
        ? api<VehicleCategory>(`/vehicle-categories/${category.id}`, { method: 'PATCH', body: { label, requiredPermitCategories: parsed, expectedVersion: category.version } })
        : api<VehicleCategory>('/vehicle-categories', { method: 'POST', body: { code, label, requiredPermitCategories: parsed } }),
    onSuccess: () => {
      toast.success(category ? 'Catégorie mise à jour.' : 'Catégorie créée.');
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['vehicle-categories'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  const permitErrors = collectErrors(fieldErrors, 'requiredPermitCategories');

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{category ? `Modifier la catégorie ${category.code}` : 'Nouvelle catégorie de véhicules'}</DialogTitle>
          <DialogDescription>Les catégories de permis exigées relèvent de votre paramétrage : aucune règle juridique n’est appliquée automatiquement.</DialogDescription>
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
          {category ? (
            <div className="space-y-2">
              <Label htmlFor="category-code">Code</Label>
              <Input id="category-code" value={category.code} readOnly disabled />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="category-code">Code *</Label>
              <Input
                id="category-code"
                required
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby="category-code-hint code-error"
              />
              <p id="category-code-hint" className="text-xs text-muted-foreground">
                Majuscules, chiffres, tirets ou soulignés ; 20 caractères maximum. Non modifiable ensuite.
              </p>
              <FieldError errors={fieldErrors} name="code" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="category-label">Libellé *</Label>
            <Input id="category-label" required value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={fieldErrors.label ? true : undefined} aria-describedby="label-error" />
            <FieldError errors={fieldErrors} name="label" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category-permits">Catégories de permis exigées</Label>
            <Input
              id="category-permits"
              placeholder="Ex. : B, C1"
              value={permits}
              onChange={(e) => setPermits(e.target.value)}
              aria-invalid={permitErrors.requiredPermitCategories ? true : undefined}
              aria-describedby="category-permits-hint requiredPermitCategories-error"
            />
            <p id="category-permits-hint" className="text-xs text-muted-foreground">
              Séparez les catégories par des virgules ou des espaces (10 au maximum). Laisser vide si aucun permis n’est exigé.
            </p>
            {parsed.length > 0 ? (
              <ul className="flex flex-wrap gap-1" aria-label="Catégories de permis saisies">
                {parsed.map((p, i) => (
                  <li key={`${p}-${i}`} className="rounded border bg-muted px-2 py-0.5 text-xs font-medium">
                    {p}
                  </li>
                ))}
              </ul>
            ) : null}
            <FieldError errors={permitErrors} name="requiredPermitCategories" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : category ? 'Enregistrer' : 'Créer la catégorie'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
