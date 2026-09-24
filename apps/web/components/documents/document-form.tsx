'use client';

import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useRef } from 'react';
import { FieldError } from '@/components/forms/field-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import type { DocumentView } from '@/lib/documents-types';
import { describedBy, type FieldErrors } from './document-helpers';

/** Champs saisis d'une version de document (DocumentFieldsDto). Dates civiles AAAA-MM-JJ. */
export interface DocumentFieldsState {
  number: string;
  issuer: string;
  issuedOn: string;
  validFrom: string;
  validTo: string;
  notes: string;
}

export const EMPTY_FIELDS: DocumentFieldsState = { number: '', issuer: '', issuedOn: '', validFrom: '', validTo: '', notes: '' };

export function fieldsFromVersion(v: DocumentView): DocumentFieldsState {
  return {
    number: v.number ?? '',
    issuer: v.issuer ?? '',
    issuedOn: v.issuedOn ?? '',
    validFrom: v.validFrom ?? '',
    validTo: v.validTo ?? '',
    notes: v.notes ?? '',
  };
}

/** Corps envoyé à la création et au renouvellement : champs vides omis ; fin de validité seulement si le type expire. */
export function fieldsBody(fields: DocumentFieldsState, hasExpiry: boolean): Record<string, string | undefined> {
  return {
    number: fields.number.trim() || undefined,
    issuer: fields.issuer.trim() || undefined,
    issuedOn: fields.issuedOn || undefined,
    validFrom: fields.validFrom || undefined,
    validTo: hasExpiry ? fields.validTo || undefined : undefined,
    notes: fields.notes.trim() || undefined,
  };
}

/**
 * Champs d'une version : numéro, organisme, dates d'émission, de début et de fin de validité, notes.
 * hasExpiry : true (fin requise), false (fin interdite, champ masqué), null (type pas encore choisi).
 */
export function DocumentFieldInputs({ idPrefix, value, onChange, errors, hasExpiry }: { idPrefix: string; value: DocumentFieldsState; onChange: (patch: Partial<DocumentFieldsState>) => void; errors: FieldErrors; hasExpiry: boolean | null }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={id('number')}>Numéro</Label>
        <Input id={id('number')} maxLength={80} autoComplete="off" value={value.number} onChange={(e) => onChange({ number: e.target.value })} aria-invalid={errors.number?.length ? true : undefined} aria-describedby={describedBy(errors, 'number')} />
        <FieldError errors={errors} name="number" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('issuer')}>Organisme émetteur</Label>
        <Input id={id('issuer')} maxLength={160} value={value.issuer} onChange={(e) => onChange({ issuer: e.target.value })} aria-invalid={errors.issuer?.length ? true : undefined} aria-describedby={describedBy(errors, 'issuer')} />
        <FieldError errors={errors} name="issuer" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('issuedOn')}>Date d’émission</Label>
        <Input id={id('issuedOn')} type="date" value={value.issuedOn} onChange={(e) => onChange({ issuedOn: e.target.value })} aria-invalid={errors.issuedOn?.length ? true : undefined} aria-describedby={describedBy(errors, 'issuedOn')} />
        <FieldError errors={errors} name="issuedOn" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id('validFrom')}>Début de validité</Label>
        <Input id={id('validFrom')} type="date" value={value.validFrom} onChange={(e) => onChange({ validFrom: e.target.value })} aria-invalid={errors.validFrom?.length ? true : undefined} aria-describedby={describedBy(errors, 'validFrom')} />
        <FieldError errors={errors} name="validFrom" />
      </div>
      {hasExpiry === false ? (
        <p className="text-sm text-muted-foreground sm:col-span-2">Ce type de document n’a pas de date de fin de validité : aucune échéance n’est calculée.</p>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={id('validTo')}>Fin de validité{hasExpiry ? ' *' : ''}</Label>
          <Input
            id={id('validTo')}
            type="date"
            required={hasExpiry === true}
            disabled={hasExpiry === null}
            value={value.validTo}
            onChange={(e) => onChange({ validTo: e.target.value })}
            aria-invalid={errors.validTo?.length ? true : undefined}
            aria-describedby={describedBy(errors, 'validTo', `${id('validTo')}-hint`)}
          />
          <p id={`${id('validTo')}-hint`} className="text-xs text-muted-foreground">
            {hasExpiry === null ? 'Choisissez d’abord le type de document.' : 'Le document reste valable jusqu’à la fin de ce jour (fuseau du groupe).'}
          </p>
          <FieldError errors={errors} name="validTo" />
        </div>
      )}
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={id('notes')}>Notes</Label>
        <Textarea id={id('notes')} rows={2} maxLength={2000} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} aria-invalid={errors.notes?.length ? true : undefined} aria-describedby={describedBy(errors, 'notes')} />
        <FieldError errors={errors} name="notes" />
      </div>
    </>
  );
}

