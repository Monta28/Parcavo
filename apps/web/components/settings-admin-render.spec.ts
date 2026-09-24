import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsTable } from '@/app/(app)/administration/parametres/settings-table';
import { groupSettings, type EffectiveSetting } from '@/lib/settings-admin';

// Rendu réel (serveur) du tableau des paramètres à partir de réponses de GET /settings : origine, version,
// valeur fixe non modifiable et actions proposées selon le niveau affiché.

const noop = () => undefined;

function setting(overrides: Partial<EffectiveSetting> & Pick<EffectiveSetting, 'key' | 'label' | 'value'>): EffectiveSetting {
  return { unit: null, source: 'defaut', settingVersion: null, companyOverride: true, editable: true, ...overrides };
}

const GROUP_VIEW: EffectiveSetting[] = [
  setting({ key: 'odometer.staleAfterDays', label: 'Kilométrage ancien après', unit: 'jours', value: 10, source: 'groupe', settingVersion: 2 }),
  setting({ key: 'alerts.catchUpIntervalMinutes', label: 'Rattrapage des alertes', unit: 'minutes', value: 15, companyOverride: false }),
  setting({ key: 'pagination.maxPageSize', label: 'Pagination maximale', unit: 'lignes', value: 100, companyOverride: false, editable: false }),
  setting({ key: 'session.ttlHours', label: 'Durée de session (appliquée aux nouvelles connexions)', unit: 'heures', value: 12, companyOverride: false }),
];

function render(settings: EffectiveSetting[], companyId: string | null): string {
  return renderToStaticMarkup(createElement(SettingsTable, { groups: groupSettings(settings), companyId, companyLabel: companyId ? 'A — Société A' : null, onEdit: noop, onHistory: noop, onClearOverride: noop }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('Administration › Paramètres : tableau des valeurs effectives', () => {
  it('vue groupe : rubriques, origine et version, actions de modification et d’historique ; la pagination est une valeur fixe non modifiable', () => {
    const html = render(GROUP_VIEW, null);
    const t = text(html);
    expect(t).toContain('Kilométrage');
    expect(t).toContain('Listes et API');
    expect(t).toContain('Sécurité');
    expect(t).toContain('Kilométrage ancien après');
    expect(t).toContain('10 jours');
    expect(t).toContain('Valeur groupe version 2');
    expect(t).toContain('Défaut du produit');
    expect(html).toContain('aria-label="Modifier « Kilométrage ancien après »"');
    expect(html).toContain('aria-label="Modifier « Durée de session (appliquée aux nouvelles connexions) »"');
    expect(html).toContain('aria-label="Historique de « Kilométrage ancien après »"');
    // Valeur fixe : ni modification ni historique, explication issue du descripteur partagé avec l'API.
    expect(html).not.toContain('Modifier « Pagination maximale »');
    expect(t).toContain('Valeur fixe');
    expect(t).toContain('Non modifiable');
    expect(t).toContain('Borne du contrat de l’API (CDC 15.1)');
    // Aucune surcharge à retirer au niveau groupe.
    expect(t).not.toContain('Retirer la surcharge');
  });

  it('vue société : surcharge proposée seulement pour les paramètres qui l’autorisent, retrait d’une surcharge en vigueur', () => {
    const companyView: EffectiveSetting[] = [
      setting({ key: 'odometer.staleAfterDays', label: 'Kilométrage ancien après', unit: 'jours', value: 3, source: 'societe', settingVersion: 1 }),
      setting({ key: 'maintenance.noticeKm', label: 'Préavis entretien par défaut (distance)', unit: 'km', value: 500 }),
      setting({ key: 'alerts.catchUpIntervalMinutes', label: 'Rattrapage des alertes', unit: 'minutes', value: 15, companyOverride: false }),
    ];
    const html = render(companyView, 'c-a');
    const t = text(html);
    expect(t).toContain('Valeur pour A — Société A');
    expect(t).toContain('Surcharge société version 1');
    expect(html).toContain('aria-label="Retirer la surcharge de « Kilométrage ancien après »"');
    // Sans surcharge : action « Surcharger » ; paramètre groupe seul : ni modification ni retrait.
    expect(html).toContain('aria-label="Surcharger « Préavis entretien par défaut (distance) »"');
    expect(html).toContain('aria-label="Modifier « Kilométrage ancien après »"');
    expect(html).not.toMatch(/(Modifier|Surcharger) « Rattrapage des alertes »/);
    expect(t).toContain('Valeur groupe uniquement : ce paramètre ne se surcharge pas par société.');
    expect(html.match(/Retirer la surcharge de/g)).toHaveLength(1);
  });
});
