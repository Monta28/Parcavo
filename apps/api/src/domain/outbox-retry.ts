/**
 * Reprises de l'outbox e-mail (CDC 9.4 ; D-261, D-263) — implémentation unique, sans accès aux données.
 *  - Délai avant la tentative suivante après le n-ième échec : 1, 2, 4, 8, 16, 32 puis 60 minutes
 *    (doublement plafonné à 60 min) ; au-delà de maxAttempts tentatives (8 par défaut), ABANDONNE.
 *  - Verrou d'envoi (lockedUntil) de 2 minutes : une ligne EN_COURS dont le verrou a expiré (worker
 *    arrêté pendant l'envoi) repasse EN_ATTENTE et redevient éligible immédiatement.
 */

/** Délais de reprise en minutes après le 1er, 2e, … 8e échec (D-261). */
export const OUTBOX_RETRY_DELAYS_MINUTES: readonly number[] = [1, 2, 4, 8, 16, 32, 60, 60];

/** Plafond du délai de reprise (D-263). */
export const OUTBOX_MAX_RETRY_DELAY_MINUTES = 60;

/** Nombre de tentatives d'envoi par défaut avant abandon (NotificationOutbox.maxAttempts). */
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 8;

/** Durée du verrou d'une ligne en cours d'envoi (D-261). */
export const OUTBOX_LOCK_MS = 2 * 60 * 1000;

/** Délai (minutes) avant la reprise qui suit le n-ième échec (n ≥ 1). */
export function outboxRetryDelayMinutes(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) throw new Error(`Nombre d'échecs invalide : ${failedAttempts}`);
  return OUTBOX_RETRY_DELAYS_MINUTES[failedAttempts - 1] ?? OUTBOX_MAX_RETRY_DELAY_MINUTES;
}

export type OutboxFailureOutcome = { status: 'ECHEC'; nextAttemptAt: Date } | { status: 'ABANDONNE' };

/**
 * Issue d'une tentative d'envoi échouée : `attempts` compte les tentatives déjà effectuées, celle-ci
 * comprise. ECHEC avec la prochaine tentative tant que le plafond n'est pas atteint, sinon ABANDONNE.
 */
export function outboxFailureOutcome(attempts: number, maxAttempts: number, failedAt: Date): OutboxFailureOutcome {
  if (attempts >= maxAttempts) return { status: 'ABANDONNE' };
  return { status: 'ECHEC', nextAttemptAt: new Date(failedAt.getTime() + outboxRetryDelayMinutes(attempts) * 60_000) };
}

/** Fin du verrou d'une ligne réservée à `now`. */
export function outboxLockUntil(now: Date): Date {
  return new Date(now.getTime() + OUTBOX_LOCK_MS);
}
