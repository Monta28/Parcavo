import type { Decimal } from 'decimal.js';
import { localDate } from '../civil-date.js';

/**
 * Historisation des échantillons kilométriques automatiques (CDC 5.6, D-181, D-182) : l'état de
 * chaque unité est mis à jour à chaque synchronisation, mais un OdometerReading TELEMATICS n'est
 * créé que si l'échantillon :
 *  - est le premier après la confirmation du mapping ou après une période de source muette ;
 *  - est le premier du jour civil local (relevé quotidien, observedAt réel, jamais un 00:00 fabriqué) ;
 *  - franchit un seuil d'un plan actif acceptant cette source (échéance − préavis, échéance,
 *    échéance + 1 km), afin que l'alerte d'entretien parte en moins d'une minute (T42) ;
 *  - a progressé et survient au moins une heure après le dernier relevé historisé.
 * Les échantillons en désordre ou déjà couverts ne produisent rien. Fonction pure.
 */
export type HistorizationReason = 'PREMIER' | 'QUOTIDIEN' | 'SEUIL' | 'HORAIRE';

export interface HistorizationInput {
  sampleKm: Decimal;
  observedAt: Date;
  timezone: string;
  lastHistorized: { km: Decimal; observedAt: Date } | null;
  firstAfterMappingOrSilence: boolean;
  minIntervalMinutes: number;
  thresholdsKm: readonly Decimal[];
}

export function historizationReason(input: HistorizationInput): HistorizationReason | null {
  const last = input.lastHistorized;
  if (!last || input.firstAfterMappingOrSilence) return 'PREMIER';
  if (input.observedAt.getTime() <= last.observedAt.getTime()) return null;
  if (localDate(input.observedAt, input.timezone) !== localDate(last.observedAt, input.timezone)) return 'QUOTIDIEN';
  if (input.thresholdsKm.some((t) => last.km.lt(t) && input.sampleKm.gte(t))) return 'SEUIL';
  const minutes = (input.observedAt.getTime() - last.observedAt.getTime()) / 60_000;
  if (input.sampleKm.gt(last.km) && minutes >= input.minIntervalMinutes) return 'HORAIRE';
  return null;
}

/** Seuils kilométriques d'un plan : échéance − préavis, échéance, échéance + 1 km. */
export function planThresholds(nextDueKm: Decimal | null, noticeKm: Decimal | null): Decimal[] {
  if (!nextDueKm) return [];
  const out = [nextDueKm, nextDueKm.plus(1)];
  if (noticeKm && noticeKm.gt(0)) out.unshift(nextDueKm.minus(noticeKm));
  return out;
}
