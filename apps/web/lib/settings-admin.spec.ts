import { SETTING_DEFAULTS, SETTING_DESCRIPTORS, type SettingKey } from '@parc-auto/contracts';
import { describe, expect, it } from 'vitest';
import {
  boundsHint,
  expectedVersionFor,
  formatSettingValue,
  groupSettings,
  historyForScope,
  inputToSettingValue,
  matchesSearch,
  settingToInput,
  type SettingVersion,
} from './settings-admin';

describe('Paramètres (CDC 17.1) : affichage et saisie', () => {
  it('affiche les valeurs en clair, avec unités, listes et oui/non', () => {
    expect(formatSettingValue('odometer.staleAfterDays', 7)).toBe('7 jours');
    expect(formatSettingValue('documents.noticeDays', [30, 15, 7])).toBe('30, 15, 7 jours');
    expect(formatSettingValue('expenses.vehiclePurchaseExcludedByDefault', true)).toBe('Oui');
    expect(formatSettingValue('email.dailyDigestLocalTime', '08:00')).toBe('08:00');
    expect(formatSettingValue('usage.checklistItems', ['Clés', 'Cric'])).toBe('Clés · Cric');
    expect(formatSettingValue('attachments.maxSizeBytes', 10 * 1024 * 1024).replace(/\s/g, ' ')).toBe('10 485 760 octets (10 Mo)');
    expect(formatSettingValue('fuel.amountToleranceRatio', 0.01).replace(/\s/g, ' ')).toBe('0,01 ratio (1 %)');
  });

  it('convertit la saisie sans la valider : le serveur reçoit le texte non numérique et répond avec son message', () => {
    expect(inputToSettingValue('odometer.staleAfterDays', ' 14 ')).toBe(14);
    expect(inputToSettingValue('telemetry.driftThresholdPercent', '2,5')).toBe(2.5);
    expect(inputToSettingValue('odometer.staleAfterDays', 'dix')).toBe('dix');
    expect(inputToSettingValue('odometer.staleAfterDays', '')).toBe('');
    expect(inputToSettingValue('documents.noticeDays', '30, 15; 7')).toEqual([30, 15, 7]);
    expect(inputToSettingValue('documents.noticeDays', '30, x')).toEqual([30, 'x']);
    expect(inputToSettingValue('usage.checklistItems', 'Clés\n\n  Cric  \n')).toEqual(['Clés', 'Cric']);
    expect(inputToSettingValue('expenses.vehiclePurchaseExcludedByDefault', 'false')).toBe(false);
    expect(inputToSettingValue('email.dailyDigestLocalTime', '07:30')).toBe('07:30');
  });

  it('pré-remplit le champ avec la valeur actuelle, dans le format de saisie', () => {
    for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
      const value = SETTING_DEFAULTS[key];
      expect(inputToSettingValue(key, settingToInput(key, value)), key).toEqual(Array.isArray(value) ? [...value] : value);
    }
  });

  it('indique les bornes du descripteur partagé avec l’API', () => {
    expect(boundsHint('odometer.staleAfterDays')).toBe('Nombre entier de 1 à 365 jours.');
    expect(boundsHint('documents.noticeDays')).toContain('De 1 à 10 entiers');
    expect(boundsHint('email.dailyDigestLocalTime')).toBe('Heure locale au format HH:MM.');
    expect(boundsHint('fuel.amountToleranceTnd')).toBe('Nombre (décimales avec une virgule ou un point, 3 décimales au plus) de 0 à 100 TND.');
    expect(boundsHint('inconnu')).toBeNull();
  });

  it('version attendue du verrou optimiste : celle du niveau modifié, 0 quand ce niveau n’a pas de valeur', () => {
    expect(expectedVersionFor({ source: 'groupe', settingVersion: 3 }, null)).toBe(3);
    expect(expectedVersionFor({ source: 'defaut', settingVersion: null }, null)).toBe(0);
    expect(expectedVersionFor({ source: 'societe', settingVersion: 2 }, 'c1')).toBe(2);
    // Vue société sans surcharge : la valeur affichée est celle du groupe, la surcharge n'existe pas encore.
    expect(expectedVersionFor({ source: 'groupe', settingVersion: 5 }, 'c1')).toBe(0);
  });

  it('regroupe par rubrique, recherche sans accents, historique du niveau affiché', () => {
    const all = (Object.keys(SETTING_DESCRIPTORS) as SettingKey[]).map((key) => ({ key, label: SETTING_DESCRIPTORS[key].label }));
    const groups = groupSettings(all);
    expect(groups.flatMap((g) => g.items)).toHaveLength(all.length);
    expect(groups.map((g) => g.label)).not.toContain('Autres');
    expect(groups[0]?.label).toBe('Kilométrage');
    expect(all.filter((s) => matchesSearch(s, 'kilometrage')).map((s) => s.key)).toContain('odometer.staleAfterDays');
    expect(all.filter((s) => matchesSearch(s, 'session')).map((s) => s.key)).toEqual(['session.ttlHours']);

    const row = (companyId: string | null, settingVersion: number): SettingVersion => ({ companyId, settingVersion, value: 1, isCurrent: false, reason: 'motif', createdAt: '2026-09-24T10:00:00.000Z', createdById: null, createdByName: null });
    const rows = [row(null, 1), row('a', 1), row('b', 1)];
    expect(historyForScope(rows, null)).toHaveLength(3);
    expect(historyForScope(rows, 'a').map((r) => r.companyId)).toEqual([null, 'a']);
  });
});
