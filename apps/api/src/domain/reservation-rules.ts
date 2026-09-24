/**
 * Règles pures des réservations et du planning (CDC 4.2, 4.5, 10.2 ; D-137, D-140, D-205). Seule
 * définition côté backend : bornes d'un créneau, périmètre modifiable après le début, délai de constat
 * de non-présentation, créneau d'une intervention au planning et chevauchement de créneaux [début, fin[.
 */

import { occupancyEnd } from './usage-rules.js';

const MINUTE_MS = 60_000;

/** Tolérance sur un début prévu déjà passé, à la création ou à la modification du début (D-137). */
export const RESERVATION_START_TOLERANCE_MINUTES = 15;

/** Bornes de réservation tronquées à la minute (D-137) : secondes et millisecondes ignorées. */
export function truncateToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

export interface SlotViolation {
  code: 'INTERVALLE_INVALIDE' | 'DEBUT_TROP_ANCIEN' | 'INTERVALLE_PASSE';
  field: 'startAt' | 'endAt';
  message: string;
}

/**
 * Contrôle d'un créneau [début, fin[ (bornes déjà tronquées) : fin après le début, début au plus
 * 15 minutes dans le passé (sauf début inchangé d'une réservation déjà commencée : checkStart false)
 * et fin future. Renvoie la première règle violée, ou null.
 */
export function slotViolation(startAt: Date, endAt: Date, now: Date, options: { checkStart: boolean }): SlotViolation | null {
  if (endAt.getTime() <= startAt.getTime()) return { code: 'INTERVALLE_INVALIDE', field: 'endAt', message: 'La fin prévue doit suivre le début.' };
  if (options.checkStart && startAt.getTime() < now.getTime() - RESERVATION_START_TOLERANCE_MINUTES * MINUTE_MS) {
    return { code: 'DEBUT_TROP_ANCIEN', field: 'startAt', message: `Le début prévu ne peut pas précéder l’heure actuelle de plus de ${RESERVATION_START_TOLERANCE_MINUTES} minutes.` };
  }
  if (endAt.getTime() <= now.getTime()) return { code: 'INTERVALLE_PASSE', field: 'endAt', message: 'La fin prévue doit être postérieure à l’heure actuelle.' };
  return null;
}

/** Ce qui reste modifiable d'une réservation CONFIRMEE : tout avant le début prévu, seulement la fin ensuite (D-137). */
export type ReservationEditScope = 'COMPLETE' | 'FIN_SEULEMENT';

export function reservationEditScope(startAt: Date, now: Date): ReservationEditScope {
  return startAt.getTime() <= now.getTime() ? 'FIN_SEULEMENT' : 'COMPLETE';
}

/** Premier instant du constat manuel de non-présentation : début prévu + délai de grâce (D-137). */
export function noShowAllowedFrom(startAt: Date, graceMinutes: number): Date {
  return new Date(startAt.getTime() + Math.max(0, graceMinutes) * MINUTE_MS);
}

export function canDeclareNoShow(startAt: Date, now: Date, graceMinutes: number): boolean {
  return now.getTime() >= noShowAllowedFrom(startAt, graceMinutes).getTime();
}

/** Créneau [début, fin[ ; fin null = sans fin connue (occupe tout l'avenir à partir du début). */
export interface Slot {
  start: Date;
  end: Date | null;
}

/** Chevauchement de deux créneaux semi-ouverts : deux créneaux consécutifs (fin = début) ne se chevauchent pas (4.5). */
export function slotsOverlap(a: Slot, b: Slot): boolean {
  const aEnd = a.end?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.end?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.start.getTime() < bEnd && b.start.getTime() < aEnd;
}

/**
 * Occupation d'une immobilisation ACTIVE (D-141) : [début, fin prévue[ ; une fin prévue déjà dépassée
 * s'étend jusqu'à maintenant (le véhicule reste immobilisé, même règle que l'occupation réelle d'une
 * utilisation, D-140 : occupancyEnd), une fin inconnue reste ouverte.
 */
export function immobilizationSlot(startedAt: Date, expectedEndAt: Date | null, now: Date): Slot {
  return { start: startedAt, end: expectedEndAt ? occupancyEnd(expectedEndAt, now) : null };
}

export interface InterventionTiming {
  status: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  startedAt: Date | null;
}

/**
 * Créneau d'une intervention au planning (10.2, D-205) : PLANIFIEE → [début prévu, fin prévue[ ;
 * EN_COURS → [début réel (à défaut prévu), fin prévue[. Une fin prévue absente ou déjà dépassée par le
 * début donne une fin inconnue. Les autres statuts (brouillon, terminée, annulée) n'occupent pas le planning.
 */
export function interventionSlot(i: InterventionTiming): Slot | null {
  let start: Date | null = null;
  if (i.status === 'PLANIFIEE') start = i.plannedStartAt;
  else if (i.status === 'EN_COURS') start = i.startedAt ?? i.plannedStartAt;
  if (!start) return null;
  const end = i.plannedEndAt && i.plannedEndAt.getTime() > start.getTime() ? i.plannedEndAt : null;
  return { start, end };
}

/** Intervention planifiée ou en cours dont la fin prévue est passée sans clôture. */
export function isInterventionLate(i: InterventionTiming, now: Date): boolean {
  return (i.status === 'PLANIFIEE' || i.status === 'EN_COURS') && i.plannedEndAt !== null && i.plannedEndAt.getTime() <= now.getTime();
}

/**
 * Avertissements du planning (D-205) : paires (intervention, réservation CONFIRMEE) du même véhicule
 * dont les créneaux se chevauchent. Informatif : rien n'est bloqué.
 */
export function interventionReservationOverlaps<I extends { vehicleId: string; slot: Slot }, R extends { vehicleId: string; status: string; slot: Slot }>(
  interventions: readonly I[],
  reservations: readonly R[],
): Array<{ intervention: I; reservation: R }> {
  const result: Array<{ intervention: I; reservation: R }> = [];
  for (const intervention of interventions) {
    for (const reservation of reservations) {
      if (reservation.status !== 'CONFIRMEE' || reservation.vehicleId !== intervention.vehicleId) continue;
      if (slotsOverlap(intervention.slot, reservation.slot)) result.push({ intervention, reservation });
    }
  }
  return result;
}
