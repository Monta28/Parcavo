'use client';

import { Download, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useSession } from '@/components/layout/session-context';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ComplianceRow, DocumentOwnerType, DocumentView } from '@/lib/documents-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { renewTargetFromVersion, type DocumentAction, type RenewTarget } from './document-dialogs';
import { DocumentStatusBadge, daysRemainingLabel, useDocumentsAccess } from './document-helpers';

/** Lien vers la fiche de l'objet propriétaire (véhicule ou conducteur). */
export function OwnerLink({ ownerType, id, label }: { ownerType: DocumentOwnerType; id: string | null; label: string }) {
  const session = useSession();
  // Les fiches véhicule et conducteur sont réservées au personnel de gestion.
  if (!id || session.isDriverOnly) return <>{label}</>;
  return (
    <Link href={ownerType === 'VEHICULE' ? `/vehicules/${id}` : `/conducteurs/${id}`} className="font-medium underline-offset-4 hover:underline">
      {label}
    </Link>
  );
}

/** Lien de téléchargement privé du justificatif, ou mention « justificatif absent ». */
export function AttachmentCell({ version }: { version: Pick<DocumentView, 'attachmentId' | 'missingFile' | 'documentTypeLabel'> }) {
  if (version.missingFile || !version.attachmentId) return <StatusBadge label="Justificatif absent" tone="warning" />;
  return (
    <a href={`/api/v1/attachments/${version.attachmentId}/download`} className="inline-flex items-center gap-1 underline underline-offset-4" target="_blank" rel="noopener noreferrer">
      <Download className="size-4" aria-hidden="true" /> Télécharger<span className="sr-only"> le justificatif {version.documentTypeLabel}</span>
    </a>
  );
}

/** Période de validité (dates civiles de l'API) : début facultatif, fin valable jusqu'à la fin du jour. */
function ValidityPeriod({ from, to }: { from: string | null; to: string | null }) {
  if (!from && !to) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col">
      {from ? <span>Du {formatDate(from)}</span> : null}
      <span>{to ? `${from ? 'au' : 'Jusqu’au'} ${formatDate(to)}` : 'Sans date de fin'}</span>
    </span>
  );
}

function renewTargetFromRow(row: ComplianceRow, versionId: string): RenewTarget {
  return {
    versionId,
    documentTypeId: row.documentTypeId,
    documentTypeLabel: row.documentTypeLabel,
    ownerLabel: row.objectLabel,
    companyId: row.companyId,
    vehicleId: row.ownerType === 'VEHICULE' ? row.objectId : null,
    driverId: row.ownerType === 'CONDUCTEUR' ? row.objectId : null,
  };
}

/**
 * Tableau de conformité (GET /documents/compliance) : statut, détail (rédigé par l'API, dates en JJ/MM/AAAA),
 * validité de la version retenue et de la version future, jours restants et blocage tels que calculés par
 * l'API ; actions Enregistrer (MANQUANT), Renouveler et Voir la version.
 */
