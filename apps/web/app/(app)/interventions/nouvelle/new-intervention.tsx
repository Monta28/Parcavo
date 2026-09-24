'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api-error';
import { InterventionForm } from '../intervention-form';
import { useOperationalCompanyIds } from '../intervention-helpers';

const FORBIDDEN = new ApiRequestError(403, { code: 'ROLE_REQUIS', message: 'La création d’une intervention est réservée aux opérateurs, chefs de parc et administrateurs.' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nouvelle intervention (CDC 6.3) : ?vehicleId= présélectionne le véhicule, ?incidentId= ouvre une intervention urgente depuis un incident. */
export function NewIntervention() {
  const params = useSearchParams();
  const operationalCompanies = useOperationalCompanyIds();
  const vehicleParam = params.get('vehicleId') ?? '';
  const incidentParam = params.get('incidentId') ?? '';
  const vehicleId = UUID.test(vehicleParam) ? vehicleParam : '';
  const incidentId = UUID.test(incidentParam) ? incidentParam : '';

  return (
    <div>
      <PageHeader
        title="Nouvelle intervention"
        description={incidentId ? 'Intervention ouverte depuis un incident : le véhicule est celui de l’incident.' : 'Entretien préventif ou réparation corrective, planifié ou saisi a posteriori.'}
        actions={
          <Button variant="outline" asChild>
            <Link href="/interventions">Retour à la liste</Link>
          </Button>
        }
      />
      {operationalCompanies.length === 0 ? <ErrorState error={FORBIDDEN} /> : <InterventionForm key={`${vehicleId}-${incidentId}`} mode="create" initialVehicleId={vehicleId} sourceIncidentId={incidentId} />}
    </div>
  );
}
