'use client';

import { VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import type { DriverView } from '@/lib/drivers-types';
import { fullName } from '@/lib/format';
import type { VehicleView } from '@/lib/vehicles-types';
import { SearchPicker } from './search-picker';

interface CommonProps<T> {
  id: string;
  value: T | null;
  loadingValue?: boolean;
  onChange: (item: T | null) => void;
  companyId: string | null;
  placeholder?: string;
  clearLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}

/** Recherche de véhicule (GET /vehicles?q=), filtrée par société et, au besoin, par statut opérationnel. */
export function VehiclePicker({ operationalStatus, includeInactive, placeholder = 'Choisir un véhicule', ...props }: CommonProps<VehicleView> & { operationalStatus?: 'DISPONIBLE' | 'EN_UTILISATION' | 'IMMOBILISE'; includeInactive?: boolean }) {
  const { session } = useAppScope();
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '';
  return (
    <SearchPicker<VehicleView>
      {...props}
      queryKey={['vehicles', 'picker', props.companyId, operationalStatus ?? null, includeInactive ?? false]}
      search={async (term) =>
        (
          await api<Page<VehicleView>>(
            `/vehicles${toQuery({ companyId: props.companyId, q: term, operationalStatus, includeInactive: includeInactive ? 'true' : undefined, pageSize: 20, sort: 'code' })}`,
          )
        ).items
      }
      itemKey={(v) => v.id}
      itemLabel={(v) => `${v.code} · ${v.registration}`}
      renderItem={(v) => (
        <>
          <span className="font-medium">{v.code}</span> · {v.registration}
          <span className="block text-xs text-muted-foreground">
            {v.make} {v.model}
            {companyCode(v.companyId) ? ` · ${companyCode(v.companyId)}` : ''}
            {v.operationalStatus ? ` · ${VEHICLE_OPERATIONAL_STATUS_LABELS[v.operationalStatus]}` : ''}
          </span>
        </>
      )}
      placeholder={placeholder}
      searchPlaceholder="Code, immatriculation, marque…"
      emptyText="Aucun véhicule trouvé."
    />
  );
}

/** Recherche de conducteur (GET /drivers?q=), filtrée par société et, au besoin, par statut. */
export function DriverPicker({ status, placeholder = 'Choisir un conducteur', ...props }: CommonProps<DriverView> & { status?: 'ACTIF' | 'INACTIF' }) {
  const { session } = useAppScope();
  const companyCode = (id: string) => session.companies.find((c) => c.id === id)?.code ?? '';
  return (
    <SearchPicker<DriverView>
      {...props}
      queryKey={['drivers', 'picker', props.companyId, status ?? null]}
      search={async (term) => (await api<Page<DriverView>>(`/drivers${toQuery({ companyId: props.companyId, q: term, status, pageSize: 20, sort: 'lastName' })}`)).items}
      itemKey={(d) => d.id}
      itemLabel={(d) => `${fullName(d)} · ${d.code}`}
      renderItem={(d) => (
        <>
          <span className="font-medium">{fullName(d)}</span>
          <span className="block text-xs text-muted-foreground">
            {d.code}
            {companyCode(d.companyId) ? ` · ${companyCode(d.companyId)}` : ''}
            {d.status !== 'ACTIF' ? ' · inactif' : ''}
          </span>
        </>
      )}
      placeholder={placeholder}
      searchPlaceholder="Code, nom ou prénom…"
      emptyText="Aucun conducteur trouvé."
    />
  );
}
