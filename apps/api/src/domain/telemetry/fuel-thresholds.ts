/**
 * Seuils carburant propres à un véhicule (CDC 8.5, 17.1 ; D-238, D-240 ; R-8.5-07, R-17.1-14) — règle unique :
 * défaut du produit < valeur groupe < surcharge société < surcharge véhicule. Un champ de véhicule nul (ou
 * absent) reprend la valeur effective de la société ; les autres paramètres (pas des échantillons, rapprochement
 * du ticket) restent ceux de la société.
 */

/** Champs surchargeables par véhicule et paramètre société correspondant (mêmes libellés, unités et bornes). */
export const VEHICLE_FUEL_THRESHOLD_FIELDS = [
  { field: 'dropLiters', key: 'telemetry.fuelDropLiters' },
  { field: 'dropPercent', key: 'telemetry.fuelDropPercent' },
  { field: 'dropWindowMinutes', key: 'telemetry.fuelDropWindowMinutes' },
  { field: 'fillLiters', key: 'telemetry.fuelFillMinLiters' },
  { field: 'fillPercent', key: 'telemetry.fuelFillPercent' },
  { field: 'fillWindowMinutes', key: 'telemetry.fuelFillWindowMinutes' },
] as const;

export type VehicleFuelThresholdField = (typeof VEHICLE_FUEL_THRESHOLD_FIELDS)[number]['field'];
export type VehicleFuelThresholdKey = (typeof VEHICLE_FUEL_THRESHOLD_FIELDS)[number]['key'];
export type VehicleFuelThresholdValues = Partial<Record<VehicleFuelThresholdField, number | null>>;

export interface FuelDetectionThresholds {
  drop: { liters: number; percent: number; windowMinutes: number };
  refill: { liters: number; percent: number; windowMinutes: number };
}

/** Politique effective d'un véhicule : chaque champ renseigné du véhicule remplace la valeur de la société. */
export function applyVehicleFuelThresholds<P extends FuelDetectionThresholds>(company: P, vehicle: VehicleFuelThresholdValues | null): P {
  if (!vehicle) return company;
  const pick = (own: number | null | undefined, fallback: number) => (own === null || own === undefined ? fallback : own);
  return {
    ...company,
    drop: {
      liters: pick(vehicle.dropLiters, company.drop.liters),
      percent: pick(vehicle.dropPercent, company.drop.percent),
      windowMinutes: pick(vehicle.dropWindowMinutes, company.drop.windowMinutes),
    },
    refill: {
      liters: pick(vehicle.fillLiters, company.refill.liters),
      percent: pick(vehicle.fillPercent, company.refill.percent),
      windowMinutes: pick(vehicle.fillWindowMinutes, company.refill.windowMinutes),
    },
  };
}

/** Surcharge effective ? (au moins un champ renseigné) */
export function hasVehicleFuelThresholds(values: VehicleFuelThresholdValues): boolean {
  return VEHICLE_FUEL_THRESHOLD_FIELDS.some(({ field }) => values[field] !== null && values[field] !== undefined);
}
