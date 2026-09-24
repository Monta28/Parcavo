import type { FreshnessStatus } from '@parc-auto/contracts';

/**
 * Fraîcheur du kilométrage (CDC 5.5) : aucun relevé accepté → INCONNU ; au-delà du seuil (7 jours par
 * défaut) sans observation acceptée → A_ACTUALISER ; sinon A_JOUR. L'état est indépendant des échéances.
 */
export interface FreshnessResult {
  status: FreshnessStatus;
  ageDays: number | null;
  lastObservedAt: Date | null;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Limite d'ancienneté : une dernière observation acceptée strictement antérieure à cet instant est
 * ancienne (A_ACTUALISER). Seule définition du seuil, partagée par computeFreshness et les filtres
 * de liste (D-269).
 */
export function staleBefore(now: Date, staleAfterDays: number): Date {
  return new Date(now.getTime() - staleAfterDays * DAY_MS);
}

export function computeFreshness(lastAcceptedObservedAt: Date | null, now: Date, staleAfterDays: number): FreshnessResult {
  if (!lastAcceptedObservedAt) return { status: 'INCONNU', ageDays: null, lastObservedAt: null };
  const ageMs = now.getTime() - lastAcceptedObservedAt.getTime();
  const ageDays = Math.max(0, ageMs / DAY_MS);
  return {
    status: lastAcceptedObservedAt.getTime() < staleBefore(now, staleAfterDays).getTime() ? 'A_ACTUALISER' : 'A_JOUR',
    ageDays: Math.floor(ageDays),
    lastObservedAt: lastAcceptedObservedAt,
  };
}
