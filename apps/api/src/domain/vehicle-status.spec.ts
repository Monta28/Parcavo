import { describe, expect, it } from 'vitest';
import { canStartUsage, operationalStatus } from './vehicle-status.js';

describe('statut opérationnel (CDC 3.2)', () => {
  it('applique la priorité IMMOBILISE > EN_UTILISATION > DISPONIBLE', () => {
    expect(operationalStatus({ lifecycle: 'ACTIF', hasActiveImmobilization: true, hasOpenUsage: true })).toBe('IMMOBILISE');
    expect(operationalStatus({ lifecycle: 'ACTIF', hasActiveImmobilization: false, hasOpenUsage: true })).toBe('EN_UTILISATION');
    expect(operationalStatus({ lifecycle: 'ACTIF', hasActiveImmobilization: false, hasOpenUsage: false })).toBe('DISPONIBLE');
  });
  it('n’attribue aucun statut opérationnel hors du cycle ACTIF', () => {
    for (const lifecycle of ['HORS_SERVICE', 'CEDE', 'ARCHIVE'] as const) {
      expect(operationalStatus({ lifecycle, hasActiveImmobilization: false, hasOpenUsage: false })).toBeNull();
    }
  });
  it('bloque un départ si immobilisé, déjà utilisé ou non actif', () => {
    expect(canStartUsage({ lifecycle: 'ACTIF', hasActiveImmobilization: true, hasOpenUsage: false })).toMatchObject({ ok: false, code: 'VEHICULE_IMMOBILISE' });
    expect(canStartUsage({ lifecycle: 'ACTIF', hasActiveImmobilization: false, hasOpenUsage: true })).toMatchObject({ ok: false, code: 'VEHICULE_DEJA_EN_UTILISATION' });
    expect(canStartUsage({ lifecycle: 'HORS_SERVICE', hasActiveImmobilization: false, hasOpenUsage: false })).toMatchObject({ ok: false, code: 'VEHICULE_NON_ACTIF' });
    expect(canStartUsage({ lifecycle: 'ACTIF', hasActiveImmobilization: false, hasOpenUsage: false })).toEqual({ ok: true });
  });
});
