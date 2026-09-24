'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { ApiRequestError } from '@/lib/api-error';
import type { InterventionView } from '@/lib/interventions-types';
import { InterventionForm } from '../../intervention-form';
import { useInterventionRights } from '../../intervention-helpers';

const FORBIDDEN = new ApiRequestError(403, { code: 'ROLE_REQUIS', message: 'La modification d’une intervention est réservée aux opérateurs, chefs de parc et administrateurs de sa société.' });

/** Modification d'une intervention ouverte (PATCH, verrou optimiste) ; après clôture, seule la réouverture le permet. */
export function EditIntervention({ id }: { id: string }) {
  const intervention = useQuery({ queryKey: ['intervention', id], queryFn: () => api<InterventionView>(`/interventions/${id}`) });
  const rights = useInterventionRights(intervention.data?.companyId ?? null);
  const back = (
    <Button variant="outline" asChild>
      <Link href={`/interventions/${id}`}>Retour à la fiche</Link>
    </Button>
  );

  if (intervention.isPending) return <LoadingState label="Chargement de l’intervention…" />;
  if (intervention.isError) return <ErrorState error={intervention.error} retry={() => void intervention.refetch()} />;
  const i = intervention.data;
  const open = i.status === 'BROUILLON' || i.status === 'PLANIFIEE' || i.status === 'EN_COURS';

  return (
    <div>
      <PageHeader title={`Modifier l’intervention ${i.reference}`} description={`${i.vehicleCode} · ${i.vehicleRegistration} · ${INTERVENTION_STATUS_LABELS[i.status]}`} actions={back} />
      {!rights.operational ? (
        <ErrorState error={FORBIDDEN} />
      ) : !open ? (
        <EmptyState
          title="Intervention non modifiable"
          description={i.status === 'TERMINEE' ? 'Une intervention terminée se corrige par une réouverture motivée (chef de parc ou administrateur).' : 'Une intervention annulée n’est plus modifiable.'}
          action={back}
        />
      ) : (
        <InterventionForm key={i.version} mode="edit" intervention={i} />
      )}
    </div>
  );
}
