import { ProviderError } from '../telemetry-provider.interface.js';

/**
 * Planification et résilience de la synchronisation télématique (CDC 14.4 ; D-296, D-297) — règles
 * uniques, pures, utilisées par le service de synchronisation (API et worker) :
 *  - reprises dans un même run après 1, 4 puis 16 s pour une erreur transitoire (fournisseur injoignable,
 *    quota) ; un 429 respecte l'en-tête Retry-After (au-delà du plafond d'attente, le run s'arrête et
 *    l'appel suivant est différé d'autant) ;
 *  - délai entre deux runs d'un couple fournisseur-société : intervalle × 2^n (n = échecs consécutifs),
 *    plafonné à 60 min, jamais inférieur à l'intervalle configuré ;
 *  - coupe-circuit après 5 échecs consécutifs, ouvert 60 min : les créneaux échus pendant l'ouverture
 *    sont tracés IGNORE sans appel au fournisseur, puis un essai unique (sans reprise) décide de la
 *    fermeture (succès) ou d'une nouvelle ouverture (échec).
 */
export interface SyncPolicy {
  /** Attentes avant chaque reprise dans un même run (ms). */
  retryDelaysMs: readonly number[];
  /** Attente maximale acceptée dans un run pour honorer un Retry-After (ms). */
  maxRetryAfterMs: number;
  /** Plafond du délai entre deux runs (minutes). */
  backoffCapMinutes: number;
  /** Nombre d'échecs consécutifs qui ouvre le coupe-circuit. */
  circuitThreshold: number;
  /** Durée d'ouverture du coupe-circuit (minutes). */
  circuitOpenMinutes: number;
  /** Durée du bail d'exécution telemetry-sync:<fournisseur>:<société>, renouvelé pendant le run (ms). */
  leaseTtlMs: number;
  /** Intervalle minimal entre deux listes d'unités d'un même fournisseur (ms). */
  discoveryEveryMs: number;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = Object.freeze({
  retryDelaysMs: Object.freeze([1_000, 4_000, 16_000]),
  maxRetryAfterMs: 60_000,
  backoffCapMinutes: 60,
  circuitThreshold: 5,
  circuitOpenMinutes: 60,
  leaseTtlMs: 5 * 60_000,
  discoveryEveryMs: 60 * 60_000,
});

const MINUTE_MS = 60_000;

/** Erreurs fournisseur transitoires : une reprise dans le run a un sens. */
export function isTransientProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && (error.kind === 'INJOIGNABLE' || error.kind === 'QUOTA');
}

/**
 * Attente avant la reprise n° `retryIndex` (0 = première reprise), ou null si aucune reprise ne doit être
 * tentée : erreur non transitoire, reprises épuisées, ou Retry-After supérieur au plafond d'attente.
 */
export function retryDelayMs(error: unknown, retryIndex: number, policy: SyncPolicy = DEFAULT_SYNC_POLICY): number | null {
  if (!isTransientProviderError(error)) return null;
  if (retryIndex >= policy.retryDelaysMs.length) return null;
  if (error.kind === 'QUOTA' && error.retryAfterSeconds !== null) {
    const wait = error.retryAfterSeconds * 1000;
    return wait <= policy.maxRetryAfterMs ? wait : null;
  }
  return policy.retryDelaysMs[retryIndex] ?? null;
}

/** Délai entre deux runs : max(intervalle, min(intervalle × 2^n, plafond)). */
export function betweenRunsDelayMs(intervalMinutes: number, consecutiveFailures: number, policy: SyncPolicy = DEFAULT_SYNC_POLICY): number {
  const base = Math.max(1, intervalMinutes) * MINUTE_MS;
  const exponent = Math.min(Math.max(0, consecutiveFailures), 20);
  const backoff = Math.min(base * 2 ** exponent, policy.backoffCapMinutes * MINUTE_MS);
  return Math.max(base, backoff);
}

export type ScheduleDecision =
  | { kind: 'NOT_DUE'; nextAt: Date }
  | { kind: 'RUN'; halfOpen: boolean }
  | { kind: 'IGNORE'; circuitOpenUntil: Date };

export interface ScheduleInput {
  now: Date;
  /** Début du dernier run du couple fournisseur-société (IGNORE compris), null s'il n'y en a jamais eu. */
  lastRunAt: Date | null;
  intervalMinutes: number;
  consecutiveFailures: number;
  /** Instant avant lequel aucun appel n'est fait (coupe-circuit ou quota fournisseur). */
  circuitOpenUntil: Date | null;
  /** Reprise initiale en attente sur une association nouvellement confirmée (fournisseur sain). */
  backfillPending?: boolean;
}

