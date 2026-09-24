'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView, PermitView } from '@/lib/drivers-types';
import { formatDate } from '@/lib/format';
import type { VehicleCategory } from '@/lib/vehicles-types';

/** Permis du conducteur (CDC 3.3) : numéro, catégories, dates et justificatif privé. */
export function PermitPanel({ driverId, companyId, permit, canEdit }: { driverId: string; companyId: string; permit: PermitView | undefined; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Permis de conduire</CardTitle>
        {canEdit && !editing ? (
          <CardAction>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              {permit ? 'Modifier le permis' : 'Renseigner le permis'}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="text-sm">
        {editing ? (
          <PermitForm driverId={driverId} companyId={companyId} permit={permit} onDone={() => setEditing(false)} />
        ) : permit ? (
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Numéro</dt>
              <dd className="font-medium">{permit.number}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Catégories</dt>
              <dd>{permit.categories.length > 0 ? permit.categories.join(', ') : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Délivré le</dt>
              <dd>{formatDate(permit.issuedOn)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Expire le</dt>
              <dd>{formatDate(permit.expiresOn)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Justificatif</dt>
              <dd>
                {permit.attachmentId ? (
                  <a href={`/api/v1/attachments/${permit.attachmentId}/download`} className="inline-flex items-center gap-1 underline underline-offset-4" target="_blank" rel="noopener noreferrer">
                    <Download className="size-4" aria-hidden="true" /> Télécharger le justificatif
                  </a>
                ) : (
                  'Aucun justificatif téléversé.'
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">Aucune information de permis enregistrée.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PermitForm({ driverId, companyId, permit, onDone }: { driverId: string; companyId: string; permit: PermitView | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [number, setNumber] = useState(permit?.number ?? '');
  const [categories, setCategories] = useState<string[]>(permit?.categories ?? []);
  const [newCategory, setNewCategory] = useState('');
  const [issuedOn, setIssuedOn] = useState(permit?.issuedOn ?? '');
  const [expiresOn, setExpiresOn] = useState(permit?.expiresOn ?? '');
  const [uploaded, setUploaded] = useState<AttachmentView | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Catégories exigées par le paramétrage des catégories de véhicules : proposées en cases à cocher.
  const vehicleCategories = useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api<VehicleCategory[]>('/vehicle-categories') });
  const configured = Array.from(new Set((vehicleCategories.data ?? []).flatMap((c) => c.requiredPermitCategories))).sort();
  const others = categories.filter((c) => !configured.includes(c));

  const toggle = (category: string, checked: boolean) => setCategories((list) => (checked ? (list.includes(category) ? list : [...list, category]) : list.filter((c) => c !== category)));
  const addCategory = () => {
    // Même normalisation que l'API (majuscules) pour éviter les doublons « b » / « B ».
    const value = newCategory.trim().toUpperCase();
    if (!value) return;
    toggle(value, true);
    setNewCategory('');
  };

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('companyId', companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (attachment) => {
      setUploaded(attachment);
      setFieldErrors((errors) => ({ ...errors, file: [], attachmentId: [] }));
      toast.success('Justificatif téléversé : il sera rattaché à l’enregistrement du permis.');
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors((errors) => ({ ...errors, file: error.fieldErrors.file ?? [error.message] }));
        toast.error(error.message);
      } else toast.error('Téléversement impossible.');
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api<PermitView>(`/drivers/${driverId}/permit`, {
        method: 'PUT',
        body: {
          number,
          categories,
          issuedOn: issuedOn || undefined,
          expiresOn: expiresOn || undefined,
          attachmentId: uploaded?.id,
        },
      }),
    onSuccess: () => {
      toast.success('Permis enregistré.');
      void queryClient.invalidateQueries({ queryKey: ['driver', driverId] });
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      onDone();
    },
    onError: (error) => {
      if (isApiError(error)) {
        setFieldErrors(error.fieldErrors);
        toast.error(error.message);
      } else toast.error('Enregistrement impossible.');
    },
  });

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setFieldErrors({});
        save.mutate();
      }}
    >
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="permit-number">Numéro du permis *</Label>
        <Input id="permit-number" required maxLength={50} value={number} onChange={(e) => setNumber(e.target.value)} aria-describedby="number-error" aria-invalid={Boolean(fieldErrors.number?.length)} />
        <FieldError errors={fieldErrors} name="number" />
      </div>

      <fieldset className="space-y-2 sm:col-span-2" aria-describedby="categories-error">
        <legend className="text-sm font-medium">Catégories</legend>
        {configured.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {configured.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <Checkbox checked={categories.includes(c)} onCheckedChange={(v) => toggle(c, v === true)} /> {c}
              </label>
            ))}
          </div>
        ) : null}
        {others.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Autres catégories retenues">
            {others.map((c) => (
              <li key={c} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm">
                {c}
                <button type="button" className="rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Retirer la catégorie ${c}`} onClick={() => toggle(c, false)}>
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-2">
          <Label htmlFor="permit-new-category" className="sr-only">
            Ajouter une catégorie
          </Label>
          <Input
            id="permit-new-category"
            className="max-w-48"
            maxLength={10}
            placeholder="Autre catégorie"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCategory();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addCategory} disabled={!newCategory.trim()}>
            Ajouter
          </Button>
        </div>
        <FieldError errors={fieldErrors} name="categories" />
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="permit-issued">Délivré le</Label>
        <Input id="permit-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} aria-describedby="issuedOn-error" aria-invalid={Boolean(fieldErrors.issuedOn?.length)} />
        <FieldError errors={fieldErrors} name="issuedOn" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="permit-expires">Expire le</Label>
        <Input id="permit-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} aria-describedby="expiresOn-error" aria-invalid={Boolean(fieldErrors.expiresOn?.length)} />
        <FieldError errors={fieldErrors} name="expiresOn" />
      </div>

      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="permit-file">Justificatif (PDF, JPEG ou PNG ; 10 Mo max)</Label>
        <input
          ref={fileInput}
          id="permit-file"
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="sr-only"
          tabIndex={-1}
          aria-describedby="permit-file-status file-error attachmentId-error"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = '';
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
            {upload.isPending ? 'Envoi…' : uploaded || permit?.attachmentId ? 'Remplacer le justificatif' : 'Choisir un fichier'}
          </Button>
          <span id="permit-file-status" className="text-muted-foreground" aria-live="polite">
            {uploaded ? `Nouveau justificatif prêt : ${uploaded.originalName}` : permit?.attachmentId ? 'Un justificatif est déjà rattaché.' : 'Aucun justificatif.'}
          </span>
        </div>
        <FieldError errors={fieldErrors} name="file" />
        <FieldError errors={fieldErrors} name="attachmentId" />
      </div>

      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={save.isPending || upload.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer le permis'}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
