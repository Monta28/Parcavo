import { describe, expect, it } from 'vitest';
import {
  ALERT_TYPES,
  alertTypeVisibleToRole,
  checkSnoozeUntil,
  compareSeverity,
  isEscalationOrReactivation,
  isSnoozeActive,
  roleCanSnooze,
  severityAtLeast,
  visibleAlertTypes,
} from './alert-policy.js';
import { localDate } from './civil-date.js';

describe('politique du centre d’alertes (CDC 9.1, 9.2 — D-244, D-245, D-252)', () => {
  it('ordonne les gravités INFO < ATTENTION < URGENT < CRITIQUE', () => {
    expect(compareSeverity('CRITIQUE', 'URGENT')).toBeGreaterThan(0);
    expect(compareSeverity('INFO', 'ATTENTION')).toBeLessThan(0);
    expect(severityAtLeast('CRITIQUE', 'CRITIQUE')).toBe(true);
    expect(severityAtLeast('URGENT', 'CRITIQUE')).toBe(false);
    expect(severityAtLeast('URGENT', 'ATTENTION')).toBe(true);
  });

  it('visibilité par rôle : l’opérateur ne voit ni GPS ni carburant ; le conducteur ne voit rien', () => {
    expect(ALERT_TYPES).toHaveLength(20);
    expect(visibleAlertTypes('ADMIN')).toHaveLength(ALERT_TYPES.length);
    // D-248 : l'unité non mappée (libellé potentiellement nominatif, fournisseur partagé) reste à l'administrateur.
    for (const role of ['CHEF_PARC', 'LECTEUR'] as const) {
      expect(visibleAlertTypes(role)).toHaveLength(ALERT_TYPES.length - 1);
      expect(alertTypeVisibleToRole(role, 'GPS_UNITE_NON_MAPPEE')).toBe(false);
      expect(alertTypeVisibleToRole(role, 'GPS_SOURCE_MUETTE')).toBe(true);
    }
    expect(alertTypeVisibleToRole('ADMIN', 'GPS_UNITE_NON_MAPPEE')).toBe(true);
    expect(visibleAlertTypes('CONDUCTEUR')).toHaveLength(0);
    const operator = visibleAlertTypes('OPERATEUR');
    expect(operator).toContain('ENTRETIEN_ECHEANCE');
    expect(operator).toContain('RETOUR_DEPASSE');
    expect(operator.some((t) => t.startsWith('GPS_') || t.startsWith('CARBURANT_'))).toBe(false);
    expect(alertTypeVisibleToRole('OPERATEUR', 'CARBURANT_BAISSE_ANORMALE')).toBe(false);
    expect(alertTypeVisibleToRole('LECTEUR', 'CARBURANT_BAISSE_ANORMALE')).toBe(true);
  });

  it('le lecteur voit sans agir : seul un rôle opérationnel reporte une alerte', () => {
    expect(roleCanSnooze('ADMIN')).toBe(true);
    expect(roleCanSnooze('CHEF_PARC')).toBe(true);
    expect(roleCanSnooze('OPERATEUR')).toBe(true);
    expect(roleCanSnooze('LECTEUR')).toBe(false);
    expect(roleCanSnooze('CONDUCTEUR')).toBe(false);
  });

  it('report : date civile valide, strictement future, 90 jours au plus', () => {
    const today = '2026-09-24';
    expect(checkSnoozeUntil('2026-09-25', today)).toBeNull();
    expect(checkSnoozeUntil('2026-12-23', today)).toBeNull();
    expect(checkSnoozeUntil('2026-12-24', today)?.code).toBe('REPORT_TROP_LONG');
    expect(checkSnoozeUntil('2026-09-24', today)?.code).toBe('REPORT_DATE_NON_FUTURE');
    expect(checkSnoozeUntil('2026-09-01', today)?.code).toBe('REPORT_DATE_NON_FUTURE');
    expect(checkSnoozeUntil('2026-02-30', today)?.code).toBe('REPORT_DATE_INVALIDE');
    expect(checkSnoozeUntil('24/10/2026', today)?.code).toBe('REPORT_DATE_INVALIDE');
    expect(checkSnoozeUntil('2026-10-10', today, 7)?.code).toBe('REPORT_TROP_LONG');
  });

  it('un report reste actif jusqu’à la fin du jour local de sa date de fin (horloge contrôlée)', () => {
    const tz = 'Africa/Tunis';
    // 01/10 22:59 UTC = 01/10 23:59 à Tunis : report jusqu'au 01/10 encore actif.
    expect(isSnoozeActive('2026-10-01', localDate(new Date('2026-10-01T22:59:00Z'), tz))).toBe(true);
    // 01/10 23:00 UTC = 02/10 00:00 à Tunis : report échu.
    expect(isSnoozeActive('2026-10-01', localDate(new Date('2026-10-01T23:00:00Z'), tz))).toBe(false);
    expect(isSnoozeActive(null, '2026-09-24')).toBe(false);
  });

  it('seule une hausse de gravité ou une réactivation remet lecture et report à zéro', () => {
    expect(isEscalationOrReactivation({ severity: 'URGENT', active: true }, 'CRITIQUE')).toBe(true);
    expect(isEscalationOrReactivation({ severity: 'CRITIQUE', active: true }, 'CRITIQUE')).toBe(false);
    expect(isEscalationOrReactivation({ severity: 'CRITIQUE', active: true }, 'URGENT')).toBe(false);
    expect(isEscalationOrReactivation({ severity: 'CRITIQUE', active: false }, 'CRITIQUE')).toBe(true);
  });
});
