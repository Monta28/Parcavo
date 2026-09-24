import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatKm, formatLiters, formatMoney, fullName } from './format';
import { ApiRequestError, messageForStatus } from './api-error';

/** Intl fr-FR sépare les milliers par une espace fine insécable : normalisée pour la lecture des tests. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('Formats d’affichage (CDC 13.1, 17.1)', () => {
  it('montants en TND à trois décimales', () => {
    expect(plain(formatMoney('1234.5'))).toBe('1 234,500 TND');
    expect(plain(formatMoney(0.0005))).toBe('0,001 TND');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('abc')).toBe('—');
  });

  it('compteurs tronqués au kilomètre entier, estimation GPS signalée', () => {
    expect(plain(formatKm('90000.9'))).toBe('90 000 km');
    expect(plain(formatKm(80450, { estimate: true }))).toBe('≈ 80 450 km (estimé GPS)');
    expect(formatKm('')).toBe('—');
  });

  it('dates civiles sans décalage de fuseau, horodatages dans le fuseau du groupe', () => {
    expect(formatDate('2026-09-26')).toBe('26/09/2026');
    // 23:30 UTC le 25 = 00:30 le 26 à Tunis.
    expect(formatDate('2026-09-25T23:30:00.000Z', 'Africa/Tunis')).toBe('26/09/2026');
    expect(formatDateTime('2026-09-25T23:30:00.000Z', 'Africa/Tunis')).toBe('26/09/2026 00:30');
    expect(formatDateTime(null)).toBe('—');
  });

  it('litres et noms', () => {
    expect(formatLiters('12.345')).toBe('12,35 L');
    expect(formatLiters('x')).toBe('—');
    expect(fullName({ firstName: 'Salma', lastName: 'Ben Ali' })).toBe('Salma Ben Ali');
  });
});

describe('Erreurs de l’API', () => {
  it('reprend le message et les erreurs de champ renvoyés par l’API', () => {
    const e = new ApiRequestError(422, { code: 'MOT_DE_PASSE_FAIBLE', message: 'Trop court.', fieldErrors: { password: ['12 caractères minimum.'] } });
    expect(e.message).toBe('Trop court.');
    expect(e.code).toBe('MOT_DE_PASSE_FAIBLE');
    expect(e.fieldErrors['password']).toEqual(['12 caractères minimum.']);
  });

  it('hors connexion, ne prétend jamais avoir enregistré les données', () => {
    const e = new ApiRequestError(0, null);
    expect(e.code).toBe('HTTP_0');
    expect(e.message).toContain('rien n’a été enregistré');
    expect(messageForStatus(404)).toContain('hors de votre périmètre');
  });
});
