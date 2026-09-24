'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useSession } from '@/components/layout/session-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { ComplianceRow, DocumentOwnerType, DocumentView } from '@/lib/documents-types';
import { DocumentActionDialogs, type DocumentAction } from './document-dialogs';
import { DOCUMENTS_KEY, useDocumentsAccess } from './document-helpers';
import { ComplianceTable, VersionsTable } from './document-tables';
import type { OwnerOption } from './owner-pickers';
import { DocumentVersionSheet } from './version-sheet';

/**
 * Documents d'un véhicule ou d'un conducteur (fiche objet) : conformité (GET /documents/compliance) et
 * versions (GET /documents), avec les mêmes dialogues que la page /documents.
 * Compte uniquement conducteur : la conformité est réservée au personnel (l'API la refuse), seules les
 * versions que l'API lui ouvre sont affichées.
 */
export function OwnerDocumentsPanel({
  ownerType,
  ownerId,
  companyId,
  owner,
}: {
  ownerType: DocumentOwnerType;
  ownerId: string;
  companyId: string;
  owner: OwnerOption | null;
}) {
  const session = useSession();
  const staff = !session.isDriverOnly;
  const { canManageIn } = useDocumentsAccess();
  const canManage = canManageIn(companyId);
  const [action, setAction] = useState<DocumentAction | null>(null);
  const [viewed, setViewed] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [compliancePage, setCompliancePage] = useState(1);
  const [includeArchived, setIncludeArchived] = useState(false);
  const ownerParam = ownerType === 'VEHICULE' ? { vehicleId: ownerId } : { driverId: ownerId };
  const idPrefix = ownerType === 'VEHICULE' ? 'vehicule-documents' : 'conducteur-documents';
  const noun = ownerType === 'VEHICULE' ? 'ce véhicule' : 'ce conducteur';

  const complianceQuery = toQuery({ ...ownerParam, page: compliancePage, pageSize: 25 });
  const compliance = useQuery({
    queryKey: [DOCUMENTS_KEY, 'compliance', complianceQuery],
    queryFn: () => api<Page<ComplianceRow>>(`/documents/compliance${complianceQuery}`),
    enabled: staff,
  });
  const versionsQuery = toQuery({
    ...ownerParam,
    includeArchived: includeArchived ? 'true' : undefined,
    page,
    pageSize: 10,
  });
  const versions = useQuery({
    queryKey: [DOCUMENTS_KEY, 'list', versionsQuery],
    queryFn: () => api<Page<DocumentView>>(`/documents${versionsQuery}`),
  });
  const pageHref = `/documents?${ownerType === 'VEHICULE' ? 'vehicule' : 'conducteur'}=${ownerId}`;

  return (
    <div className="space-y-4">
      {staff ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="text-base">Conformité documentaire</CardTitle>
              <CardDescription>
                Statuts calculés par le serveur au jour local du groupe ; une date de fin reste
                valable jusqu’à la fin de ce jour.
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {canManage ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={!owner}
                  onClick={() =>
                    owner && setAction({ kind: 'create', preset: { ownerType, owner } })
                  }
                >
                  <Plus className="size-4" aria-hidden="true" /> Enregistrer un document
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" asChild>
                <Link href={pageHref}>Voir dans Documents</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {compliance.isPending ? (
              <LoadingState label="Calcul de la conformité…" />
            ) : compliance.isError ? (
              <ErrorState error={compliance.error} retry={() => void compliance.refetch()} />
            ) : compliance.data.total === 0 ? (
              <EmptyState
                title="Aucun document suivi"
                description={`Aucun type de document n’est requis ni enregistré pour ${noun}.`}
              />
            ) : (
              <div className="rounded-md border">
                <ComplianceTable
                  rows={compliance.data.items}
                  showObject={false}
                  showCompany={false}
                  onAction={setAction}
                  onView={setViewed}
                />
                <PaginationControls
                  page={compliance.data.page}
                  pageSize={compliance.data.pageSize}
                  total={compliance.data.total}
                  onPageChange={setCompliancePage}
                />
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Versions enregistrées</CardTitle>
            <CardDescription>
              Un renouvellement crée une nouvelle version ; une version erronée est archivée, jamais
              supprimée.
            </CardDescription>
          </div>
          {/* Les versions archivées ne sont jamais servies à un compte conducteur : filtre réservé au personnel. */}
          {staff ? (
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                id={`${idPrefix}-archives`}
                checked={includeArchived}
                onCheckedChange={(checked) => {
                  setIncludeArchived(checked);
                  setPage(1);
                }}
              />
              <Label htmlFor={`${idPrefix}-archives`} className="font-normal">
                Inclure les archivées
              </Label>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {versions.isPending ? (
            <LoadingState />
          ) : versions.isError ? (
            <ErrorState error={versions.error} retry={() => void versions.refetch()} />
          ) : versions.data.total === 0 ? (
            <EmptyState
              title="Aucune version enregistrée"
              description={`Aucun document n’a encore été enregistré pour ${noun}.`}
            />
          ) : (
            <div className="rounded-md border">
              <VersionsTable
                items={versions.data.items}
                showObject={false}
                showCompany={false}
                onAction={setAction}
                onView={setViewed}
              />
              <PaginationControls
                page={versions.data.page}
                pageSize={versions.data.pageSize}
                total={versions.data.total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {viewed ? (
        <DocumentVersionSheet
          versionId={viewed}
          onClose={() => setViewed(null)}
          onView={setViewed}
          onAction={setAction}
          blocked={action !== null}
        />
      ) : null}
      {/* Renouvellement lancé depuis le panneau d'une version : le panneau affiche la nouvelle version. */}
      <DocumentActionDialogs
        action={action}
        onClose={() => setAction(null)}
        onSaved={(saved) => (viewed && saved.id !== viewed ? setViewed(saved.id) : undefined)}
      />
    </div>
  );
}
