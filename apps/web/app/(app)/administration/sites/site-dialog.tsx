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
import type { SiteView } from '@/lib/admin-types';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

/** Création (POST /sites) ou modification (PATCH /sites/:id) d'un site. */
export function SiteDialog({ companyId, companyLabel, site, onOpenChange, onSaved }: { companyId: string; companyLabel: string; site?: SiteView; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(site?.name ?? '');
  const [address, setAddress] = useState(site?.address ?? '');
  const [managerName, setManagerName] = useState(site?.managerName ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      site
        ? api<SiteView>(`/sites/${site.id}`, { method: 'PATCH', body: { name, address: address.trim() || null, managerName: managerName.trim() || null, expectedVersion: site.version } })
        : api<SiteView>('/sites', { method: 'POST', body: { companyId, name, address: address.trim() || undefined, managerName: managerName.trim() || undefined } }),
    onSuccess: () => {
      toast.success(site ? 'Site mis à jour.' : 'Site créé.');
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
        // Version obsolète : la liste est rechargée et la fenêtre fermée pour repartir de la version courante.
        if (error.status === 409 && error.code === 'VERSION_OBSOLETE') {
          void queryClient.invalidateQueries({ queryKey: ['sites'] });
          onOpenChange(false);
        }
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{site ? `Modifier le site ${site.name}` : 'Nouveau site'}</DialogTitle>
          <DialogDescription>Société {companyLabel}. L’adresse est un texte libre, jamais une position GPS.</DialogDescription>
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
            <Label htmlFor="site-name">Nom *</Label>
            <Input id="site-name" required value={name} onChange={(e) => setName(e.target.value)} aria-invalid={fieldErrors.name ? true : undefined} aria-describedby="name-error" />
            <FieldError errors={fieldErrors} name="name" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-address">Adresse</Label>
            <Textarea id="site-address" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} aria-describedby="address-error" />
            <FieldError errors={fieldErrors} name="address" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-manager">Responsable du site</Label>
            <Input id="site-manager" value={managerName} onChange={(e) => setManagerName(e.target.value)} aria-describedby="managerName-error" />
            <FieldError errors={fieldErrors} name="managerName" />
          </div>
          <FieldError errors={fieldErrors} name="companyId" />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : site ? 'Enregistrer' : 'Créer le site'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
