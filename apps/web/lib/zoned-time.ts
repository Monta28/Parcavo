/**
 * Conversions d'heures murales dans le fuseau de l'organisation (session.timezone), indépendantes du
 * fuseau du navigateur. Aucune règle métier : uniquement du calendrier (jours civils, bornes de fenêtre).
 * Les dates civiles sont des chaînes « AAAA-MM-JJ », les saisies datetime-local des chaînes « AAAA-MM-JJTHH:mm ».
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timezone, f);
  }
  return f;
}

/** Composantes de l'heure murale d'un instant dans un fuseau. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timezone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1, hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0, second: parts.second ?? 0 };
}

function offsetMs(date: Date, timezone: string): number {
  const p = zonedParts(date, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instant correspondant à une heure murale dans un fuseau (heure d'été gérée). */
export function wallTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), timezone);
  let t = guess - first;
  const second = offsetMs(new Date(t), timezone);
  if (second !== first) t = guess - second;
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, '0');

function civilOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function parseCivil(civil: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function isCivilDate(value: string): boolean {
  return parseCivil(value) !== null;
}

/** Date civile du jour dans le fuseau. */
export function todayCivil(timezone: string, now: Date = new Date()): string {
  const p = zonedParts(now, timezone);
  return civilOf(p.year, p.month, p.day);
}

export function addDays(civil: string, days: number): string {
  const c = parseCivil(civil);
  if (!c) return civil;
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return civilOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Premier jour du mois, décalé de `months` mois. */
export function startOfMonth(civil: string, months = 0): string {
  const c = parseCivil(civil);
  if (!c) return civil;
  const d = new Date(Date.UTC(c.year, c.month - 1 + months, 1));
  return civilOf(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Lundi de la semaine (usage français). */
export function startOfWeek(civil: string): string {
  const c = parseCivil(civil);
  if (!c) return civil;
  const dow = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
  return addDays(civil, -((dow + 6) % 7));
}

/** Jour de semaine d'une date civile (0 = dimanche). */
export function weekdayOf(civil: string): number {
  const c = parseCivil(civil);
  if (!c) return 0;
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
}

/** Nombre de jours civils entre deux dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const ca = parseCivil(a);
  const cb = parseCivil(b);
  if (!ca || !cb) return 0;
  return Math.round((Date.UTC(cb.year, cb.month - 1, cb.day) - Date.UTC(ca.year, ca.month - 1, ca.day)) / 86_400_000);
}

/** Minuit (début du jour civil) dans le fuseau. */
export function civilStart(civil: string, timezone: string): Date {
  const c = parseCivil(civil);
  if (!c) return new Date(Number.NaN);
  return wallTimeToDate(c.year, c.month, c.day, 0, 0, timezone);
}

/** Heure murale d'un jour civil dans le fuseau (heure 24 = minuit du lendemain). */
export function civilHour(civil: string, hour: number, timezone: string): Date {
  if (hour >= 24) return civilStart(addDays(civil, 1), timezone);
  const c = parseCivil(civil);
  if (!c) return new Date(Number.NaN);
  return wallTimeToDate(c.year, c.month, c.day, hour, 0, timezone);
}

/** Saisie datetime-local (heure murale du fuseau) vers ISO 8601 UTC ; null si invalide. */
export function localInputToIso(value: string, timezone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m || !parseCivil(`${m[1]}-${m[2]}-${m[3]}`)) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  return wallTimeToDate(Number(m[1]), Number(m[2]), Number(m[3]), hour, minute, timezone).toISOString();
}

/** Instant ISO vers valeur datetime-local dans le fuseau (à la minute). */
export function isoToLocalInput(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, timezone);
  return `${civilOf(p.year, p.month, p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Date civile d'un instant dans le fuseau. */
export function isoToCivil(iso: string, timezone: string): string {
  const p = zonedParts(new Date(iso), timezone);
  return civilOf(p.year, p.month, p.day);
}

/** Heure murale courante (à la minute), pour préremplir une saisie datetime-local. */
export function nowLocalInput(timezone: string, now: Date = new Date()): string {
  return isoToLocalInput(now.toISOString(), timezone);
}
