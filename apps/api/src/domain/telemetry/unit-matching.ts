import { normalizeRegistration } from '../registration.js';

/**
 * Rapprochement des unités du fournisseur avec les véhicules (CDC 14.5, T35) : proposition par
 * immatriculation normalisée, jamais d'association automatique (le chef confirme chaque ligne ;
 * aucun relevé n'est ingéré avant confirmation). Une immatriculation partagée par plusieurs
 * véhicules ou plusieurs unités est ambiguë : aucune proposition.
 */
export interface ProviderUnitInfo {
  unitId: string;
  label: string;
  declaredRegistration: string | null;
}

export interface VehicleInfo {
  vehicleId: string;
  registration: string;
}

export interface MappingProposal {
  unitId: string;
  vehicleId: string;
  normalizedRegistration: string;
}

export interface MatchingResult {
  proposals: MappingProposal[];
  unmatchedUnitIds: string[];
  ambiguousUnitIds: string[];
}

export function proposeMappings(units: readonly ProviderUnitInfo[], vehicles: readonly VehicleInfo[]): MatchingResult {
  const byRegistration = new Map<string, string[]>();
  for (const v of vehicles) {
    const key = normalizeRegistration(v.registration);
    if (!key) continue;
    byRegistration.set(key, [...(byRegistration.get(key) ?? []), v.vehicleId]);
  }
  const unitsByRegistration = new Map<string, number>();
  for (const u of units) {
    const key = u.declaredRegistration ? normalizeRegistration(u.declaredRegistration) : '';
    if (key) unitsByRegistration.set(key, (unitsByRegistration.get(key) ?? 0) + 1);
  }
  const result: MatchingResult = { proposals: [], unmatchedUnitIds: [], ambiguousUnitIds: [] };
  for (const u of units) {
    const key = u.declaredRegistration ? normalizeRegistration(u.declaredRegistration) : '';
    const candidates = key ? (byRegistration.get(key) ?? []) : [];
    if (candidates.length === 0) result.unmatchedUnitIds.push(u.unitId);
    else if (candidates.length > 1 || (unitsByRegistration.get(key) ?? 0) > 1) result.ambiguousUnitIds.push(u.unitId);
    else result.proposals.push({ unitId: u.unitId, vehicleId: candidates[0] as string, normalizedRegistration: key });
  }
  return result;
}
