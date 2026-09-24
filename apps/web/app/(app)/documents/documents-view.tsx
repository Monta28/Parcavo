'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DocumentActionDialogs, type DocumentAction } from '@/components/documents/document-dialogs';
import { DocumentVersionSheet } from '@/components/documents/version-sheet';
import { useAppScope, useCan } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useListParams } from '@/lib/use-list-params';
import { ComplianceTab } from './compliance-tab';
import { TypesTab } from './types-tab';
import { VersionsTab } from './versions-tab';

const TABS = ['conformite', 'versions', 'types'] as const;
type Tab = (typeof TABS)[number];

/**
 * /documents (CDC 7.1, 7.2, 10.2) : conformité par objet et type (échéances, documents manquants,
 * blocages), versions avec accès aux justificatifs, et paramétrage des types (administrateur).
 * Un compte uniquement conducteur ne voit que ses documents et ceux de son utilisation en cours.
 */
export function DocumentsView() {
  const { session } = useAppScope();
  const canManage = useCan('documents.manage') && !session.isDriverOnly;
  const { get, set, page } = useListParams();
  const raw = get('onglet');
  const tab: Tab = (TABS as readonly string[]).includes(raw) ? (raw as Tab) : 'conformite';
  const versionId = get('version');
  const [action, setAction] = useState<DocumentAction | null>(null);
  const keepPage = page > 1 ? page : null;
  const openVersion = (id: string) => set({ version: id, page: keepPage });

  const workspace = (
    <>
      {versionId ? <DocumentVersionSheet versionId={versionId} onClose={() => set({ version: '', page: keepPage })} onView={openVersion} onAction={setAction} blocked={action !== null} /> : null}
      {/* Renouvellement lancé depuis le panneau d'une version : le panneau affiche la nouvelle version. */}
      <DocumentActionDialogs action={action} onClose={() => setAction(null)} onSaved={(saved) => (versionId && saved.id !== versionId ? openVersion(saved.id) : undefined)} />
    </>
  );

  if (session.isDriverOnly) {
    return (
      <div>
        <PageHeader title="Documents" description="Vos documents personnels et ceux du véhicule de votre utilisation en cours que le parc a rendus consultables." />
        <VersionsTab driverMode onAction={setAction} onView={openVersion} />
        {workspace}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Échéances, documents manquants, renouvellements et accès aux justificatifs. Les statuts sont calculés par le serveur au jour local du groupe."
        actions={
          canManage ? (
            <Button onClick={() => setAction({ kind: 'create', preset: {} })}>
              <Plus className="size-4" aria-hidden="true" /> Enregistrer un document
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(v) => set({ onglet: v === 'conformite' ? '' : v })}>
        <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
          <TabsTrigger value="conformite">Conformité</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="types">Types</TabsTrigger>
        </TabsList>
        <TabsContent value="conformite">
          <ComplianceTab onAction={setAction} onView={openVersion} />
        </TabsContent>
        <TabsContent value="versions">
          <VersionsTab onAction={setAction} onView={openVersion} />
        </TabsContent>
        <TabsContent value="types">
          <TypesTab />
        </TabsContent>
      </Tabs>
      {workspace}
    </div>
  );
}
