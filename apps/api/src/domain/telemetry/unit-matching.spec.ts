import { describe, expect, it } from 'vitest';
import { proposeMappings } from './unit-matching.js';

describe('Rapprochement des unités (CDC 14.5 — T35)', () => {
  it('T35 — 12 unités, 10 immatriculations reconnues, 2 inconnues : 10 propositions, 2 non mappées', () => {
    const vehicles = Array.from({ length: 10 }, (_, i) => ({ vehicleId: `v${i}`, registration: `${100 + i} TU 2026` }));
    const units = [
      ...Array.from({ length: 10 }, (_, i) => ({ unitId: `u${i}`, label: `Boîtier ${i}`, declaredRegistration: i % 2 === 0 ? `${100 + i}TU2026` : `${100 + i} تونس 2026` })),
      { unitId: 'u10', label: 'Boîtier 10', declaredRegistration: '999 TU 1999' },
      { unitId: 'u11', label: 'Boîtier 11', declaredRegistration: null },
    ];
    const r = proposeMappings(units, vehicles);
    expect(r.proposals).toHaveLength(10);
    expect(r.proposals.find((p) => p.unitId === 'u3')?.vehicleId).toBe('v3');
    expect(r.unmatchedUnitIds.sort()).toEqual(['u10', 'u11']);
    expect(r.ambiguousUnitIds).toEqual([]);
  });

  it('une immatriculation déclarée par deux unités n’est pas proposée (ambiguë)', () => {
    const r = proposeMappings([{ unitId: 'a', label: 'A', declaredRegistration: '1 TU 1' }, { unitId: 'b', label: 'B', declaredRegistration: '1TU1' }], [{ vehicleId: 'v', registration: '1 TU 1' }]);
    expect(r.proposals).toEqual([]);
    expect(r.ambiguousUnitIds.sort()).toEqual(['a', 'b']);
  });
});
