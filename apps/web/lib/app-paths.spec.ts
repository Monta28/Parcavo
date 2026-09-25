import { describe, expect, it } from 'vitest';
import { appPathOrNull } from './app-paths';

describe('Liens internes fournis par l’API', () => {
  it('accepte un chemin relatif vers une section existante', () => {
    expect(appPathOrNull('/vehicules/0190c3a2-7b1e-7000-8000-000000000001?onglet=kilometrage')).toBe('/vehicules/0190c3a2-7b1e-7000-8000-000000000001?onglet=kilometrage');
    expect(appPathOrNull('/planning?reservation=abc')).toBe('/planning?reservation=abc');
    expect(appPathOrNull('/telematique/carburant?evenement=1')).toBe('/telematique/carburant?evenement=1');
  });

  it('refuse les URL externes, protocolaires et les sections absentes', () => {
    expect(appPathOrNull('https://exemple.test/vehicules')).toBeNull();
    expect(appPathOrNull('//exemple.test/vehicules')).toBeNull();
    expect(appPathOrNull('/\\exemple.test')).toBeNull();
    expect(appPathOrNull('javascript:alert(1)')).toBeNull();
    expect(appPathOrNull('/section-inconnue/1')).toBeNull();
    expect(appPathOrNull('')).toBeNull();
    expect(appPathOrNull(null)).toBeNull();
  });
});
