import { describe, expect, it } from 'vitest';
import { VEHICLE_FUEL_THRESHOLD_FIELDS, applyVehicleFuelThresholds, hasVehicleFuelThresholds } from './fuel-thresholds.js';

const company = {
  stepMinutes: 5,
  drop: { liters: 10, percent: 5, windowMinutes: 30 },
  refill: { liters: 10, percent: 10, windowMinutes: 30 },
  ticket: { windowHours: 2, toleranceLiters: 5, tolerancePercent: 10 },
};

describe('Seuils carburant par véhicule (D-238, D-240 ; R-8.5-07, R-17.1-14)', () => {
  it('sans surcharge : politique de la société inchangée', () => {
    expect(applyVehicleFuelThresholds(company, null)).toBe(company);
    expect(applyVehicleFuelThresholds(company, {})).toEqual(company);
  });

  it('chaque champ renseigné du véhicule remplace celui de la société ; un champ nul reprend la société ; ticket et pas intacts', () => {
    const effective = applyVehicleFuelThresholds(company, { dropLiters: 2, dropPercent: null, fillWindowMinutes: 15 });
    expect(effective).toEqual({ ...company, drop: { liters: 2, percent: 5, windowMinutes: 30 }, refill: { liters: 10, percent: 10, windowMinutes: 15 } });
    expect(company.drop.liters).toBe(10);
  });

  it('surcharge renseignée si au moins un champ ; champs alignés sur les paramètres de la société', () => {
    expect(hasVehicleFuelThresholds({ dropLiters: null, fillPercent: null })).toBe(false);
    expect(hasVehicleFuelThresholds({ fillPercent: 20 })).toBe(true);
    expect(VEHICLE_FUEL_THRESHOLD_FIELDS.map((f) => f.key)).toEqual([
      'telemetry.fuelDropLiters',
      'telemetry.fuelDropPercent',
      'telemetry.fuelDropWindowMinutes',
      'telemetry.fuelFillMinLiters',
      'telemetry.fuelFillPercent',
      'telemetry.fuelFillWindowMinutes',
    ]);
  });
});
