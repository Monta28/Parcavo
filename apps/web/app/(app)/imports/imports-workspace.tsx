'use client';

import { useQuery } from '@tanstack/react-query';
import { useAppScope } from '@/components/layout/session-context';
import { PageHeader } from '@/components/page-header';
import { ErrorState, LoadingState } from '@/components/states';
import { api } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-error';
import type { ImportModel } from '@/lib/imports-types';
import { useListParams } from '@/lib/use-list-params';
import { BatchPanel } from './batch-panel';
import { ImportsHistory } from './imports-history';
import { NewImport } from './new-import';

const FORBIDDEN = new ApiRequestError(403, { code: 'ACTION_INTERDITE', message: 'L’import est réservé au chef de parc et à l’administrateur.' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Imports assistés (CDC 12.1, 12.2 ; D-277 à D-280) : modèle, téléversement, association des colonnes,
 * contrôle, confirmation et rapport, puis historique des lots. Réservé au chef de parc et à
 * l'administrateur ; l'API reste seule juge (403 sinon) et contrôle chaque ligne sur leur périmètre.
 */
export function ImportsWorkspace() {
  const { session } = useAppScope();
  const canImport = session.isAdmin || session.grants.some((g) => g.role === 'ADMIN' || g.role === 'CHEF_PARC');
  if (!canImport) {
    return (
      <div>
        <PageHeader title="Imports" />
        <ErrorState error={FORBIDDEN} />
      </div>
    );
  }
  return <ImportsContent />;
}

function ImportsContent() {
  const { get } = useListParams();
  const lot = get('lot');
  const models = useQuery({ queryKey: ['import-models'], queryFn: () => api<ImportModel[]>('/imports/models'), staleTime: Infinity });

  return (
    <div>
      <PageHeader
        title="Imports"
        description="Initialisation du parc à partir de fichiers CSV ou XLSX : véhicules, conducteurs, relevés kilométriques et bases d’entretien. Rien n’est écrit avant votre confirmation."
      />
      {models.isPending ? (
        <LoadingState />
      ) : models.isError ? (
        <ErrorState error={models.error} retry={() => void models.refetch()} />
      ) : lot ? (
        UUID.test(lot) ? (
          <BatchPanel key={lot} batchId={lot} models={models.data} />
        ) : (
          <ErrorState error={new ApiRequestError(404, { code: 'INTROUVABLE', message: 'Lot d’import introuvable ou hors de votre périmètre.' })} />
        )
      ) : (
        <div className="space-y-8">
          <NewImport models={models.data} />
          <ImportsHistory models={models.data} />
        </div>
      )}
    </div>
  );
}
