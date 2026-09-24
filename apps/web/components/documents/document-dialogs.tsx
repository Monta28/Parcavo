'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { useAppScope } from '@/components/layout/session-context';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError, type ApiRequestError } from '@/lib/api-error';
import type { AttachmentView } from '@/lib/drivers-types';
import { DOCUMENT_OWNER_TYPE_LABELS, type DocumentOwnerType, type DocumentTypeView, type DocumentView } from '@/lib/documents-types';
import { formatDate } from '@/lib/format';
import { DOCUMENT_TYPES_KEY, describedBy, useDocumentsAccess, useInvalidateDocuments, type FieldErrors } from './document-helpers';
import { DocumentFieldInputs, DocumentFileField, EMPTY_FIELDS, FormAlert, fieldsBody, fieldsFromVersion, type DocumentFieldsState } from './document-form';
import { DriverOwnerPicker, VehicleOwnerPicker, type OwnerOption } from './owner-pickers';

/** Types de documents (GET /document-types) ; includeArchived pour retrouver le type d'une version ancienne. */
export function useDocumentTypes(includeArchived = false) {
  return useQuery({
    queryKey: [DOCUMENT_TYPES_KEY, includeArchived ? 'tous' : 'actifs'],
    queryFn: () => api<DocumentTypeView[]>(`/document-types${includeArchived ? '?includeArchived=true' : ''}`),
  });
}

/** Préremplissage de l'enregistrement : objet et/ou type imposés (ligne MANQUANT, fiche véhicule ou conducteur). */
export interface CreatePreset {
  ownerType?: DocumentOwnerType;
  owner?: OwnerOption;
  documentTypeId?: string;
}

/** Version à renouveler (depuis une version ou une ligne de conformité). */
export interface RenewTarget {
  versionId: string;
  documentTypeId: string;
  documentTypeLabel: string;
  ownerLabel: string;
  companyId: string;
  vehicleId: string | null;
  driverId: string | null;
}

export function renewTargetFromVersion(v: DocumentView): RenewTarget {
  return { versionId: v.id, documentTypeId: v.documentTypeId, documentTypeLabel: v.documentTypeLabel, ownerLabel: v.ownerLabel, companyId: v.companyId, vehicleId: v.vehicleId, driverId: v.driverId };
}

export type DocumentAction = { kind: 'create'; preset: CreatePreset } | { kind: 'renew'; target: RenewTarget } | { kind: 'correct'; version: DocumentView } | { kind: 'archive'; version: DocumentView };

/** Affiche le dialogue correspondant à l'action demandée (un seul à la fois). */
export function DocumentActionDialogs({ action, onClose, onSaved }: { action: DocumentAction | null; onClose: () => void; onSaved?: (saved: DocumentView) => void }) {
  if (!action) return null;
  switch (action.kind) {
    case 'create':
      return <CreateDocumentDialog preset={action.preset} onClose={onClose} onSaved={onSaved} />;
    case 'renew':
      return <RenewDocumentDialog key={action.target.versionId} target={action.target} onClose={onClose} onSaved={onSaved} />;
    case 'correct':
      return <CorrectDocumentDialog key={action.version.id} version={action.version} onClose={onClose} onSaved={onSaved} />;
    case 'archive':
      return <ArchiveDocumentDialog key={action.version.id} version={action.version} onClose={onClose} onSaved={onSaved} />;
  }
}

/** Erreurs d'un envoi : erreurs par champ, sinon message métier global (409/422 affichés tels quels). */
function useSubmitErrors() {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const reset = () => {
    setFieldErrors({});
    setFormError(null);
  };
  const apply = (error: unknown, fallback: string, knownFields: readonly string[]) => {
    if (!isApiError(error)) {
      setFormError(fallback);
      toast.error(fallback);
      return;
    }
    setFieldErrors(error.fieldErrors);
    const attached = Object.keys(error.fieldErrors).some((k) => knownFields.includes(k.split('.')[0] ?? k));
    setFormError(attached ? null : error.message);
    toast.error(error.message);
  };
  return { fieldErrors, setFieldErrors, formError, reset, apply };
}

function isObsolete(error: unknown): error is ApiRequestError {
  return isApiError(error) && error.status === 409 && error.code === 'VERSION_OBSOLETE';
}

const FIELD_NAMES = ['number', 'issuer', 'issuedOn', 'validFrom', 'validTo', 'notes', 'attachmentId'] as const;

