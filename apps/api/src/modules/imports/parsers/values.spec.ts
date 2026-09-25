import { describe, expect, it } from 'vitest';
import { parseBoolean, parseCivilDate, parseIntegerKm, parseTimestamp } from './values.js';

describe('Valeurs d’import (CDC 12.1, D-278)', () => {
  it('dates : AAAA-MM-JJ, JJ/MM/AAAA, cellule date ; ambiguës refusées', () => {
    expect(parseCivilDate('2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(parseCivilDate('05/03/2026')).toEqual({ ok: true, value: '2026-03-05' });
    expect(parseCivilDate({ date: '2026-09-24' })).toEqual({ ok: true, value: '2026-09-24' });
    expect(parseCivilDate('31/02/2026').ok).toBe(false);
    expect(parseCivilDate('05/03/26').ok).toBe(false);
    expect(parseCivilDate('45123').ok).toBe(false);
    expect(parseCivilDate('mars 2026').ok).toBe(false);
  });
  it('horodatages : heure locale sans décalage, ISO avec décalage, date seule à 00:00 locale annotée', () => {
    expect(parseTimestamp('2026-09-24 10:30', 'Africa/Tunis')).toEqual({ ok: true, value: new Date('2026-09-24T09:30:00.000Z') });
    expect(parseTimestamp('24/09/2026 10:30', 'Africa/Tunis')).toEqual({ ok: true, value: new Date('2026-09-24T09:30:00.000Z') });
    expect(parseTimestamp('2026-09-24T10:30:00+02:00', 'Africa/Tunis')).toEqual({ ok: true, value: new Date('2026-09-24T08:30:00.000Z') });
    expect(parseTimestamp('2026-09-24', 'Africa/Tunis')).toEqual({ ok: true, value: new Date('2026-09-23T23:00:00.000Z'), note: 'heure non fournie' });
  });
  it('kilomètres entiers sans séparateur ; booléens', () => {
    expect(parseIntegerKm('45230')).toEqual({ ok: true, value: 45230 });
    expect(parseIntegerKm('45.230').ok).toBe(false);
    expect(parseIntegerKm('45,230').ok).toBe(false);
    expect(parseIntegerKm('-5').ok).toBe(false);
    expect(parseBoolean('Oui')).toEqual({ ok: true, value: true });
    expect(parseBoolean('inactif')).toEqual({ ok: true, value: false });
    expect(parseBoolean('peut-être').ok).toBe(false);
  });
});