/**
 * Décision de planification d'un couple fournisseur-société à l'instant `now` :
 *  - appel interdit (coupe-circuit ou quota) : IGNORE si un créneau d'intervalle est échu, sinon NOT_DUE ;
 *  - coupe-circuit expiré après ouverture : essai unique immédiat (halfOpen) ; un essai resté sans
 *    appel (ni succès ni échec) n'est renouvelé qu'à l'intervalle suivant ;
 *  - sinon : échu si le dernier run date d'au moins le délai exponentiel ; une reprise initiale en
 *    attente est lancée sans attendre lorsque le fournisseur n'est pas en échec.
 */
export function scheduleDecision(input: ScheduleInput, policy: SyncPolicy = DEFAULT_SYNC_POLICY): ScheduleDecision {
  const { now, lastRunAt } = input;
  const interval = Math.max(1, input.intervalMinutes) * MINUTE_MS;
  if (input.circuitOpenUntil && input.circuitOpenUntil.getTime() > now.getTime()) {
    if (!lastRunAt || lastRunAt.getTime() + interval <= now.getTime()) return { kind: 'IGNORE', circuitOpenUntil: input.circuitOpenUntil };
    return { kind: 'NOT_DUE', nextAt: new Date(Math.min(lastRunAt.getTime() + interval, input.circuitOpenUntil.getTime())) };
  }
  if (input.consecutiveFailures >= policy.circuitThreshold) {
    // Essai unique dès l'expiration ; s'il n'a rien tranché (aucun appel possible), le suivant attend
    // l'intervalle : jamais un run à chaque passage du worker.
    const trialPending = input.circuitOpenUntil !== null && (!lastRunAt || lastRunAt.getTime() < input.circuitOpenUntil.getTime());
    if (trialPending || !lastRunAt || lastRunAt.getTime() + interval <= now.getTime()) return { kind: 'RUN', halfOpen: true };
    return { kind: 'NOT_DUE', nextAt: new Date(lastRunAt.getTime() + interval) };
  }
  if (!lastRunAt) return { kind: 'RUN', halfOpen: false };
  if (input.backfillPending && input.consecutiveFailures === 0) return { kind: 'RUN', halfOpen: false };
  const nextAt = lastRunAt.getTime() + betweenRunsDelayMs(input.intervalMinutes, input.consecutiveFailures, policy);
  return nextAt <= now.getTime() ? { kind: 'RUN', halfOpen: false } : { kind: 'NOT_DUE', nextAt: new Date(nextAt) };
}

export interface FailureTransition {
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  /** Vrai quand cet échec ouvre (ou rouvre après l'essai unique) le coupe-circuit. */
  circuitOpened: boolean;
}

/**
 * État du fournisseur après un run en échec : échecs consécutifs + 1 ; au seuil (ou à l'échec de l'essai
 * unique), coupe-circuit ouvert pour la durée prévue. Un quota avec Retry-After trop long pour être
 * attendu dans le run diffère l'appel suivant d'autant, sans ouvrir le coupe-circuit.
 */
export function failureTransition(input: { consecutiveFailures: number; now: Date; retryAfterSeconds?: number | null }, policy: SyncPolicy = DEFAULT_SYNC_POLICY): FailureTransition {
  const failures = input.consecutiveFailures + 1;
  if (failures >= policy.circuitThreshold) {
    return { consecutiveFailures: failures, circuitOpenUntil: new Date(input.now.getTime() + policy.circuitOpenMinutes * MINUTE_MS), circuitOpened: true };
  }
  const quotaHold = input.retryAfterSeconds && input.retryAfterSeconds * 1000 > policy.maxRetryAfterMs ? new Date(input.now.getTime() + input.retryAfterSeconds * 1000) : null;
  return { consecutiveFailures: failures, circuitOpenUntil: quotaHold, circuitOpened: false };
}

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appel fournisseur avec reprises bornées dans le run (1, 4, 16 s ; Retry-After honoré). `retries` faux :
 * un seul essai (essai unique du coupe-circuit, canal RAPPORT dont le lot est lu une fois par exécution).
 * Renvoie le résultat ou lève la dernière erreur ; `attempts` compte les essais réalisés.
 */
export async function callWithRetries<T>(
  call: () => Promise<T>,
  options: { sleep: Sleep; retries: boolean; policy?: SyncPolicy; onRetry?: (error: unknown, waitMs: number, retryIndex: number) => void },
): Promise<{ value: T; attempts: number }> {
  const policy = options.policy ?? DEFAULT_SYNC_POLICY;
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return { value: await call(), attempts: retryIndex + 1 };
    } catch (error) {
      const wait = options.retries ? retryDelayMs(error, retryIndex, policy) : null;
      if (wait === null) throw error;
      options.onRetry?.(error, wait, retryIndex);
      await options.sleep(wait);
    }
  }
}
