'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { DepartmentView } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

/** Création (POST /departments) ou renommage (PATCH /departments/:id) d'un service. */
export function DepartmentDialog({ companyId, companyLabel, department, onOpenChange, onSaved }: { companyId: string; companyLabel: string; department?: DepartmentView; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(department?.name ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      department
        ? api<DepartmentView>(`/departments/${department.id}`, { method: 'PATCH', body: { name, expectedVersion: department.version } })
        : api<DepartmentView>('/departments', { method: 'POST', body: { companyId, name } }),
    onSuccess: () => {
      toast.success(department ? 'Service mis à jour.' : 'Service créé.');
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['departments'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{department ? `Renommer le service ${department.name}` : 'Nouveau service'}</DialogTitle>
          <DialogDescription>Société {companyLabel}. Le nom d’un service est unique dans la société.</DialogDescription>
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
          <div className="space-y-2">
            <Label htmlFor="department-name">Nom *</Label>
            <Input id="department-name" required value={name} onChange={(e) => setName(e.target.value)} aria-invalid={fieldErrors.name ? true : undefined} aria-describedby="name-error" />
            <FieldError errors={fieldErrors} name="name" />
          </div>
          <FieldError errors={fieldErrors} name="companyId" />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : department ? 'Enregistrer' : 'Créer le service'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
