'use client';

import { useMutation } from '@tanstack/react-query';
import { Camera, X } from 'lucide-react';
import { useRef } from 'react';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import { PhotoPreparationError, prepareCameraPhoto } from '@/lib/image-capture';
import { type FieldErrors, describedBy } from './ops-helpers';

export interface UploadedPhoto {
  id: string;
  name: string;
}

/**
 * Photos d'un signalement : réduites en JPEG dans le navigateur puis téléversées en zone temporaire
 * (POST /attachments) ; l'API les rattache à l'incident lors de l'enregistrement (photoAttachmentIds).
 */
export function PhotoUploader({
  id,
  label,
  companyId,
  photos,
  onChange,
  errors,
  errorName = 'photoAttachmentIds',
  max = 10,
  large = false,
  disabledReason,
}: {
  id: string;
  label: string;
  /** Société de rattachement du fichier ; null : téléversement indisponible (véhicule non choisi). */
  companyId: string | null;
  photos: UploadedPhoto[];
  onChange: (photos: UploadedPhoto[]) => void;
  errors: FieldErrors;
  errorName?: string;
  max?: number;
  large?: boolean;
  disabledReason?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const prepared = await prepareCameraPhoto(file);
      const form = new FormData();
      form.append('file', prepared);
      if (companyId) form.append('companyId', companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (att) => onChange([...photos, { id: att.id, name: att.originalName }]),
  });
  const uploadError = upload.error instanceof PhotoPreparationError ? upload.error.message : isApiError(upload.error) ? upload.error.message : upload.error ? 'Téléversement impossible : la photo n’est pas jointe.' : null;
  const full = photos.length >= max;
  const unavailable = companyId === null;

  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }}
      />
      {photos.length > 0 ? (
        <ul className="flex flex-wrap gap-3" aria-label="Photos jointes">
          {photos.map((p, index) => (
            <li key={p.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/v1/attachments/${p.id}/download`} alt={`Photo jointe ${index + 1}`} className="h-20 w-28 rounded-md border object-cover" />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute -top-2 -right-2 size-7 rounded-full"
                onClick={() => onChange(photos.filter((x) => x.id !== p.id))}
                aria-label={`Retirer la photo ${index + 1}`}
                title="Retirer la photo"
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        id={id}
        type="button"
        variant="outline"
        className={large ? 'h-12 w-full' : undefined}
        disabled={upload.isPending || full || unavailable}
        onClick={() => input.current?.click()}
        aria-labelledby={`${id}-label ${id}`}
        aria-describedby={describedBy(errors, errorName, `${id}-hint`)}
      >
        <Camera className="size-4" aria-hidden="true" />
        {upload.isPending ? 'Envoi de la photo…' : photos.length > 0 ? 'Ajouter une autre photo' : 'Prendre ou choisir une photo'}
      </Button>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {unavailable && disabledReason ? disabledReason : full ? `${max} photos au maximum.` : `Facultatif, ${max} photos au maximum. Chaque photo est réduite en JPEG avant l’envoi.`}
      </p>
      {uploadError ? (
        <p role="alert" className="text-sm text-destructive">
          {uploadError}
        </p>
      ) : null}
      <FieldError errors={errors} name={errorName} />
    </div>
  );
}
