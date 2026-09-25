import { DateTime } from 'luxon';
import { toDbDate } from '../../../domain/civil-date.js';

/** Horodatage local lisible : fonction unique du domaine (civil-date.ts). */
export { formatLocalDateTime } from '../../../domain/civil-date.js';

/** Date civile AAAA-MM-JJ → JJ/MM/AAAA : fonction unique du domaine (civil-date.ts). */
export { formatCivilDate } from '../../../domain/civil-date.js';

/**
 * Heure murale locale représentée comme un instant UTC : un tableur n'a pas de fuseau, la cellule XLSX
 * affiche ainsi l'heure locale du groupe (fuseau indiqué dans les paramètres de l'export).
 */
export function localWallClock(instant: Date, timezone: string): Date {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond));
}

/** Date civile AAAA-MM-JJ → minuit UTC (cellule date XLSX, sans fuseau) : conversion unique du domaine. */
export function civilDateCell(date: string): Date {
  return toDbDate(date) as Date;
}
