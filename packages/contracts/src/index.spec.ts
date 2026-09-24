import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PAGINATION, PERMISSIONS, ROLES, SETTING_DEFAULTS, SETTING_DESCRIPTORS, type SettingKey } from './index.js';

describe('Valeurs initiales du CDC 17.1', () => {
  it('reprennent exactement le tableau 17.1', () => {
    expect(SETTING_DEFAULTS['odometer.staleAfterDays']).toBe(7);
    expect(SETTING_DEFAULTS['maintenance.noticeKm']).toBe(500);
    expect(SETTING_DEFAULTS['maintenance.noticeDays']).toBe(30);
    expect(SETTING_DEFAULTS['documents.noticeDays']).toEqual([30, 15, 7]);
    expect(SETTING_DEFAULTS['usage.lateReturnToleranceMinutes']).toBe(0);
    expect(SETTING_DEFAULTS['alerts.catchUpIntervalMinutes']).toBe(15);
    expect(SETTING_DEFAULTS['email.dailyDigestLocalTime']).toBe('08:00');
    expect(SETTING_DEFAULTS['attachments.maxSizeBytes']).toBe(10 * 1024 * 1024);
    expect(SETTING_DEFAULTS['imports.maxSizeBytes']).toBe(5 * 1024 * 1024);
    expect(SETTING_DEFAULTS['imports.maxRows']).toBe(2000);
    expect(SETTING_DEFAULTS['pagination.defaultPageSize']).toBe(25);
    expect(SETTING_DEFAULTS['pagination.maxPageSize']).toBe(100);
    expect(PAGINATION).toEqual({ defaultPageSize: 25, maxPageSize: 100 });
    expect(SETTING_DEFAULTS['telemetry.syncIntervalMinutes']).toBe(15);
    expect(SETTING_DEFAULTS['telemetry.silentAfterHours']).toBe(24);
    expect(SETTING_DEFAULTS['telemetry.driftThresholdPercent']).toBe(3);
    expect(SETTING_DEFAULTS['telemetry.historizeEveryMinutes']).toBe(60);
    expect(SETTING_DEFAULTS['telemetry.fuelDropLiters']).toBe(10);
    expect(SETTING_DEFAULTS['telemetry.fuelDropPercent']).toBe(5);
    expect(SETTING_DEFAULTS['telemetry.fuelDropWindowMinutes']).toBe(30);
    expect(SETTING_DEFAULTS['telemetry.fuelSampleStepMinutes']).toBe(5);
    expect(SETTING_DEFAULTS['telemetry.fuelSampleRetentionDays']).toBe(90);
    expect(SETTING_DEFAULTS['session.ttlHours']).toBe(12);
  });

  it('chaque paramètre a un descripteur dont les bornes contiennent la valeur initiale', () => {
    for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
      const d = SETTING_DESCRIPTORS[key];
      expect(d, key).toBeDefined();
      const value = SETTING_DEFAULTS[key];
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (typeof v !== 'number') continue;
        if (d.min !== undefined) expect(v, key).toBeGreaterThanOrEqual(d.min);
        if (d.max !== undefined) expect(v, key).toBeLessThanOrEqual(d.max);
      }
    }
    // Synchronisation télématique : minimum 5 minutes (17.1).
    expect(SETTING_DESCRIPTORS['telemetry.syncIntervalMinutes'].min).toBe(5);
  });
});

describe('Permissions par défaut des rôles (CDC 2.2)', () => {
  it('seuls l’administrateur et le chef disposent des corrections et dérogations', () => {
    for (const role of ROLES) {
      const perms = DEFAULT_ROLE_PERMISSIONS[role];
      const privileged = role === 'ADMIN' || role === 'CHEF_PARC';
      expect(perms.includes('readings.correct'), role).toBe(privileged);
      expect(perms.includes('exceptions.override'), role).toBe(privileged);
    }
  });

  it('la gestion des utilisateurs reste à l’administrateur en V1', () => {
    for (const role of ROLES) expect(DEFAULT_ROLE_PERMISSIONS[role].includes('users.manage'), role).toBe(role === 'ADMIN');
  });

  it('le conducteur et le lecteur n’ont aucune permission fine par défaut ; les permissions sont connues', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.CONDUCTEUR).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.LECTEUR).toEqual([]);
    for (const role of ROLES) for (const p of DEFAULT_ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
