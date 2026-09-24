/**
 * Règles pures des utilisations (CDC 4.2, 4.3, 4.5 ; D-135, D-140, D-142) : retard au retour d'une
 * utilisation ouverte (vue, filtre de liste, planning et alerte RETOUR_DEPASSE), occupation réelle et
 * fenêtre de conversion d'une réservation à la remise. Le retard lui-même est défini une seule fois,
 * par returnDelay (domain/return-delay.ts, aussi utilisé par les rapports) ; lateReturnCutoff en est la
 * traduction en borne SQL, dont l'équivalence est vérifiée par les tests unitaires.
 */

import { returnDelay } from './return-delay.js';

const MINUTE_MS = 60_000;

/**
 * Borne de retard : une utilisation EN_COURS dont le retour prévu est strictement antérieur à cette
 * borne est en retard. Le filtre de liste en dérive sa condition SQL (expectedReturnAt < borne).
 */
export function lateReturnCutoff(now: Date, toleranceMinutes: number): Date {
  return new Date(now.getTime() - Math.max(0, toleranceMinutes) * MINUTE_MS);
}

/** Retour dépassé : utilisation encore EN_COURS dont le retour prévu, tolérance comprise, est passé (returnDelay). */
export function isReturnLate(usage: { status: string; expectedReturnAt: Date }, now: Date, toleranceMinutes: number): boolean {
  return usage.status === 'EN_COURS' && returnDelay({ expectedReturnAt: usage.expectedReturnAt, returnedAt: null, now, toleranceMinutes }).late;
}

/**
 * Fin de l'occupation réelle d'une utilisation ouverte (D-140) : [checkedOutAt, max(retour prévu, maintenant)[.
 * Une utilisation en retard continue d'occuper le véhicule et le conducteur.
 */
export function occupancyEnd(expectedReturnAt: Date, now: Date): Date {
  return new Date(Math.max(expectedReturnAt.getTime(), now.getTime()));
}

/** Fenêtre de conversion (D-140) : [startAt − avance (reservations.conversionEarlyMinutes), endAt[. */
export function conversionWindow(reservation: { startAt: Date; endAt: Date }, earlyMinutes: number): { opensAt: Date; closesAt: Date } {
  return { opensAt: new Date(reservation.startAt.getTime() - Math.max(0, earlyMinutes) * MINUTE_MS), closesAt: reservation.endAt };
}

/** Le même couple part dans la fenêtre de conversion de la réservation (borne haute exclue). */
export function isInConversionWindow(reservation: { startAt: Date; endAt: Date }, checkedOutAt: Date, earlyMinutes: number): boolean {
  const { opensAt, closesAt } = conversionWindow(reservation, earlyMinutes);
  return opensAt.getTime() <= checkedOutAt.getTime() && checkedOutAt.getTime() < closesAt.getTime();
}

/**
 * Réservation du même couple (véhicule, conducteur) convertie par une remise sans identifiant explicite
 * (D-142) : parmi les réservations dont la fenêtre contient le départ, celle dont le créneau est déjà
 * commencé, sinon celle qui commence le plus tôt. Aucune si le départ est hors de toute fenêtre.
 */
export function pickReservationToConvert<T extends { id: string; startAt: Date; endAt: Date }>(candidates: readonly T[], checkedOutAt: Date, earlyMinutes: number): T | null {
  const eligible = candidates.filter((r) => isInConversionWindow(r, checkedOutAt, earlyMinutes)).sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id));
  return eligible.find((r) => r.startAt.getTime() <= checkedOutAt.getTime()) ?? eligible[0] ?? null;
}

/** Motif pour lequel le relevé de retour d'une utilisation ne peut pas être régularisé (CDC 4.4). */
export type ReturnRegularizationBlock = 'NON_RESTITUEE' | 'DEPART_SANS_RELEVE' | 'DEJA_VALIDEE' | 'RELEVE_EN_ATTENTE';

/**
 * Régularisation du relevé de retour (CDC 4.4 : « distance non validée jusqu'à régularisation ») : possible
 * pour une utilisation restituée dont le départ a un relevé accepté et dont le retour n'a aucun relevé
 * (constat sans relevé) ou un relevé rejeté. Un relevé de retour en attente se traite dans la file de
 * validation ; un départ sans relevé laisse la distance indéterminée (aucun relevé de retour ne la valide).
 * Renvoie null si la régularisation est possible, sinon le motif du refus.
 */
export function returnRegularizationBlock(usage: {
  status: string;
  checkoutWithoutReading: boolean;
  checkoutReadingStatus: string | null;
  returnReadingStatus: string | null;
}): ReturnRegularizationBlock | null {
  if (usage.status !== 'TERMINEE') return 'NON_RESTITUEE';
  if (usage.checkoutWithoutReading || usage.checkoutReadingStatus !== 'ACCEPTE') return 'DEPART_SANS_RELEVE';
  if (usage.returnReadingStatus === 'ACCEPTE') return 'DEJA_VALIDEE';
  if (usage.returnReadingStatus === 'EN_ATTENTE') return 'RELEVE_EN_ATTENTE';
  return null;
}

/**
 * Période d'observation admise pour le relevé qui régularise un retour : de l'instant du retour à la remise
 * suivante du véhicule (incluse : le véhicule n'a pas roulé entre-temps), jamais dans le futur.
 */
export function isInReturnRegularizationWindow(observedAt: Date, returnedAt: Date, nextCheckoutAt: Date | null, now: Date): boolean {
  const t = observedAt.getTime();
  if (t < returnedAt.getTime() || t > now.getTime()) return false;
  return nextCheckoutAt === null || t <= nextCheckoutAt.getTime();
}