/**
 * Type archivé : l'API refuse renouvellement et correction (422 TYPE_ARCHIVE, message explicite) ; le motif
 * est annoncé avant l'envoi. Seul l'archivage d'une version erronée reste possible.
 */
function ArchivedTypeNotice({ type }: { type: DocumentTypeView | null }) {
  if (type?.status !== 'ARCHIVE') return null;
  return (
    <Alert role="note" className="sm:col-span-2">
      <Info className="size-4" aria-hidden="true" />
      <AlertDescription>
        Le type « {type.label} » est archivé : ses versions ne peuvent plus être renouvelées ni corrigées. L’administrateur peut le réactiver dans l’onglet « Types ».
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Enregistrer un document (POST /documents)
// ---------------------------------------------------------------------------

export function CreateDocumentDialog({ preset, onClose, onSaved }: { preset: CreatePreset; onClose: () => void; onSaved?: (saved: DocumentView) => void }) {
  const { companyId: scopeCompanyId } = useAppScope();
  const { canManageIn, companyCode } = useDocumentsAccess();
  const invalidate = useInvalidateDocuments();
  const types = useDocumentTypes();
  const ownerLocked = Boolean(preset.owner);
  const typeLocked = Boolean(preset.documentTypeId);
  const [typeId, setTypeId] = useState(preset.documentTypeId ?? '');
  const [owner, setOwner] = useState<OwnerOption | null>(preset.owner ?? null);
  const [fields, setFields] = useState<DocumentFieldsState>(EMPTY_FIELDS);
  const [file, setFile] = useState<AttachmentView | null>(null);
  const errors = useSubmitErrors();

  const available = (types.data ?? []).filter((t) => !preset.ownerType || t.ownerType === preset.ownerType);
  const type = (types.data ?? []).find((t) => t.id === typeId) ?? null;
  const ownerType: DocumentOwnerType | null = type?.ownerType ?? preset.ownerType ?? null;

  const save = useMutation({
    mutationFn: () => {
      if (!type || !owner) throw new Error('incomplet');
      return api<DocumentView>('/documents', {
        method: 'POST',
        body: {
          documentTypeId: type.id,
          vehicleId: type.ownerType === 'VEHICULE' ? owner.id : undefined,
          driverId: type.ownerType === 'CONDUCTEUR' ? owner.id : undefined,
          ...fieldsBody(fields, type.hasExpiry),
          attachmentId: file?.id,
        },
      });
    },
    onSuccess: (saved) => {
      toast.success(`${saved.documentTypeLabel} enregistré pour ${saved.ownerLabel}.`);
      invalidate({ vehicleId: saved.vehicleId, driverId: saved.driverId });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => errors.apply(error, 'Enregistrement impossible.', [...FIELD_NAMES, 'documentTypeId', 'vehicleId', 'driverId']),
  });

  const changeType = (id: string) => {
    const next = (types.data ?? []).find((t) => t.id === id);
    setTypeId(id);
    if (!ownerLocked && owner && next && next.ownerType !== ownerType) {
      setOwner(null);
      setFile(null);
    }
  };

  const ownerField = type?.ownerType === 'CONDUCTEUR' ? 'driverId' : 'vehicleId';

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Enregistrer un document</DialogTitle>
          <DialogDescription>Nouvelle version d’un document pour un véhicule ou un conducteur. Le statut (valide, à renouveler, expiré) est calculé par le serveur à partir des dates.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            errors.reset();
            const local: FieldErrors = {};
            if (!type) local.documentTypeId = ['Choisissez le type de document.'];
            if (!owner) local[ownerField] = [ownerType === 'CONDUCTEUR' ? 'Choisissez le conducteur.' : 'Choisissez le véhicule.'];
            // Contrôle d'affichage seulement (vue « Toutes mes sociétés ») : l'API reste seule juge de l'autorisation.
            else if (!canManageIn(owner.companyId)) local[ownerField] = [`Vous n’avez pas la permission « Gérer les documents » pour la société ${companyCode(owner.companyId)}.`];
            if (Object.keys(local).length > 0) {
              errors.setFieldErrors(local);
              return;
            }
            save.mutate();
          }}
        >
          <FormAlert message={errors.formError} />
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={typeLocked && type ? undefined : 'doc-create-type'}>Type de document *</Label>
            {typeLocked && type ? (
              <p className="text-sm font-medium">
                {type.label} <span className="font-normal text-muted-foreground">· {DOCUMENT_OWNER_TYPE_LABELS[type.ownerType]}</span>
              </p>
            ) : (
              <Select value={typeId} onValueChange={changeType} disabled={types.isPending || typeLocked}>
                <SelectTrigger id="doc-create-type" className="w-full" aria-invalid={errors.fieldErrors.documentTypeId ? true : undefined} aria-describedby={describedBy(errors.fieldErrors, 'documentTypeId', 'doc-create-type-hint')}>
                  <SelectValue placeholder={types.isPending ? 'Chargement des types…' : 'Choisir un type'} />
                </SelectTrigger>
                <SelectContent>
                  {available.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label} · {DOCUMENT_OWNER_TYPE_LABELS[t.ownerType]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {types.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {isApiError(types.error) ? types.error.message : 'Types de documents indisponibles.'}
              </p>
            ) : type ? (
              <p id="doc-create-type-hint" className="text-xs text-muted-foreground">
                {type.hasExpiry ? 'Document avec date de fin de validité.' : 'Document sans date de fin de validité.'}
                {type.blocksCheckout ? ' Son absence ou son expiration bloque un nouveau départ.' : ''}
              </p>
            ) : types.data && available.length === 0 ? (
              <p id="doc-create-type-hint" className="text-xs text-muted-foreground">
                Aucun type de document actif{preset.ownerType ? ` pour un ${DOCUMENT_OWNER_TYPE_LABELS[preset.ownerType].toLowerCase()}` : ''} : l’administrateur les paramètre dans l’onglet « Types ».
              </p>
            ) : null}
            <FieldError errors={errors.fieldErrors} name="documentTypeId" />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={(ownerLocked && owner) || !ownerType ? undefined : 'doc-create-owner'}>{ownerType === 'CONDUCTEUR' ? 'Conducteur *' : ownerType === 'VEHICULE' ? 'Véhicule *' : 'Objet concerné *'}</Label>
            {ownerLocked && owner ? (
              <p className="text-sm font-medium">
                {owner.label}
              </p>
            ) : ownerType === 'CONDUCTEUR' ? (
              <DriverOwnerPicker
                id="doc-create-owner"
                value={owner}
                onChange={(o) => {
                  if (o?.companyId !== owner?.companyId) setFile(null);
                  setOwner(o);
                }}
                companyId={scopeCompanyId}
                invalid={Boolean(errors.fieldErrors.driverId)}
                describedBy={describedBy(errors.fieldErrors, 'driverId')}
              />
            ) : ownerType === 'VEHICULE' ? (
              <VehicleOwnerPicker
                id="doc-create-owner"
                value={owner}
                onChange={(o) => {
                  if (o?.companyId !== owner?.companyId) setFile(null);
                  setOwner(o);
                }}
                companyId={scopeCompanyId}
                invalid={Boolean(errors.fieldErrors.vehicleId)}
                describedBy={describedBy(errors.fieldErrors, 'vehicleId')}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Choisissez d’abord le type : il détermine s’il s’agit d’un véhicule ou d’un conducteur.
              </p>
            )}
            <FieldError errors={errors.fieldErrors} name="vehicleId" />
            <FieldError errors={errors.fieldErrors} name="driverId" />
          </div>

          <DocumentFieldInputs idPrefix="doc-create" value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} errors={errors.fieldErrors} hasExpiry={type ? type.hasExpiry : null} />
          <DocumentFileField id="doc-create-file" companyId={owner?.companyId ?? null} value={file} onChange={setFile} errors={errors.fieldErrors} disabledReason={owner ? undefined : 'Choisissez d’abord l’objet concerné pour joindre un fichier.'} />

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || types.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer le document'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Renouveler (POST /documents/:id/renew)
// ---------------------------------------------------------------------------

export function RenewDocumentDialog({ target, onClose, onSaved }: { target: RenewTarget; onClose: () => void; onSaved?: (saved: DocumentView) => void }) {
  const invalidate = useInvalidateDocuments();
  const types = useDocumentTypes(true);
  const type = (types.data ?? []).find((t) => t.id === target.documentTypeId) ?? null;
  const [fields, setFields] = useState<DocumentFieldsState>(EMPTY_FIELDS);
  const [file, setFile] = useState<AttachmentView | null>(null);
  const errors = useSubmitErrors();

  const save = useMutation({
    mutationFn: () => api<DocumentView>(`/documents/${target.versionId}/renew`, { method: 'POST', body: { ...fieldsBody(fields, type?.hasExpiry ?? true), attachmentId: file?.id } }),
    onSuccess: (saved) => {
      toast.success(`Nouvelle version de ${saved.documentTypeLabel} enregistrée.`);
      invalidate({ vehicleId: saved.vehicleId, driverId: saved.driverId });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => errors.apply(error, 'Renouvellement impossible.', FIELD_NAMES),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Renouveler : {target.documentTypeLabel} · {target.ownerLabel}
          </DialogTitle>
          <DialogDescription>Le renouvellement crée une nouvelle version liée à la précédente ; l’historique est conservé.</DialogDescription>
        </DialogHeader>
        <Alert role="note">
          <Info className="size-4" aria-hidden="true" />
          <AlertDescription>
            Une version future ne remplace pas la version en cours : elle ne s’applique qu’à partir de sa date de début, la version en cours restant retenue jusqu’à sa fin de validité.
          </AlertDescription>
        </Alert>
        {types.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Chargement du type de document…
          </p>
        ) : types.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {isApiError(types.error) ? types.error.message : 'Type de document indisponible.'}
          </p>
        ) : (
          <form
            className="grid gap-4 sm:grid-cols-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              errors.reset();
              save.mutate();
            }}
          >
            <FormAlert message={errors.formError} />
            <ArchivedTypeNotice type={type} />
            <DocumentFieldInputs idPrefix="doc-renew" value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} errors={errors.fieldErrors} hasExpiry={type ? type.hasExpiry : true} />
            <DocumentFileField id="doc-renew-file" companyId={target.companyId} value={file} onChange={setFile} errors={errors.fieldErrors} />
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
                Annuler
              </Button>
              <Button type="submit" disabled={save.isPending || type?.status === 'ARCHIVE'}>
                {save.isPending ? 'Enregistrement…' : 'Enregistrer la nouvelle version'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Corriger une faute de saisie (PATCH /documents/:id)
// ---------------------------------------------------------------------------

const DATE_FIELDS = ['issuedOn', 'validFrom', 'validTo'] as const;

/** Date d'une correction : valeur saisie, null si une date enregistrée a été vidée (effacement), sinon absente. */
function correctedDate(value: string, initial: string): string | null | undefined {
  if (value) return value;
  return initial ? null : undefined;
}

export function CorrectDocumentDialog({ version, onClose, onSaved }: { version: DocumentView; onClose: () => void; onSaved?: (saved: DocumentView) => void }) {
  const invalidate = useInvalidateDocuments();
  const types = useDocumentTypes(true);
  const type = (types.data ?? []).find((t) => t.id === version.documentTypeId) ?? null;
  const initial = fieldsFromVersion(version);
  const [fields, setFields] = useState<DocumentFieldsState>(initial);
  const [file, setFile] = useState<AttachmentView | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [reason, setReason] = useState('');
  const errors = useSubmitErrors();
  const hasExpiry = type ? type.hasExpiry : version.validTo !== null;

  const save = useMutation({
    mutationFn: () =>
      api<DocumentView>(`/documents/${version.id}`, {
        method: 'PATCH',
        body: {
          // Texte vidé : transmis vide pour effacer la valeur ; date enregistrée vidée : null (effacement).
          number: fields.number,
          issuer: fields.issuer,
          notes: fields.notes,
          issuedOn: correctedDate(fields.issuedOn, initial.issuedOn),
          validFrom: correctedDate(fields.validFrom, initial.validFrom),
          validTo: hasExpiry ? fields.validTo || undefined : initial.validTo ? null : undefined,
          // Nouveau fichier, retrait explicite du justificatif actuel (null), ou justificatif inchangé.
          attachmentId: file ? file.id : removeFile ? null : undefined,
          reason: reason.trim(),
          expectedVersion: version.version,
        },
      }),
    onSuccess: (saved) => {
      toast.success('Correction enregistrée (tracée dans l’audit).');
      invalidate({ vehicleId: saved.vehicleId, driverId: saved.driverId });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      errors.apply(error, 'Correction impossible.', [...FIELD_NAMES, 'reason']);
      // Version obsolète : les données sont rechargées et la fenêtre fermée pour repartir de la version courante.
      if (isObsolete(error)) {
        invalidate({ vehicleId: version.vehicleId, driverId: version.driverId });
        onClose();
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Corriger une faute de saisie : {version.documentTypeLabel} · {version.ownerLabel}
          </DialogTitle>
          <DialogDescription>La version est modifiée en place ; l’avant/après et le motif sont tracés dans l’audit. Pour un nouveau document, utilisez plutôt « Renouveler ».</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            errors.reset();
            const local: FieldErrors = {};
            // Contrôle d'affichage : l'API refuse aussi une fin de validité vidée pour un type qui expire.
            if (hasExpiry && !fields.validTo) local.validTo = ['La fin de validité est requise pour ce type de document ; seules les dates d’émission et de début peuvent être effacées.'];
            for (const name of DATE_FIELDS) {
              if (fields[name] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[name])) local[name] = ['Date invalide.'];
            }
            if (reason.trim().length < 3) local.reason = ['Indiquez le motif de la correction (3 caractères minimum).'];
            if (Object.keys(local).length > 0) {
              errors.setFieldErrors(local);
              return;
            }
            save.mutate();
          }}
        >
          <FormAlert message={errors.formError} />
          <ArchivedTypeNotice type={type} />
          <p className="text-xs text-muted-foreground sm:col-span-2">Videz une date d’émission ou de début pour l’effacer{hasExpiry ? '' : ' (ce type n’a pas de date de fin)'}.</p>
          <DocumentFieldInputs idPrefix="doc-correct" value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} errors={errors.fieldErrors} hasExpiry={hasExpiry} />
          <DocumentFileField
            id="doc-correct-file"
            companyId={version.companyId}
            value={file}
            onChange={setFile}
            errors={errors.fieldErrors}
            existingAttachmentId={version.attachmentId}
            removeExisting={removeFile}
            onRemoveExistingChange={setRemoveFile}
          />
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="doc-correct-reason">Motif de la correction *</Label>
            <Textarea id="doc-correct-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={errors.fieldErrors.reason ? true : undefined} aria-describedby={describedBy(errors.fieldErrors, 'reason')} />
            <FieldError errors={errors.fieldErrors} name="reason" />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || types.isPending || type?.status === 'ARCHIVE'}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer la correction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Archiver une version erronée (POST /documents/:id/archive)
// ---------------------------------------------------------------------------

export function ArchiveDocumentDialog({ version, onClose, onSaved }: { version: DocumentView; onClose: () => void; onSaved?: (saved: DocumentView) => void }) {
  const invalidate = useInvalidateDocuments();
  const [reason, setReason] = useState('');
  const errors = useSubmitErrors();

  const archive = useMutation({
    mutationFn: () => api<DocumentView>(`/documents/${version.id}/archive`, { method: 'POST', body: { reason: reason.trim(), expectedVersion: version.version } }),
    onSuccess: (saved) => {
      toast.success('Version archivée.');
      invalidate({ vehicleId: saved.vehicleId, driverId: saved.driverId });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      errors.apply(error, 'Archivage impossible.', ['reason']);
      if (isObsolete(error)) {
        invalidate({ vehicleId: version.vehicleId, driverId: version.driverId });
        onClose();
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !archive.isPending && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Archiver cette version de {version.documentTypeLabel} · {version.ownerLabel} ?
          </DialogTitle>
          <DialogDescription>
            Réservé à une version erronée : elle n’est jamais supprimée mais ne compte plus pour la conformité, qui est recalculée. Le motif est tracé dans l’audit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            errors.reset();
            if (reason.trim().length < 3) {
              errors.setFieldErrors({ reason: ['Indiquez le motif de l’archivage (3 caractères minimum).'] });
              return;
            }
            archive.mutate();
          }}
        >
          <FormAlert message={errors.formError} />
          <dl className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
            <dt className="text-muted-foreground">Numéro</dt>
            <dd>{version.number ?? '—'}</dd>
            <dt className="text-muted-foreground">Validité</dt>
            <dd>
              {formatDate(version.validFrom)} → {formatDate(version.validTo)}
            </dd>
          </dl>
          <div className="space-y-2">
            <Label htmlFor="doc-archive-reason">Motif *</Label>
            <Textarea id="doc-archive-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={errors.fieldErrors.reason ? true : undefined} aria-describedby={describedBy(errors.fieldErrors, 'reason')} />
            <FieldError errors={errors.fieldErrors} name="reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={archive.isPending} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={archive.isPending}>
              {archive.isPending ? 'Archivage…' : 'Archiver la version'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
