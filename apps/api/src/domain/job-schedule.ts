/**
 * Créneaux des traitements planifiés du worker (CDC 9.3, 14.4 ; D-200, D-257) — implémentation unique,
 * sans accès aux données. Un créneau est aligné sur l'époque UTC : pour 15 minutes, :00, :15, :30 et :45
 * UTC. Chaque créneau s'exécute au plus une fois (clé de déduplication) ; un créneau manqué pendant un
 * arrêt est rattrapé au redémarrage, sans rejouer les créneaux antérieurs.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Début du créneau de période `periodMs` contenant `now`. */
export function slotStart(now: Date, periodMs: number): Date {
  if (!Number.isInteger(periodMs) || periodMs <= 0) throw new Error(`Période invalide : ${periodMs}`);
  return new Date(Math.floor(now.getTime() / periodMs) * periodMs);
}

/** Clé de déduplication d'une exécution planifiée : type, portée facultative et début du créneau. */
export function scheduledRunKey(task: string, slot: Date, scope?: string | null): string {
  return ['planifie', task, ...(scope ? [scope] : []), slot.toISOString()].join(':');
}

/** Intervalle de rattrapage des alertes borné comme le paramètre alerts.catchUpIntervalMinutes (5 à 60). */
export function catchUpPeriodMs(intervalMinutes: number): number {
  const minutes = Number.isFinite(intervalMinutes) ? Math.min(60, Math.max(5, Math.round(intervalMinutes))) : 15;
  return minutes * MINUTE_MS;
}
