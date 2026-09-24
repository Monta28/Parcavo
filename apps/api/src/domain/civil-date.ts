import { DateTime } from 'luxon';

/**
 * Dates civiles dans le fuseau du groupe (CDC 9.3, 7.1, 6.2). Les échéances sont stockées en DATE ;
 * une date de fin reste valable jusqu'à la fin de ce jour local.
 */
export type CivilDate = string; // AAAA-MM-JJ

export function assertCivilDate(value: string): CivilDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !DateTime.fromISO(value, { zone: 'utc' }).isValid) {
    throw new Error(`Date civile invalide : ${value}`);
  }
  return value;
}

/** Date civile locale d'un instant. */
export function localDate(instant: Date, timezone: string): CivilDate {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate() as string;
}

/** Instant de début du jour local. */
export function startOfLocalDay(date: CivilDate, timezone: string): Date {
  return DateTime.fromISO(date, { zone: timezone }).startOf('day').toJSDate();
}

/** Instant de fin du jour local (dernière milliseconde). */
export function endOfLocalDay(date: CivilDate, timezone: string): Date {
  return DateTime.fromISO(date, { zone: timezone }).endOf('day').toJSDate();
}

/** Ajout de mois calendaires ; une date inexistante est ramenée au dernier jour du mois cible (CDC 6.2). */
export function addCalendarMonths(date: CivilDate, months: number): CivilDate {
  const start = DateTime.fromISO(date, { zone: 'utc' });
  const target = start.plus({ months });
  // Luxon ramène déjà au dernier jour du mois ; la vérification garde le comportement explicite.
  const clamped = target.day < start.day && target.daysInMonth !== undefined && target.daysInMonth < start.day ? target.endOf('month') : target;
  return clamped.toISODate() as string;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate() as string;
}

/** Nombre de jours civils entre deux dates (b - a). */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days);
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bornes du mois civil contenant la date : premier et dernier jour (inclusifs), sans conversion de fuseau. */
export function monthBounds(date: CivilDate): { from: CivilDate; to: CivilDate } {
  const day = DateTime.fromISO(date, { zone: 'utc' });
  return { from: day.startOf('month').toISODate() as string, to: day.endOf('month').toISODate() as string };
}

/**
 * Date civile affichée au format français JJ/MM/AAAA : fonction unique des textes rédigés par l'API
 * (détails de conformité, messages d'alerte). Aucune conversion de fuseau : la date est déjà civile.
 */
export function formatCivilDate(date: CivilDate): string {
  const [year, month, day] = assertCivilDate(date).split('-');
  return `${day}/${month}/${year}`;
}

/** Convertit une DATE PostgreSQL (Date à minuit UTC) en date civile. */
export function fromDbDate(value: Date | null | undefined): CivilDate | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** Convertit une date civile en valeur DATE PostgreSQL (minuit UTC). */
export function toDbDate(value: CivilDate | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

/**
 * Horodatage local lisible dans le fuseau du groupe (fonction unique d'affichage) : « 24/09/2026 11:00 »
 * dans un tableau, « 24/09/2026 à 11:00 » dans une phrase ; secondes sur demande.
 */
export function formatLocalDateTime(instant: Date, timezone: string, options: { withSeconds?: boolean; sentence?: boolean } = {}): string {
  const time = options.withSeconds ? 'HH:mm:ss' : 'HH:mm';
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat(options.sentence ? `dd/MM/yyyy 'à' ${time}` : `dd/MM/yyyy ${time}`);
}
