import { describe, expect, it } from 'vitest';
import { normalizeRegistration, normalizeVin } from './registration.js';

describe('normalisation des immatriculations (CDC 3.1)', () => {
  it('neutralise espaces, casse et séparateurs sans perdre les caractères', () => {
    expect(normalizeRegistration('123 tu 4567')).toBe('123TU4567');
    expect(normalizeRegistration('123-TU-4567')).toBe('123TU4567');
    expect(normalizeRegistration(' 123  TU 4567 ')).toBe('123TU4567');
    expect(normalizeRegistration('123 تونس 4567')).toBe('123TU4567');
    expect(normalizeRegistration('123 تونس 4567')).toBe(normalizeRegistration('123 TU 4567'));
    expect(normalizeRegistration('12 ن ت 345')).toBe('12NT345');
    expect(normalizeRegistration('AB-123-CD')).toBe('AB123CD');
    expect(normalizeRegistration('PROV/2026/001')).toBe('PROV2026001');
  });
  it('normalise le VIN et ignore les valeurs vides', () => {
    expect(normalizeVin(' vf1abc12345678901 ')).toBe('VF1ABC12345678901');
    expect(normalizeVin('')).toBeNull();
    expect(normalizeVin(null)).toBeNull();
  });
});
