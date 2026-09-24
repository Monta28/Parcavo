'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import type { UploadedFile } from '@/components/odometer/attachment-field';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import { PhotoPreparationError, prepareCameraPhoto } from '@/lib/image-capture';

/**
 * Photo du compteur pour une ligne de la saisie rapide : téléversement privé (POST /attachments) en zone
 * temporaire, réencodé côté navigateur (D-267). Le rattachement au relevé est fait par l'API lors de
 * l'enregistrement de la ligne (POST /readings/batch, attachmentId), comme pour un relevé unitaire.
 */
export function LinePhoto({
  id,
  vehicleCode,
  companyId,
  value,
  onChange,
  disabled,
}: {
  id: string;
  vehicleCode: string;
  companyId: string;
  value: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const prepared = await prepareCameraPhoto(file);
      const form = new FormData();
      form.append('file', prepared);
      form.append('companyId', companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (att) => onChange({ id: att.id, name: att.originalName, mimeType: att.mimeType }),
  });
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <input
        ref={input}
        id={id}
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
      {value ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/v1/attachments/${value.id}/download`}
            alt={`Photo du compteur de ${vehicleCode}`}
            className="h-10 w-14 rounded border object-cover"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            Retirer<span className="sr-only"> la photo du compteur de {vehicleCode}</span>
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || upload.isPending}
          onClick={() => input.current?.click()}
          aria-describedby={upload.isError ? errorId : undefined}
        >
          {upload.isPending ? 'Envoi de la photo…' : 'Photo'}
          <span className="sr-only"> du compteur de {vehicleCode}</span>
        </Button>
      )}
      {upload.isError ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {upload.error instanceof PhotoPreparationError
            ? upload.error.message
            : isApiError(upload.error)
              ? upload.error.message
              : 'Téléversement impossible : la photo n’est pas jointe.'}
        </p>
      ) : null}
    </div>
  );
}
