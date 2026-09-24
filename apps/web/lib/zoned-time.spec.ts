import { describe, expect, it } from 'vitest';
import { addDays, civilHour, civilStart, daysBetween, isoToLocalInput, localInputToIso, startOfMonth, startOfWeek, todayCivil } from './zoned-time';

describe('Heures murales dans le fuseau de l’organisation', () => {
  it('convertit une saisie locale en instant UTC et inversement', () => {
    // Tunis : UTC+1 toute l'année.
    expect(localInputToIso('2026-09-26T08:30', 'Africa/Tunis')).toBe('2026-09-26T07:30:00.000Z');
    expect(isoToLocalInput('2026-09-25T23:30:00.000Z', 'Africa/Tunis')).toBe('2026-09-26T00:30');
    expect(localInputToIso('2026-02-30T08:00', 'Africa/Tunis')).toBeNull();
    expect(localInputToIso('', 'Africa/Tunis')).toBeNull();
  });

  it('gère l’heure d’été', () => {
    // Paris : UTC+2 en été, UTC+1 en hiver ; passage le 25/10/2026.
    expect(localInputToIso('2026-07-01T10:00', 'Europe/Paris')).toBe('2026-07-01T08:00:00.000Z');
    expect(localInputToIso('2026-12-01T10:00', 'Europe/Paris')).toBe('2026-12-01T09:00:00.000Z');
    expect(civilStart('2026-10-26', 'Europe/Paris').getTime() - civilStart('2026-10-25', 'Europe/Paris').getTime()).toBe(25 * 3600 * 1000);
    expect(civilHour('2026-10-25', 24, 'Europe/Paris').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('calcule les bornes de calendrier (semaine du lundi, mois)', () => {
    expect(startOfWeek('2026-09-24')).toBe('2026-09-21');
    expect(startOfWeek('2026-09-27')).toBe('2026-09-21');
    expect(startOfWeek('2026-09-21')).toBe('2026-09-21');
    expect(startOfMonth('2026-09-24')).toBe('2026-09-01');
    expect(startOfMonth('2026-12-24', 1)).toBe('2027-01-01');
    expect(startOfMonth('2026-01-31', -1)).toBe('2025-12-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
  });

  it('donne le jour civil dans le fuseau', () => {
    expect(todayCivil('Africa/Tunis', new Date('2026-09-25T23:30:00.000Z'))).toBe('2026-09-26');
    expect(civilStart('2026-09-26', 'Africa/Tunis').toISOString()).toBe('2026-09-25T23:00:00.000Z');
  });
});
