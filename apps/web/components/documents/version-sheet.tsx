'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/components/layout/session-context';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';
import { DOCUMENT_OWNER_TYPE_LABELS, type DocumentView } from '@/lib/documents-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { renewTargetFromVersion, type DocumentAction } from './document-dialogs';
import { DOCUMENTS_KEY, useDocumentsAccess } from './document-helpers';
import { AttachmentCell, OwnerLink } from './document-tables';

/** Clé react-query d'une version (GET /documents/:id). */
export function versionKey(id: string) {
  return [DOCUMENTS_KEY, 'version', id] as const;
}

/**
 * Détail d'une version de document : champs, justificatif, version précédente, archivage, et actions
 * (renouveler, corriger une faute de saisie, archiver une version erronée) selon documents.manage.
 * `blocked` : un dialogue est ouvert au-dessus, le panneau ne se ferme pas.
 */
export function DocumentVersionSheet({ versionId, onClose, onView, onAction, blocked }: { versionId: string; onClose: () => void; onView: (versionId: string) => void; onAction: (action: DocumentAction) => void; blocked: boolean }) {
  const session = useSession();
  const { canManageIn, companyCode } = useDocumentsAccess();
  const version = useQuery({ queryKey: versionKey(versionId), queryFn: () => api<DocumentView>(`/documents/${versionId}`) });
  const v = version.data;
  const canManage = v ? canManageIn(v.companyId) && !v.archivedAt : false;

  return (
    <Sheet open onOpenChange={(open) => !open && !blocked && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{v ? `${v.documentTypeLabel} · ${v.ownerLabel}` : 'Version de document'}</SheetTitle>
          <SheetDescription>Une version n’est jamais supprimée : une version erronée est archivée, un renouvellement crée une nouvelle version.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6 text-sm">
          {version.isPending ? (
            <LoadingState label="Chargement de la version…" />
          ) : version.isError ? (
            <ErrorState error={version.error} retry={() => void version.refetch()} />
          ) : v ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {v.archivedAt ? <StatusBadge label={`Archivée le ${formatDateTime(v.archivedAt, session.timezone)}`} tone="neutral" /> : null}
                {v.previousVersionId ? <StatusBadge label="Renouvellement" tone="info" /> : <StatusBadge label="Première version" tone="neutral" />}
                {v.missingFile ? <StatusBadge label="Justificatif absent" tone="warning" /> : null}
              </div>
              <p className="text-xs text-muted-foreground">Le statut de conformité (valide, à renouveler, expiré) est calculé par le serveur pour l’objet et le type, en tenant compte de toutes leurs versions.</p>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{DOCUMENT_OWNER_TYPE_LABELS[v.ownerType]}</dt>
                  <dd>
                    <OwnerLink ownerType={v.ownerType} id={v.vehicleId ?? v.driverId} label={v.ownerLabel} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Société</dt>
                  <dd>{companyCode(v.companyId)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Numéro</dt>
                  <dd>{v.number ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Organisme émetteur</dt>
                  <dd>{v.issuer ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Date d’émission</dt>
                  <dd>{formatDate(v.issuedOn)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Début de validité</dt>
                  <dd>{formatDate(v.validFrom)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Fin de validité</dt>
                  <dd>{v.validTo ? `${formatDate(v.validTo)} (fin de journée)` : '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Enregistrée le</dt>
                  <dd>{formatDateTime(v.createdAt, session.timezone)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Justificatif</dt>
                  <dd>
                    <AttachmentCell version={v} />
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="whitespace-pre-wrap">{v.notes ?? '—'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Version précédente</dt>
                  <dd>
                    {v.previousVersionId ? (
                      <Button type="button" variant="link" className="h-auto p-0" onClick={() => onView(v.previousVersionId as string)}>
                        Voir la version renouvelée
                      </Button>
                    ) : (
                      'Aucune (première version enregistrée).'
                    )}
                  </dd>
                </div>
              </dl>
              {canManage ? (
                <div className="flex flex-wrap gap-2 border-t pt-4">
                  <Button type="button" onClick={() => onAction({ kind: 'renew', target: renewTargetFromVersion(v) })}>
                    Renouveler
                  </Button>
                  <Button type="button" variant="outline" onClick={() => onAction({ kind: 'correct', version: v })}>
                    Corriger une faute de saisie
                  </Button>
                  <Button type="button" variant="outline" className="text-destructive" onClick={() => onAction({ kind: 'archive', version: v })}>
                    Archiver (version erronée)
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
