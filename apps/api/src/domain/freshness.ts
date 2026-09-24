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

export function computeFreshness(lastAcceptedObservedAt: Date | null, now: Date, staleAfterDays: number): FreshnessResult {
  if (!lastAcceptedObservedAt) return { status: 'INCONNU', ageDays: null, lastObservedAt: null };
  const ageMs = now.getTime() - lastAcceptedObservedAt.getTime();
  const ageDays = Math.max(0, ageMs / DAY_MS);
  return {
    status: ageMs > staleAfterDays * DAY_MS ? 'A_ACTUALISER' : 'A_JOUR',
    ageDays: Math.floor(ageDays),
    lastObservedAt: lastAcceptedObservedAt,
  };
}