export function ComplianceTable({
  rows,
  showObject,
  showCompany,
  onAction,
  onView,
}: {
  rows: ComplianceRow[];
  showObject: boolean;
  showCompany: boolean;
  onAction: (action: DocumentAction) => void;
  onView: (versionId: string) => void;
}) {
  const { canManageIn, companyCode } = useDocumentsAccess();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showObject ? <TableHead>Objet</TableHead> : null}
          <TableHead>Type</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead>Détail</TableHead>
          <TableHead>Validité</TableHead>
          <TableHead>Version future</TableHead>
          <TableHead>Jours restants</TableHead>
          <TableHead>Départ</TableHead>
          {showCompany ? <TableHead>Société</TableHead> : null}
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const canManage = canManageIn(row.companyId);
          const label = `${row.documentTypeLabel} · ${row.objectLabel}`;
          return (
            <TableRow key={`${row.objectId}:${row.documentTypeId}`}>
              {showObject ? (
                <TableCell>
                  <OwnerLink ownerType={row.ownerType} id={row.objectId} label={row.objectLabel} />
                </TableCell>
              ) : null}
              <TableCell>{row.documentTypeLabel}</TableCell>
              <TableCell>
                <DocumentStatusBadge status={row.status} />
              </TableCell>
              <TableCell className="max-w-72 whitespace-normal text-muted-foreground">{row.detail}</TableCell>
              <TableCell className="whitespace-normal">
                <ValidityPeriod from={row.validFrom} to={row.validTo} />
              </TableCell>
              <TableCell className="whitespace-normal">{row.nextValidFrom ? <ValidityPeriod from={row.nextValidFrom} to={row.nextValidTo} /> : <span className="text-muted-foreground">Aucune</span>}</TableCell>
              <TableCell>{daysRemainingLabel(row.daysRemaining)}</TableCell>
              <TableCell>{row.blocksCheckout ? <StatusBadge label="Bloque un départ" tone="danger" /> : <span className="text-muted-foreground">Aucun blocage</span>}</TableCell>
              {showCompany ? <TableCell>{companyCode(row.companyId)}</TableCell> : null}
              <TableCell>
                <div className="flex flex-wrap justify-end gap-2">
                  {canManage && row.status === 'MANQUANT' ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onAction({ kind: 'create', preset: { documentTypeId: row.documentTypeId, ownerType: row.ownerType, owner: { id: row.objectId, label: row.objectLabel, companyId: row.companyId } } })}
                      aria-label={`Enregistrer : ${label}`}
                    >
                      Enregistrer
                    </Button>
                  ) : null}
                  {canManage && row.currentVersionId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={row.status === 'VALIDE' ? 'outline' : 'default'}
                      onClick={() => onAction({ kind: 'renew', target: renewTargetFromRow(row, row.currentVersionId as string) })}
                      aria-label={`Renouveler : ${label}`}
                    >
                      Renouveler
                    </Button>
                  ) : null}
                  {row.currentVersionId ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => onView(row.currentVersionId as string)} aria-label={`Voir la version : ${label}`}>
                      Voir la version
                    </Button>
                  ) : null}
                  {row.upcomingVersionId ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onView(row.upcomingVersionId as string)} aria-label={`Voir la version future : ${label}`}>
                      Version future
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Versions de documents (GET /documents) : dates, justificatif, archivage ; actions selon documents.manage. */
export function VersionsTable({
  items,
  showObject,
  showCompany,
  onAction,
  onView,
}: {
  items: DocumentView[];
  showObject: boolean;
  showCompany: boolean;
  onAction: (action: DocumentAction) => void;
  onView: (versionId: string) => void;
}) {
  const session = useSession();
  const { canManageIn, companyCode } = useDocumentsAccess();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          {showObject ? <TableHead>Objet</TableHead> : null}
          <TableHead>Numéro</TableHead>
          <TableHead>Organisme</TableHead>
          <TableHead>Début</TableHead>
          <TableHead>Fin</TableHead>
          <TableHead>Justificatif</TableHead>
          <TableHead>État</TableHead>
          {showCompany ? <TableHead>Société</TableHead> : null}
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((v) => {
          const canManage = canManageIn(v.companyId) && !v.archivedAt;
          const label = `${v.documentTypeLabel} · ${v.ownerLabel}`;
          return (
            <TableRow key={v.id} className={v.archivedAt ? 'text-muted-foreground' : undefined}>
              <TableCell className="font-medium">{v.documentTypeLabel}</TableCell>
              {showObject ? (
                <TableCell>
                  <OwnerLink ownerType={v.ownerType} id={v.vehicleId ?? v.driverId} label={v.ownerLabel} />
                </TableCell>
              ) : null}
              <TableCell>{v.number ?? '—'}</TableCell>
              <TableCell>{v.issuer ?? '—'}</TableCell>
              <TableCell>{formatDate(v.validFrom)}</TableCell>
              <TableCell>{formatDate(v.validTo)}</TableCell>
              <TableCell>
                <AttachmentCell version={v} />
              </TableCell>
              <TableCell>
                {v.archivedAt ? (
                  <StatusBadge label={`Archivée le ${formatDateTime(v.archivedAt, session.timezone)}`} tone="neutral" />
                ) : v.previousVersionId ? (
                  <StatusBadge label="Renouvellement" tone="info" />
                ) : (
                  <StatusBadge label="Première version" tone="neutral" />
                )}
              </TableCell>
              {showCompany ? <TableCell>{companyCode(v.companyId)}</TableCell> : null}
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => onView(v.id)} aria-label={`Voir le détail : ${label}`}>
                    Détail
                  </Button>
                  {canManage ? (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" size="icon" variant="ghost" aria-label={`Autres actions : ${label}`} title="Autres actions">
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onAction({ kind: 'renew', target: renewTargetFromVersion(v) })}>Renouveler</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onAction({ kind: 'correct', version: v })}>Corriger une faute de saisie</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => onAction({ kind: 'archive', version: v })}>
                          Archiver (version erronée)
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
