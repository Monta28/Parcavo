import type { VehicleLifecycle } from '@parc-auto/db';
import type { VehicleOperationalStatus } from '@parc-auto/contracts';
import { assertCivilDate, compareCivil, monthBounds, type CivilDate } from './civil-date.js';
import { operationalStatus } from './vehicle-status.js';

/**
 * Règles du tableau de bord (CDC 11.1 ; D-269) : les états sont instantanés et horodatés, les flux
 * sont filtrés par une période en dates civiles inclusives (mois civil local courant par défaut).
 */
export interface IndicatorPeriod {
  from: CivilDate;
  to: CivilDate;
}

export type PeriodResolution =
  | { ok: true; period: IndicatorPeriod; defaulted: boolean }
  | { ok: false; code: 'PERIODE_INCOMPLETE' | 'PERIODE_INVALIDE'; field: 'from' | 'to'; message: string };

function validCivil(value: string): boolean {
  try {
    assertCivilDate(value);
    return true;
  } catch {
    return false;
  }
}

/** Période des indicateurs de flux : les deux bornes ou aucune (mois civil local de « aujourd'hui »). */
export function resolveIndicatorPeriod(from: string | undefined, to: string | undefined, today: CivilDate): PeriodResolution {
  if (!from && !to) return { ok: true, period: monthBounds(today), defaulted: true };
  if (!from || !to) return { ok: false, code: 'PERIODE_INCOMPLETE', field: from ? 'to' : 'from', message: 'Indiquez les deux bornes de la période, ou aucune pour le mois civil en cours.' };
  if (!validCivil(from)) return { ok: false, code: 'PERIODE_INVALIDE', field: 'from', message: `Date de début invalide : ${from}.` };
  if (!validCivil(to)) return { ok: false, code: 'PERIODE_INVALIDE', field: 'to', message: `Date de fin invalide : ${to}.` };
  if (compareCivil(from, to) > 0) return { ok: false, code: 'PERIODE_INVALIDE', field: 'to', message: 'La date de début est postérieure à la date de fin.' };
  return { ok: true, period: { from, to }, defaulted: false };
}

// Retours attendus : règle des retours (return-delay.ts), réexportée pour le tableau de bord.
export { isReturnDue, returnDueBefore } from './return-delay.js';

export interface FleetVehicleFacts {
  lifecycle: VehicleLifecycle;
  hasActiveImmobilization: boolean;
  hasOpenUsage: boolean;
  /** Document bloquant applicable manquant ou expiré (document-compliance.ts). */
  blockingNonCompliant: boolean;
}

export interface FleetTally {
  /** Parc actif (cycle de vie ACTIF) : dénominateur des états. */
  active: number;
  outOfService: number;
  /** Partition exclusive des véhicules actifs (vehicle-status.ts). */
  byStatus: Record<VehicleOperationalStatus, number>;
  /** « Dont non conformes » : véhicules actifs avec un document bloquant manquant ou expiré. */
  nonCompliant: { active: number; byStatus: Record<VehicleOperationalStatus, number> };
}

/**
 * Décompte du parc : chaque véhicule actif compte dans un seul groupe, selon la priorité
 * IMMOBILISE > EN_UTILISATION > DISPONIBLE ; hors service, cédés et archivés n'y entrent jamais.
 */
export function tallyFleet(vehicles: readonly FleetVehicleFacts[]): FleetTally {
  const tally: FleetTally = {
    active: 0,
    outOfService: 0,
    byStatus: { DISPONIBLE: 0, EN_UTILISATION: 0, IMMOBILISE: 0 },
    nonCompliant: { active: 0, byStatus: { DISPONIBLE: 0, EN_UTILISATION: 0, IMMOBILISE: 0 } },
  };
  for (const v of vehicles) {
    if (v.lifecycle === 'HORS_SERVICE') tally.outOfService += 1;
    const status = operationalStatus({ lifecycle: v.lifecycle, hasActiveImmobilization: v.hasActiveImmobilization, hasOpenUsage: v.hasOpenUsage });
    if (status === null) continue;
    tally.active += 1;
    tally.byStatus[status] += 1;
    if (v.blockingNonCompliant) {
      tally.nonCompliant.active += 1;
      tally.nonCompliant.byStatus[status] += 1;
    }
  }
  return tally;
}