/**
 * Justificatif : téléversement privé (POST /attachments) en zone temporaire, rattaché par l'API à
 * l'enregistrement de la version. La société de l'objet est transmise pour le contrôle de périmètre.
 * En correction, `onRemoveExistingChange` permet de retirer le justificatif actuel (envoyé comme
 * attachmentId null : version « justificatif absent », fichier supprimé avec le motif).
 */
export function DocumentFileField({
  id,
  companyId,
  value,
  onChange,
  errors,
  existingAttachmentId,
  removeExisting = false,
  onRemoveExistingChange,
  disabledReason,
}: {
  id: string;
  companyId: string | null;
  value: AttachmentView | null;
  onChange: (file: AttachmentView | null) => void;
  errors: FieldErrors;
  existingAttachmentId?: string | null;
  /** Correction : le justificatif actuel sera retiré à l'enregistrement. */
  removeExisting?: boolean;
  onRemoveExistingChange?: (remove: boolean) => void;
  /** Motif d'indisponibilité (ex. objet pas encore choisi). */
  disabledReason?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      if (companyId) form.append('companyId', companyId);
      return api<AttachmentView>('/attachments', { method: 'POST', formData: form });
    },
    onSuccess: (attachment) => {
      onChange(attachment);
      onRemoveExistingChange?.(false);
    },
  });
  const uploadError = upload.isError ? (isApiError(upload.error) ? (upload.error.fieldErrors.file?.join(' ') ?? upload.error.message) : 'Téléversement impossible.') : null;
  const disabled = Boolean(disabledReason) || upload.isPending;
  const statusId = `${id}-status`;

  return (
    <div className="space-y-2 sm:col-span-2">
      <Label htmlFor={id}>Justificatif (PDF, JPEG ou PNG ; 10 Mo max)</Label>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button id={id} type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()} aria-describedby={describedBy(errors, 'attachmentId', statusId)}>
          {upload.isPending ? 'Envoi du fichier…' : value || (existingAttachmentId && !removeExisting) ? 'Remplacer le justificatif' : 'Choisir un fichier'}
        </Button>
        {value ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Retirer le fichier choisi
          </Button>
        ) : existingAttachmentId && onRemoveExistingChange ? (
          <Button type="button" variant="ghost" size="sm" className={removeExisting ? undefined : 'text-destructive'} onClick={() => onRemoveExistingChange(!removeExisting)}>
            {removeExisting ? 'Conserver le justificatif actuel' : 'Retirer le justificatif actuel'}
          </Button>
        ) : null}
      </div>
      <p id={statusId} className="text-sm text-muted-foreground" aria-live="polite">
        {disabledReason ? (
          disabledReason
        ) : value ? (
          `Fichier prêt : ${value.originalName} (rattaché à l’enregistrement${existingAttachmentId ? ', l’ancien justificatif est supprimé' : ''}).`
        ) : existingAttachmentId && removeExisting ? (
          'Le justificatif actuel sera retiré à l’enregistrement : la version sera signalée « justificatif absent » et le fichier supprimé (motif tracé dans l’audit).'
        ) : existingAttachmentId ? (
          <a href={`/api/v1/attachments/${existingAttachmentId}/download`} className="inline-flex items-center gap-1 underline underline-offset-4" target="_blank" rel="noopener noreferrer">
            <Download className="size-4" aria-hidden="true" /> Justificatif actuel
          </a>
        ) : (
          'Aucun fichier : la version sera signalée « justificatif absent ».'
        )}
      </p>
      {uploadError ? (
        <p role="alert" className="text-sm text-destructive">
          {uploadError}
        </p>
      ) : null}
      <FieldError errors={errors} name="attachmentId" />
    </div>
  );
}

/** Message d'erreur global du formulaire (règle métier 409/422 renvoyée par l'API, affichée telle quelle). */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:col-span-2">
      {message}
    </p>
  );
}
