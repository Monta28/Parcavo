import type { AlertSeverity, AlertType, MembershipRole } from '@parc-auto/db';
import { assertCivilDate, compareCivil, diffDays, type CivilDate } from './civil-date.js';

/**
 * Règles du centre d'alertes (CDC 9.1, 9.2) — implémentation unique, sans accès aux données.
 *  - Gravités ordonnées INFO < ATTENTION < URGENT < CRITIQUE (D-245).
 *  - Visibilité par rôle (D-244) : administrateur, chef de parc et lecteur voient les types de leurs
 *    sociétés ; l'opérateur ne voit ni les alertes GPS_* ni CARBURANT_* ; le conducteur ne voit aucune alerte.
 *  - Unités télématiques non mappées (D-248) : réservées à l'administrateur, car le libellé d'une unité
 *    d'un fournisseur partagé peut nommer un conducteur d'une autre société.
 *  - « Lu » et « reporté » sont des états propres à chaque utilisateur, sans effet sur la résolution (9.2).
 *  - Report motivé (D-252) : date civile future, au plus 90 jours, valable jusqu'à la fin de ce jour local.
 */

export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { INFO: 0, ATTENTION: 1, URGENT: 2, CRITIQUE: 3 };

/** Gravités de la plus haute à la plus basse (ordre d'affichage). */
export const SEVERITIES_DESC: readonly AlertSeverity[] = ['CRITIQUE', 'URGENT', 'ATTENTION', 'INFO'];

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  INFO: 'Information',
  ATTENTION: 'Attention',
  URGENT: 'Urgent',
  CRITIQUE: 'Critique',
};

/** Libellés des types d'alertes (9.1) ; utilisés dans les e-mails à la place des messages libres (D-261). */
export const ALERT_TYPE_LABELS: Readonly<Record<AlertType, string>> = {
  ENTRETIEN_ECHEANCE: 'Échéance d’entretien',
  ENTRETIEN_PLAN_INCOMPLET: 'Plan d’entretien incomplet',
  DOCUMENT_MANQUANT: 'Document manquant',
  DOCUMENT_ECHEANCE: 'Échéance de document',
  KILOMETRAGE_ABSENT: 'Kilométrage absent',
  KILOMETRAGE_ANCIEN: 'Kilométrage ancien',
  RELEVE_A_VALIDER: 'Relevé à valider',
  RETOUR_DEPASSE: 'Retour dépassé',
  RESERVATION_COMPROMISE: 'Réservation compromise',
  INCIDENT_CRITIQUE: 'Incident critique non traité',
  DEPART_SANS_RELEVE: 'Départ sans relevé',
  DISTANCE_NON_VALIDEE: 'Distance non validée',
  IMMOBILISATION_PENDANT_UTILISATION: 'Immobilisation pendant une utilisation',
  GPS_SOURCE_MUETTE: 'Source GPS muette',
  GPS_DERIVE: 'Dérive GPS',
  GPS_UNITE_NON_MAPPEE: 'Unité télématique non mappée',
  GPS_SYNCHRO_EN_ECHEC: 'Synchronisation télématique en échec',
  CARBURANT_BAISSE_ANORMALE: 'Baisse anormale de carburant',
  CARBURANT_ECART_TICKET: 'Écart entre remplissage et ticket',
  CARBURANT_REMPLISSAGE_DETECTE: 'Remplissage détecté',
};

export const ALERT_TYPES: readonly AlertType[] = Object.keys(ALERT_TYPE_LABELS) as AlertType[];

/** Durée maximale d'un report (D-252 : alerts.maxSnoozeDays = 90). */
export const MAX_SNOOZE_DAYS = 90;

export function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function severityAtLeast(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

/** Types réservés à l'administrateur (D-248 : unité non mappée, libellé potentiellement nominatif). */
export const ADMIN_ONLY_ALERT_TYPES: readonly AlertType[] = ['GPS_UNITE_NON_MAPPEE'];

/** Types télématiques et carburant F11, masqués à l'opérateur (D-244). */
export function isTelemetryOrFuelAlert(type: AlertType): boolean {
  return type.startsWith('GPS_') || type.startsWith('CARBURANT_');
}

/** Un rôle détenu sur la société de l'alerte permet-il de la voir (D-244) ? */
export function alertTypeVisibleToRole(role: MembershipRole, type: AlertType): boolean {
  switch (role) {
    case 'ADMIN':
      return true;
    case 'CHEF_PARC':
    case 'LECTEUR':
      return !ADMIN_ONLY_ALERT_TYPES.includes(type);
    case 'OPERATEUR':
      return !isTelemetryOrFuelAlert(type) && !ADMIN_ONLY_ALERT_TYPES.includes(type);
    case 'CONDUCTEUR':
      return false;
  }
}

/** Types visibles pour un rôle (tous, une partie, ou aucun). */
export function visibleAlertTypes(role: MembershipRole): readonly AlertType[] {
  return ALERT_TYPES.filter((t) => alertTypeVisibleToRole(role, t));
}

/** Le report motivé est une décision de gestion : le lecteur voit sans agir (D-244). */
export function roleCanSnooze(role: MembershipRole): boolean {
  return role === 'ADMIN' || role === 'CHEF_PARC' || role === 'OPERATEUR';
}

export interface SnoozeRejection {
  code: 'REPORT_DATE_INVALIDE' | 'REPORT_DATE_NON_FUTURE' | 'REPORT_TROP_LONG';
  message: string;
}

/**
 * Contrôle de la date de fin d'un report (D-252) : date civile valide, strictement postérieure au jour
 * local courant, au plus `maxDays` jours plus tard. Renvoie null si la date est acceptable.
 */
export function checkSnoozeUntil(until: string, today: CivilDate, maxDays: number = MAX_SNOOZE_DAYS): SnoozeRejection | null {
  try {
    assertCivilDate(until);
  } catch {
    return { code: 'REPORT_DATE_INVALIDE', message: 'Date de fin de report invalide (format AAAA-MM-JJ attendu).' };
  }
  if (compareCivil(until, today) <= 0) {
    return { code: 'REPORT_DATE_NON_FUTURE', message: 'La date de fin de report doit être postérieure à aujourd’hui.' };
  }
  if (diffDays(today, until) > maxDays) {
    return { code: 'REPORT_TROP_LONG', message: `Un report ne peut pas dépasser ${maxDays} jours.` };
  }
  return null;
}

/** Un report est actif jusqu'à la fin du jour local de sa date de fin (D-252). */
export function isSnoozeActive(snoozedUntil: CivilDate | null, today: CivilDate): boolean {
  return snoozedUntil !== null && compareCivil(snoozedUntil, today) >= 0;
}

/**
 * Escalade d'une même occurrence (9.2) : hausse de gravité ou réactivation d'une alerte résolue. Elle
 * déclenche la notification immédiate et annule reports et lectures de tous les destinataires (D-252).
 */
export function isEscalationOrReactivation(previous: { severity: AlertSeverity; active: boolean }, next: AlertSeverity): boolean {
  return !previous.active || SEVERITY_RANK[next] > SEVERITY_RANK[previous.severity];
}
