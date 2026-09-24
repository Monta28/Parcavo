import type { VehicleLifecycle } from '@parc-auto/db';
import type { VehicleOperationalStatus } from '@parc-auto/contracts';

/**
 * Statut opérationnel d'un véhicule ACTIF (CDC 3.2, 11.1) : IMMOBILISE > EN_UTILISATION > DISPONIBLE.
 * Les véhicules hors service, cédés ou archivés n'ont pas de statut opérationnel (null) et ne
 * gonflent jamais le parc disponible. Une réservation future n'influe pas sur le statut.
 * Une utilisation ouverte reste visible quel que soit le cycle de vie (elle n'est jamais masquée).
 */
export interface VehicleStatusInput {
  lifecycle: VehicleLifecycle;
  hasActiveImmobilization: boolean;
  hasOpenUsage: boolean;
}

export function operationalStatus(input: VehicleStatusInput): VehicleOperationalStatus | null {
  if (input.lifecycle !== 'ACTIF') return null;
  if (input.hasActiveImmobilization) return 'IMMOBILISE';
  if (input.hasOpenUsage) return 'EN_UTILISATION';
  return 'DISPONIBLE';
}

/** Un nouveau départ est possible seulement pour un véhicule actif, disponible (ni immobilisé ni déjà utilisé). */
export function canStartUsage(input: VehicleStatusInput): { ok: true } | { ok: false; reason: string; code: string } {
  if (input.lifecycle !== 'ACTIF') return { ok: false, code: 'VEHICULE_NON_ACTIF', reason: 'Le véhicule n’est pas en service.' };
  if (input.hasActiveImmobilization) return { ok: false, code: 'VEHICULE_IMMOBILISE', reason: 'Le véhicule est immobilisé.' };
  if (input.hasOpenUsage) return { ok: false, code: 'VEHICULE_DEJA_EN_UTILISATION', reason: 'Le véhicule est déjà en utilisation.' };
  return { ok: true };
}
