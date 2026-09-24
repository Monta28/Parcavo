'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';

/** Photos du véhicule : téléversement privé puis rattachement explicite. */
export function PhotosPanel({ vehicleId, companyId, photoIds, canEdit }: { vehicleId: string; companyId: string; photoIds: string[]; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('companyId', companyId);
      const uploaded = await api<{ id: string }>('/attachments', { method: 'POST', formData: form });
      await api(`/vehicles/${vehicleId}/photos`, { method: 'POST', body: { attachmentId: uploaded.id } });
    },
    onSuccess: () => {
      toast.success('Photo ajoutée.');
      void queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Téléversement impossible.'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Photos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {photoIds.length === 0 ? <p className="text-sm text-muted-foreground">Aucune photo.</p> : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photoIds.map((id) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={id} src={`/api/v1/attachments/${id}/download`} alt="Photo du véhicule" className="aspect-video w-full rounded-md border object-cover" />
          ))}
        </div>
        {canEdit ? (
          <div>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              className="sr-only"
              aria-label="Choisir une photo"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
            <Button type="button" variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}>
              {upload.isPending ? 'Envoi…' : 'Ajouter une photo (JPEG ou PNG, 10 Mo max)'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
