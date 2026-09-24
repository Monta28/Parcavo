'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import { PhotoPreparationError, prepareCameraPhoto } from '@/lib/image-capture';
import type { FieldErrors } from './reading-helpers';

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Téléversement privé d'un fichier (POST /attachments) en zone temporaire ; le rattachement à l'objet
 * métier est fait par l'API lors de l'enregistrement (relevé, segment de compteur). Les photos sont
 * réencodées côté navigateur avant envoi (D-267) ; un PDF est transmis tel quel.
 */
export function AttachmentField({
  id,
  label,
  hint,
  companyId,
  accept,
  capture,
  value,
  onChange,
  errors,
  errorName,
}: {
  id: string;
  label: string;
  hint?: string;
  companyId: string;
  accept: string;
  capture?: boolean;
  value: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
  errors: FieldErrors;
  errorName: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const prepared = file.type === 'application/pdf' ? file : await prepareCameraPhoto(file);
      const form = new FormData();
      form.append('file', prepared);
      form.append('companyId', companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (att) => onChange({ id: att.id, name: att.originalName, mimeType: att.mimeType }),
  });
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = errors[errorName]?.length ? `${errorName}-error` : undefined;
  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      <input
        ref={input}
        type="file"
        accept={accept}
        capture={capture ? 'environment' : undefined}
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
        <div className="flex flex-wrap items-center gap-3">
          {value.mimeType.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/attachments/${value.id}/download`}
              alt={`Aperçu : ${value.name}`}
              className="h-16 w-24 rounded-md border object-cover"
            />
          ) : null}
          <span className="text-sm">{value.name}</span>
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(null)}
            aria-labelledby={`${id}-label ${id}`}
            aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          >
            Retirer le fichier
          </Button>
        </div>
      ) : (
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
          aria-labelledby={`${id}-label ${id}`}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        >
          {upload.isPending ? 'Envoi du fichier…' : 'Choisir un fichier'}
        </Button>
      )}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {upload.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {upload.error instanceof PhotoPreparationError
            ? upload.error.message
            : isApiError(upload.error)
              ? upload.error.message
              : 'Téléversement impossible : le fichier n’est pas joint.'}
        </p>
      ) : null}
      <FieldError errors={errors} name={errorName} />
    </div>
  );
}
