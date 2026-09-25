import { Decimal } from 'decimal.js';

/**
 * Règles d'un plein de carburant (CDC 8.2, 10.3 ; D-223, D-225, D-226) : fonctions pures, horloge
 * fournie par l'appelant.
 */

/** Carburants saisissables en V1 (D-225) : l'énergie kWh est hors périmètre. */
export const FUEL_ENERGIES = ['DIESEL', 'ESSENCE', 'GPL'] as const;
export type FuelEnergy = (typeof FUEL_ENERGIES)[number];
export type VehicleEnergy = 'DIESEL' | 'ESSENCE' | 'GPL' | 'HYBRIDE' | 'ELECTRIQUE' | 'AUTRE';

export function isFuelEnergy(value: string): value is FuelEnergy {
  return (FUEL_ENERGIES as readonly string[]).includes(value);
}

export type EnergyResolution =
  | { ok: true; energy: FuelEnergy }
  | { ok: false; code: 'VEHICULE_ELECTRIQUE' | 'ENERGIE_INCOMPATIBLE' | 'ENERGIE_REQUISE'; message: string };

/**
 * Type de carburant d'un plein au regard de l'énergie du véhicule (D-225). Véhicule électrique : refus
 * (module kWh hors V1). Thermique : même carburant que la fiche (valeur par défaut). Hybride : essence ou
 * diesel, à préciser. Énergie AUTRE ou non renseignée : aucune incompatibilité démontrable, le carburant
 * doit être indiqué.
 */
export function resolveFuelEnergy(vehicleEnergy: VehicleEnergy | null, requested: FuelEnergy | null): EnergyResolution {
  if (vehicleEnergy === 'ELECTRIQUE') {
    return { ok: false, code: 'VEHICULE_ELECTRIQUE', message: 'Véhicule électrique : le module énergie en kWh est hors V1 ; enregistrez une dépense.' };
  }
  if (vehicleEnergy === 'HYBRIDE') {
    if (requested === null) return { ok: false, code: 'ENERGIE_REQUISE', message: 'Véhicule hybride : précisez le carburant (essence ou diesel).' };
    if (requested === 'GPL') return { ok: false, code: 'ENERGIE_INCOMPATIBLE', message: 'Carburant incompatible avec un véhicule hybride (essence ou diesel uniquement).' };
    return { ok: true, energy: requested };
  }
  if (vehicleEnergy !== null && isFuelEnergy(vehicleEnergy)) {
    const energy = requested ?? vehicleEnergy;
    if (energy !== vehicleEnergy) return { ok: false, code: 'ENERGIE_INCOMPATIBLE', message: `Carburant incompatible avec l’énergie du véhicule (${vehicleEnergy}).` };
    return { ok: true, energy };
  }
  if (requested === null) return { ok: false, code: 'ENERGIE_REQUISE', message: 'L’énergie du véhicule n’est pas renseignée : précisez le type de carburant.' };
  return { ok: true, energy: requested };
}

/** Dépassement toléré de la capacité du réservoir avant avertissement (D-225 : 105 %). */
export const TANK_CAPACITY_TOLERANCE = new Decimal('1.05');

/** Litres supérieurs à 105 % de la capacité connue : avertissement non bloquant (D-225). */
export function exceedsTankCapacity(liters: Decimal, capacityLiters: Decimal | null): boolean {
  return capacityLiters !== null && capacityLiters.gt(0) && liters.gt(capacityLiters.times(TANK_CAPACITY_TOLERANCE));
}

/** Tolérance d'horloge pour un horodatage saisi (D-223 : non futur à 5 minutes près). */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isInFuture(instant: Date, now: Date): boolean {
  return instant.getTime() > now.getTime() + FUTURE_TOLERANCE_MS;
}

/** Marge autour d'une utilisation pour rattacher un ticket (D-226 : ± 1 h). */
export const DRIVER_WINDOW_MARGIN_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DriverUsageWindow {
  status: 'EN_COURS' | 'TERMINEE';
  checkedOutAt: Date;
  returnedAt: Date | null;
}

export type DriverSubmissionDecision = { allowed: true } | { allowed: false; reason: 'HORS_DROITS' | 'HORS_UTILISATION' };

/**
 * Périmètre d'une soumission conducteur (D-226) : véhicule de son utilisation EN_COURS, ou d'une
 * utilisation TERMINEE depuis moins de `lateSubmissionDays`, avec filledAt ∈ [remise − 1 h, restitution + 1 h].
 * Sans utilisation éligible ni responsabilité habituelle, le véhicule est hors droits (404) ; sinon la
 * date hors fenêtre donne HORS_UTILISATION (422). D-268 : quand drivers.allowHabitualVehicleSubmissions est
 * activé, le responsable habituel actif du véhicule (responsibleForVehicle) peut aussi soumettre un ticket
 * hors utilisation, daté de moins de `lateSubmissionDays` et pas dans le futur (contrôlé à part).
 */
export function evaluateDriverSubmission(input: { filledAt: Date; now: Date; lateSubmissionDays: number; usages: readonly DriverUsageWindow[]; responsibleForVehicle: boolean }): DriverSubmissionDecision {
  const lateLimit = input.now.getTime() - input.lateSubmissionDays * DAY_MS;
  const eligible = input.usages.filter((u) => u.status === 'EN_COURS' || (u.returnedAt !== null && u.returnedAt.getTime() > lateLimit));
  const at = input.filledAt.getTime();
  const inside = eligible.some((u) => at >= u.checkedOutAt.getTime() - DRIVER_WINDOW_MARGIN_MS && (u.returnedAt === null || at <= u.returnedAt.getTime() + DRIVER_WINDOW_MARGIN_MS));
  if (inside) return { allowed: true };
  // D-268 : responsable habituel actif, paramètre activé : ticket récent accepté hors utilisation.
  if (input.responsibleForVehicle) return at > lateLimit ? { allowed: true } : { allowed: false, reason: 'HORS_UTILISATION' };
  return { allowed: false, reason: eligible.length === 0 ? 'HORS_DROITS' : 'HORS_UTILISATION' };
}
