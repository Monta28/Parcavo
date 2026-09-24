import { describe, expect, it } from 'vitest';
import { addCalendarMonths, addDays, diffDays, endOfLocalDay, localDate, startOfLocalDay } from './civil-date.js';

describe('dates civiles Africa/Tunis (CDC 9.3, 6.2, 7.1)', () => {
  it('convertit un instant UTC en date locale (Tunis = UTC+1 sans heure d’été)', () => {
    expect(localDate(new Date('2026-09-24T23:30:00Z'), 'Africa/Tunis')).toBe('2026-09-25');
    expect(localDate(new Date('2026-09-24T22:59:59Z'), 'Africa/Tunis')).toBe('2026-09-24');
  });
  it('calcule le début et la fin du jour local', () => {
    expect(startOfLocalDay('2026-09-24', 'Africa/Tunis').toISOString()).toBe('2026-09-23T23:00:00.000Z');
    expect(endOfLocalDay('2026-09-24', 'Africa/Tunis').toISOString()).toBe('2026-09-24T22:59:59.999Z');
  });
  it('ajoute des mois calendaires en ramenant une date inexistante au dernier jour du mois cible', () => {
    expect(addCalendarMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addCalendarMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addCalendarMonths('2026-03-31', 6)).toBe('2026-09-30');
    expect(addCalendarMonths('2026-02-28', 12)).toBe('2027-02-28');
    expect(addCalendarMonths('2026-05-15', 3)).toBe('2026-08-15');
  });
  it('ajoute et soustrait des jours', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-09-01', '2026-09-24')).toBe(23);
  });
});
