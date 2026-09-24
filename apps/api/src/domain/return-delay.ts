import { endOfLocalDay, localDate } from './civil-date.js';

/**
 * Retard de restitution d'une utilisation (CDC 4.4, 11.2) — règle unique pour les rapports.
 * Le retour prévu est dépassé lorsque le retour réel (ou maintenant, pour une utilisation en cours)
 * intervient plus de `toleranceMinutes` après le retour prévu (paramètre usage.lateReturnToleranceMinutes).
 */
export interface ReturnDelayInput {
  expectedReturnAt: Date;
  /** null : utilisation en cours. */
  returnedAt: Date | null;
  now: Date;
  toleranceMinutes: number;
}

export interface ReturnDelay {
  late: boolean;
  /** Minutes écoulées depuis le retour prévu, uniquement en cas de retard. */
  delayMinutes: number | null;
  /** Retard toujours en cours (utilisation non restituée). */
  ongoing: boolean;
}

export function returnDelay(input: ReturnDelayInput): ReturnDelay {
  const reference = (input.returnedAt ?? input.now).getTime();
  const overdueMs = reference - input.expectedReturnAt.getTime();
  const late = overdueMs > Math.max(0, input.toleranceMinutes) * 60_000;
  return { late, delayMinutes: late ? Math.floor(overdueMs / 60_000) : null, ongoing: late && input.returnedAt === null };
}

/**
 * Retours attendus : utilisations EN_COURS dont le retour prévu tombe au plus tard à la fin de la
 * journée locale courante (retours dépassés compris). Renvoie la limite incluse.
 */
export function returnDueBefore(now: Date, timezone: string): Date {
  return endOfLocalDay(localDate(now, timezone), timezone);
}

export function isReturnDue(expectedReturnAt: Date, now: Date, timezone: string): boolean {
  return expectedReturnAt.getTime() <= returnDueBefore(now, timezone).getTime();
}
