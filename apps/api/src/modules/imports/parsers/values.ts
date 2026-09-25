import { DateTime } from 'luxon';

/**
 * Valeurs acceptées à l'import (CDC 12.1, D-278) — implémentation unique, documentée dans
 * docs/guide-imports.md. Toute valeur ambiguë est refusée avec un message explicite.
 *  - Dates : AAAA-MM-JJ, JJ/MM/AAAA (jour en premier, année sur 4 chiffres) ou cellule date XLSX.
 *  - Horodatages : AAAA-MM-JJ HH:mm[:ss], JJ/MM/AAAA HH:mm, ou ISO 8601 avec décalage ; sans décalage,
 *    l'heure est locale au groupe ; une date seule vaut 00:00 locale (« heure non fournie »).
 *  - Kilomètres : entiers sans séparateur (« 45.230 » est ambigu : refusé).
 *  - Booléens : oui/non, true/false, 1/0, actif/inactif.
 * Une cellule date XLSX porte aussi son heure murale (`time`, HH:mm:ss.SSS) quand le classeur en contient
 * une ; les imports n'utilisent que `date`, le canal télématique RAPPORT (D-184) lit aussi l'heure.
 */
export type Cell = string | { date: string; time?: string } | null;

export type Parsed<T> = { ok: true; value: T; note?: string } | { ok: false; message: string };

const ok = <T>(value: T, note?: string): Parsed<T> => (note ? { ok: true, value, note } : { ok: true, value });
const fail = (message: string): Parsed<never> => ({ ok: false, message });

export function cellText(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell.trim();
  return cell.date;
}

export function isEmpty(cell: Cell): boolean {
  return cellText(cell) === '';
}

function validCivil(y: number, m: number, d: number): string | null {
  const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: 'UTC' });
  if (!dt.isValid || dt.year !== y || dt.month !== m || dt.day !== d) return null;
  return dt.toISODate();
}

export function parseCivilDate(cell: Cell): Parsed<string> {
  if (cell !== null && typeof cell === 'object') return ok(cell.date);
  const s = cellText(cell);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const v = validCivil(Number(m[1]), Number(m[2]), Number(m[3]));
    return v ? ok(v) : fail(`Date inexistante : « ${s} ».`);
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) {
    const v = validCivil(Number(m[3]), Number(m[2]), Number(m[1]));
    return v ? ok(v) : fail(`Date inexistante : « ${s} ».`);
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) return fail(`Année sur deux chiffres refusée : « ${s} » (format JJ/MM/AAAA).`);
  if (/^\d+(\.\d+)?$/.test(s)) return fail(`Numéro de série de date Excel refusé dans un fichier texte : « ${s} ».`);
  return fail(`Date non reconnue : « ${s} » (formats acceptés : AAAA-MM-JJ ou JJ/MM/AAAA).`);
}

export function parseTimestamp(cell: Cell, timezone: string): Parsed<Date> {
  if (cell !== null && typeof cell === 'object') {
    const dt = DateTime.fromISO(cell.date, { zone: timezone }).startOf('day');
    return ok(dt.toJSDate(), 'heure non fournie');
  }
  const s = cellText(cell);
  if (/^\d{4}-\d{2}-\d{2}T.+([+-]\d{2}:\d{2}|Z)$/.test(s)) {
    const dt = DateTime.fromISO(s, { setZone: true });
    return dt.isValid ? ok(dt.toUTC().toJSDate()) : fail(`Horodatage invalide : « ${s} ».`);
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  let parts: number[] | null = m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : null;
  if (!parts) {
    m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    parts = m ? [Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : null;
  }
  if (parts) {
    const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number];
    const dt = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: timezone });
    if (!dt.isValid || dt.day !== day || dt.hour !== hour) return fail(`Horodatage inexistant : « ${s} ».`);
    return ok(dt.toUTC().toJSDate());
  }
  const date = parseCivilDate(cell);
  if (date.ok) return ok(DateTime.fromISO(date.value, { zone: timezone }).startOf('day').toJSDate(), 'heure non fournie');
  return fail(`Horodatage non reconnu : « ${s} » (AAAA-MM-JJ HH:mm, JJ/MM/AAAA HH:mm ou ISO avec décalage).`);
}

export function parseIntegerKm(cell: Cell): Parsed<number> {
  const s = cellText(cell);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? ok(n) : fail(`Valeur trop grande : « ${s} ».`);
  }
  if (/^\d+[.,\s]\d+/.test(s)) return fail(`Kilométrage ambigu : « ${s} » (entier sans séparateur attendu, ex. 45230).`);
  return fail(`Kilométrage invalide : « ${s} » (entier positif attendu).`);
}

export function parseBoolean(cell: Cell): Parsed<boolean> {
  const s = cellText(cell).toLowerCase();
  if (['oui', 'true', '1', 'actif', 'vrai'].includes(s)) return ok(true);
  if (['non', 'false', '0', 'inactif', 'faux'].includes(s)) return ok(false);
  return fail(`Valeur booléenne non reconnue : « ${cellText(cell)} » (oui/non, true/false, 1/0, actif/inactif).`);
}

export function parseDecimal(cell: Cell): Parsed<string> {
  const s = cellText(cell);
  if (/^\d+(\.\d{1,3})?$/.test(s)) return ok(s);
  return fail(`Nombre invalide : « ${s} » (point décimal, trois décimales au plus).`);
}
