import { describe, expect, it } from 'vitest';
import { FUEL_ENTRY_STATUSES, FUEL_STATUS_LABELS, fuelStatusLabel } from './fuel-types';

describe('Libellés des statuts de plein', () => {
  it('chaque statut renvoyé par l’API a un libellé français, y compris REMPLACE (D-222)', () => {
    for (const status of FUEL_ENTRY_STATUSES) expect(FUEL_STATUS_LABELS[status]).toMatch(/\S/);
    expect(fuelStatusLabel('SOUMIS')).toBe('Soumis (à valider)');
    expect(fuelStatusLabel('REMPLACE')).toBe('Remplacé (corrigé)');
  });

  it('un statut inconnu est affiché tel quel, sans valeur inventée', () => {
    expect(fuelStatusLabel('NOUVEAU_STATUT')).toBe('NOUVEAU_STATUT');
  });
});
