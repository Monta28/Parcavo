import type { Prisma, SyncTrigger, TelemetryChannel, TelemetryProviderKind } from '@parc-auto/db';

/** Association telle que l'ingestion en a besoin (véhicule et unité compris). */
export const syncMappingInclude = {
  vehicle: { select: { id: true, code: true, companyId: true, lifecycleStatus: true, disposedAt: true, archivedAt: true, tankCapacityLiters: true } },
} satisfies Prisma.TelemetryVehicleMappingInclude;
export type SyncMapping = Prisma.TelemetryVehicleMappingGetPayload<{ include: typeof syncMappingInclude }>;

/** Unité associée d'un couple fournisseur-société, avec ses associations (ouverte et clôturées) et son état. */
export interface MappedUnit {
  unitId: string;
  externalId: string;
  label: string;
  /** Associations de l'unité dans la société du run, triées par date d'effet. */
  mappings: SyncMapping[];
  /** Association ouverte (CONFIRME, validTo nul). */
  open: SyncMapping;
  state: {
    lastOdometerValueKm: Prisma.Decimal | null;
    lastOdometerObservedAt: Date | null;
    lastFuelObservedAt: Date | null;
    lastHistorizedAt: Date | null;
    lastHistorizedValueKm: Prisma.Decimal | null;
  } | null;
}

/** Contexte d'un run fournisseur-société. */
export interface RunScope {
  runId: string;
  trigger: SyncTrigger;
  organizationId: string;
  companyId: string;
  provider: { id: string; kind: TelemetryProviderKind; channel: TelemetryChannel; backfillDays: number };
  now: Date;
  timezone: string;
  /** Associations en reprise initiale (historique) dans ce run. */
  backfillMappingIds: ReadonlySet<string>;
}

/** Compteurs d'un run (TelemetrySyncRun) ; les motifs d'écart sont agrégés en français. */
export interface RunCounters {
  odometerSamples: number;
  readingsCreated: number;
  readingsPending: number;
  duplicatesIgnored: number;
  fuelSamples: number;
  fuelEventsCreated: number;
  /** Écarts et refus par motif (sans contenu brut du fournisseur), informatifs ou en erreur. */
  issues: Record<string, number>;
  /** Nombre d'erreurs (échantillons refusés, conflits, appels en échec, erreurs techniques). */
  errors: number;
  /** Remarques consignées dans le run (reprise limitée à l'état courant, etc.). */
  notes: string[];
}

export function newCounters(): RunCounters {
  return { odometerSamples: 0, readingsCreated: 0, readingsPending: 0, duplicatesIgnored: 0, fuelSamples: 0, fuelEventsCreated: 0, issues: {}, errors: 0, notes: [] };
}

/** Motif informatif (échantillon conservé ou ignoré selon les règles, sans erreur). */
export function countIssue(counters: RunCounters, reason: string, n = 1): void {
  if (n <= 0) return;
  counters.issues[reason] = (counters.issues[reason] ?? 0) + n;
}

/** Motif en erreur : compté dans TelemetrySyncRun.errorCount et rend le run PARTIEL. */
export function countError(counters: RunCounters, reason: string, n = 1): void {
  if (n <= 0) return;
  countIssue(counters, reason, n);
  counters.errors += n;
}

/** Association couvrant l'instant : CONFIRME ou CLOTURE, validFrom ≤ t < validTo (validTo nul = en cours). */
export function coveringMapping(mappings: readonly SyncMapping[], at: Date): SyncMapping | null {
  let best: SyncMapping | null = null;
  for (const m of mappings) {
    if (m.status !== 'CONFIRME' && m.status !== 'CLOTURE') continue;
    if (!m.validFrom || m.validFrom.getTime() > at.getTime()) continue;
    if (m.validTo && m.validTo.getTime() <= at.getTime()) continue;
    if (!best || (best.validFrom as Date).getTime() < m.validFrom.getTime()) best = m;
  }
  return best;
}

/**
 * Véhicule ACTIF à la date d'observation (D-175, D-186) : ACTIF aujourd'hui, ou cédé/archivé après cet
 * instant. Un véhicule hors service n'a pas d'historique de statut : il est traité comme non actif.
 */
export function vehicleActiveAt(vehicle: SyncMapping['vehicle'], at: Date): boolean {
  if (vehicle.lifecycleStatus === 'ACTIF') return true;
  if (vehicle.lifecycleStatus === 'CEDE' && vehicle.disposedAt) return at.getTime() < vehicle.disposedAt.getTime();
  if (vehicle.lifecycleStatus === 'ARCHIVE' && vehicle.archivedAt) return at.getTime() < vehicle.archivedAt.getTime();
  return false;
}
