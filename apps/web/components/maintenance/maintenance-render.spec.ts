import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaintenanceCalendar } from '@/app/(app)/entretiens/calendar-tab';
import { TemplateImpactTable } from '@/app/(app)/entretiens/template-impact-table';
import { OVERRIDE_LEGAL_NOTICE, OverrideLegalNotice } from '@/components/documents/override-notice';
import { installSummary } from '@/components/initial-catalog-button';
import { PlanStatusBadge, PlanWarnings } from '@/components/maintenance/plan-display';
import { expectedPlanVersions, type MaintenanceCalendarView, type TemplatePlanImpact } from '@/lib/maintenance-types';

// Rendu réel (serveur, sans navigateur) des vues d'entretien à partir de réponses de l'API : aucune valeur
// d'échéance ni de statut n'est calculée par la page (14.2), ni par le test.

/** Texte visible, espaces insécables (séparateurs fr-FR) normalisés. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ');
}

const CALENDAR: MaintenanceCalendarView = {
  month: '2026-10',
  from: '2026-10-01',
  to: '2026-10-31',
  timezone: 'Africa/Tunis',
  dueItems: [
    { planId: 'p-1', companyId: 'c', vehicleId: 'v-1', vehicleCode: 'V-CAL-1', maintenanceTypeLabel: 'Batterie', date: '2026-10-15', nextDueKm: null, status: 'A_PREVOIR' },
    // Échéance déjà passée par rapport au 15 : le statut affiché reste celui renvoyé par l'API.
    { planId: 'p-2', companyId: 'c', vehicleId: 'v-2', vehicleCode: 'V-CAL-2', maintenanceTypeLabel: 'Vidange moteur', date: '2026-10-02', nextDueKm: '95000', status: 'A_JOUR' },
  ],
  interventions: [{ id: 'i-1', reference: 'INT-2026-000042', companyId: 'c', vehicleId: 'v-1', vehicleCode: 'V-CAL-1', kind: 'PREVENTIF', date: '2026-10-14', plannedStartAt: '2026-10-14T07:00:00.000Z', plannedEndAt: null, tasks: ['Batterie'] }],
  overdueBeforeCount: 3,
  truncated: false,
};

describe('/entretiens — calendrier des échéances (CDC 10.2)', () => {
  it('affiche le mois, les échéances en date avec le statut de l’API et les interventions planifiées', () => {
    const html = renderToStaticMarkup(createElement(MaintenanceCalendar, { calendar: CALENDAR, timezone: 'Africa/Tunis', onOpenPlan: () => undefined, onShowOverdue: () => undefined }));
    const t = text(html);
    expect(t).toContain('Calendrier des échéances de octobre 2026');
    expect(t).toContain('V-CAL-1');
    expect(t).toContain('Batterie');
    expect(t).toContain('À prévoir');
    // Aucun recalcul : l'échéance du 02/10 reste « À jour » comme l'a renvoyé l'API.
    expect(html).toContain('Échéance Vidange moteur du véhicule V-CAL-2 : À jour');
    expect(html).toContain('href="/interventions/i-1"');
    expect(t).toContain('INT-2026-000042');
    expect(t).toContain('Préventive planifiée');
    expect(t).toContain('3 échéances en retard avant ce mois.');
    expect(t).toContain('Planifier une intervention ne vaut pas réalisation.');
    // Vue liste (petit écran) : jours occupés au format français.
    expect(t).toContain('02/10/2026');
    expect(t).toContain('ou 95 000 km');
  });

  it('mois sans élément : grille vide et message explicite, sans alerte de retard', () => {
    const html = renderToStaticMarkup(createElement(MaintenanceCalendar, { calendar: { ...CALENDAR, dueItems: [], interventions: [], overdueBeforeCount: 0 }, timezone: 'Africa/Tunis', onOpenPlan: () => undefined, onShowOverdue: () => undefined }));
    expect(text(html)).toContain('Aucune échéance en date ni intervention planifiée ce mois-ci.');
    expect(text(html)).not.toContain('en retard avant ce mois');
  });
});

describe('/entretiens — prévisualisation de l’application d’un modèle (CDC 6.1, 17.1)', () => {
  const impacts: TemplatePlanImpact[] = [
    {
      planId: 'p-1',
      vehicleId: 'v-1',
      vehicleCode: 'V-1',
      maintenanceTypeLabel: 'Vidange moteur',
      action: 'MISE_A_JOUR',
      planVersion: 3,
      before: { intervalKm: '10000', intervalMonths: null, intervalDays: null, noticeKm: '500', noticeDays: null, nextDueKm: '90000', nextDueDate: null, status: 'A_PREVOIR', remainingKm: '300', remainingDays: null },
      after: { intervalKm: '15000', intervalMonths: null, intervalDays: null, noticeKm: '800', noticeDays: null, nextDueKm: '95000', nextDueDate: null, status: 'A_JOUR', remainingKm: '5300', remainingDays: null },
    },
    {
      planId: null,
      vehicleId: 'v-2',
      vehicleCode: 'V-2',
      maintenanceTypeLabel: 'Batterie',
      action: 'CREATION',
      planVersion: null,
      before: null,
      after: { intervalKm: null, intervalMonths: 48, intervalDays: null, noticeKm: null, noticeDays: 30, nextDueKm: null, nextDueDate: null, status: 'INCOMPLET', remainingKm: null, remainingDays: null },
    },
  ];

  it('présente l’état avant/après calculé par le serveur pour chaque plan mis à jour, et les plans créés', () => {
    const t = text(renderToStaticMarkup(createElement(TemplateImpactTable, { impacts, timezone: 'Africa/Tunis' })));
    expect(t).toContain('Plans existants mis à jour (1)');
    expect(t).toContain('tous les 10 000 km');
    expect(t).toContain('tous les 15 000 km');
    expect(t).toContain('Échéance 90 000 km · reste 300 km');
    expect(t).toContain('Échéance 95 000 km · reste 5 300 km');
    expect(t).toContain('À prévoir');
    expect(t).toContain('À jour');
    expect(t).toContain('Nouveaux plans (1)');
    expect(t).toContain('V-2 · Batterie · tous les 48 mois');
    expect(t).toContain('Incomplet');
  });

  it('confirmation : renvoie exactement les plans mis à jour et leurs versions lues par l’aperçu (verrou optimiste)', () => {
    expect(expectedPlanVersions({ impacts })).toEqual([{ planId: 'p-1', version: 3 }]);
    expect(expectedPlanVersions({ impacts: impacts.filter((i) => i.action === 'CREATION') })).toEqual([]);
  });
});

describe('données manquantes ou anciennes affichées à part du statut (CDC 5.5, 6.2)', () => {
  it('un plan « À jour » selon un relevé ancien et un cumul incomplet : statut et avertissements rendus séparément', () => {
    const status = text(renderToStaticMarkup(createElement(PlanStatusBadge, { status: 'A_JOUR' })));
    const warnings = renderToStaticMarkup(createElement(PlanWarnings, { warnings: ['KILOMETRAGE_ANCIEN', 'CUMUL_INCOMPLET'] }));
    expect(status.trim()).toBe('À jour');
    expect(warnings).toContain('aria-label="Avertissements"');
    expect(text(warnings)).toContain('Kilométrage ancien : relevé à actualiser');
    expect(text(warnings)).toContain('Cumul incomplet : historique kilométrique antérieur inconnu');
    expect(text(renderToStaticMarkup(createElement(PlanWarnings, { warnings: ['KILOMETRAGE_INCONNU'] })))).toContain('Kilométrage inconnu : aucun relevé admissible');
    expect(renderToStaticMarkup(createElement(PlanWarnings, { warnings: [] }))).toBe('');
  });
});

describe('catalogue initial (CDC 6.1, 7.1) : message de résultat', () => {
  it('décomptes de l’API : ajoutés, et déjà présents non modifiés', () => {
    const item = { code: 'X', label: 'X' };
    expect(installSummary({ created: [item, item], skipped: [{ ...item, reason: 'CODE_EXISTANT' }] }, { singular: 'opération', plural: 'opérations', feminine: true })).toBe('2 opérations ajoutées ; 1 déjà présente, non modifiée.');
    expect(installSummary({ created: [], skipped: [{ ...item, reason: 'CODE_EXISTANT' }, { ...item, reason: 'LIBELLE_EXISTANT' }] }, { singular: 'type', plural: 'types', feminine: false })).toBe('Aucun type ajouté ; 2 déjà présents, non modifiés.');
    expect(installSummary({ created: [item], skipped: [] }, { singular: 'type', plural: 'types', feminine: false })).toBe('1 type ajouté.');
  });
});

describe('dérogation : mécanisme administratif, pas une autorisation juridique de circuler (CDC 7.2)', () => {
  it('la mention est rendue telle quelle', () => {
    const t = text(renderToStaticMarkup(createElement(OverrideLegalNotice, { id: 'x' })));
    expect(t).toContain('mécanisme administratif');
    expect(t).toContain('ne constitue pas une autorisation juridique de circuler');
    expect(OVERRIDE_LEGAL_NOTICE).toContain('ne modifie ni l’expiration du document ni la règle');
  });

  it('chaque écran où une dérogation est saisie ou restituée affiche la mention', () => {
    const root = resolve(import.meta.dirname, '../..');
    const screens = [
      'app/(app)/utilisations/nouvelle/checkout-form.tsx',
      'app/(app)/utilisations/[id]/usage-detail.tsx',
      'app/(app)/utilisations/[id]/fiche/usage-sheet.tsx',
      'app/(app)/planning/reservation-dialog.tsx',
      'app/(app)/planning/new-reservation-dialog.tsx',
    ];
    for (const file of screens) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(/<OverrideLegalNotice\b|\{OVERRIDE_LEGAL_NOTICE\}/.test(source), file).toBe(true);
    }
  });
});
