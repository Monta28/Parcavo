/**
 * Fraîcheur du battement du worker (CDC 16.3, D-315) : le worker enregistre un battement toutes les
 * 30 secondes (WorkerHeartbeat) ; il est considéré arrêté lorsque son dernier battement date de plus de
 * deux minutes (quatre battements manqués). Seule définition du seuil, lue par /health/worker et par le
 * champ informatif « worker » de /health/ready.
 */
export const WORKER_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export type WorkerHeartbeatStatus = 'actif' | 'arrete';

export interface WorkerHeartbeatFreshness {
  status: WorkerHeartbeatStatus;
  /** Âge du dernier battement en secondes entières (null sans aucun battement). */
  ageSeconds: number | null;
}

/**
 * Évalue le dernier battement connu à l'instant `now`. Un battement daté dans le futur (horloges
 * décalées entre conteneurs) compte comme récent, d'âge 0. Borne : exactement deux minutes reste actif.
 */
export function workerHeartbeatFreshness(lastBeatAt: Date | null, now: Date, staleAfterMs: number = WORKER_HEARTBEAT_STALE_MS): WorkerHeartbeatFreshness {
  if (!lastBeatAt) return { status: 'arrete', ageSeconds: null };
  const ageMs = Math.max(0, now.getTime() - lastBeatAt.getTime());
  return { status: ageMs <= staleAfterMs ? 'actif' : 'arrete', ageSeconds: Math.floor(ageMs / 1000) };
}
