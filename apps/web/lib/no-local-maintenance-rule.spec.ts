import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanDue, PlanDueDate, PlanDueKm, PlanStatusBadge } from '@/components/maintenance/plan-display';
import type { MaintenancePlanView } from '@/lib/maintenance-types';

/**
 * CDC 6.2 et 14.2 (R-6.2-13, R-14.2-03) : l'échéance et le statut d'entretien sont calculés une seule fois,
 * côté API (apps/api/src/domain/maintenance-schedule.ts) ; les pages affichent les valeurs renvoyées sans les
 * recalculer. Garde-fou sur toutes les sources de l'interface (écrans, composants, bibliothèques) : aucune
 * opération arithmétique, comparaison ou décalage de date sur les champs d'échéance, et aucun import de la
 * règle du backend ; puis rendu réel des composants d'affichage avec des valeurs volontairement incohérentes
 * avec toute formule locale.
 */
const root = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];
const FIELDS = '(intervalKm|intervalMonths|intervalDays|noticeKm|noticeDays|nextDueKm|nextDueDate|remainingKm|remainingDays|baseKm|baseDate|currentKm)';
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'opération arithmétique sur un champ d’échéance', pattern: new RegExp(`\\b${FIELDS}\\b\\)*\\s*[-+*/%]\\s*[\\w(]`) },
  { label: 'opération arithmétique sur un champ d’échéance', pattern: new RegExp(`[\\w)]\\s*[-+*/%]\\s*(Number\\(|new Decimal\\(|parseFloat\\(|parseInt\\()?[\\w.?]*\\b${FIELDS}\\b`) },
  { label: 'comparaison sur un champ d’échéance (statut recalculé)', pattern: new RegExp(`\\b${FIELDS}\\b\\)*\\s*(<=|>=|<|>)\\s*[\\w(]`) },
  { label: 'décalage de date par un intervalle', pattern: new RegExp(`(addMonths|addDays|setMonth|setDate|setUTCMonth|setUTCDate)\\([^)]*\\b${FIELDS}`) },
  { label: 'import de la règle d’échéance du backend', pattern: /maintenance-schedule|computeNextDue|computePlanStatus|@parc-auto\/api/ },
];

/** Littéraux de chaîne retirés (identifiants HTML « base.nextDueKm-error », libellés) avant l'analyse. */
function code(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`$]*`/g, '``');
}

function offences(text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    const stripped = code(line);
    for (const { label, pattern } of FORBIDDEN) if (pattern.test(stripped)) hits.push(`ligne ${index + 1} : ${label}`);
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('aucun recalcul d’échéance ni de statut d’entretien dans les pages (CDC 6.2, 14.2)', () => {
  it('le garde-fou détecte une formule locale (il n’est pas vide de sens)', () => {
    expect(offences('const next = Number(plan.baseKm) + Number(plan.intervalKm);')).not.toEqual([]);
    expect(offences('const late = plan.remainingKm < 0;')).not.toEqual([]);
    expect(offences('const due = addMonths(plan.baseDate, plan.intervalMonths);')).not.toEqual([]);
    expect(offences("import { computePlanStatus } from '../../api/src/domain/maintenance-schedule';")).not.toEqual([]);
    // Identifiants et libellés : ce ne sont pas des calculs.
    expect(offences('<Input aria-describedby="base.nextDueKm-error" id={`${idPrefix}-nextDueKm`} />')).toEqual([]);
  });

  it('aucun écran, composant ni bibliothèque du web ne calcule une échéance, un reste ou un statut', () => {
    const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d)));
    expect(files.length).toBeGreaterThan(100);
    // Les écrans qui affichent des échéances font bien partie de l'analyse (liste, fiche du plan, fiche véhicule, intervention, calendrier).
    const rel = files.map((f) => path.relative(root, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        'app/(app)/entretiens/plans-tab.tsx',
        'app/(app)/entretiens/plan-detail-sheet.tsx',
        'app/(app)/entretiens/calendar-tab.tsx',
        'app/(app)/vehicules/[id]/vehicle-detail.tsx',
        'app/(app)/interventions/form-parts.tsx',
        'components/maintenance/plan-display.tsx',
      ]),
    );
    const hits = files.flatMap((f) => offences(readFileSync(f, 'utf8')).map((h) => `${path.relative(root, f)} ${h}`));
    expect(hits).toEqual([]);
  });

  it('les composants d’affichage restituent les valeurs de l’API telles quelles, même incohérentes avec une formule', () => {
    // Base 80 000 + 10 000 donnerait 90 000 et un retard : l'API renvoie 95 000, un reste de -120 et « À jour » ; c'est ce qui s'affiche.
    const plan = { baseKm: '80000', intervalKm: '10000', nextDueKm: '95000', remainingKm: '-120', nextDueDate: '2026-10-02', remainingDays: 40, status: 'A_JOUR' } as unknown as MaintenancePlanView;
    const due = text(renderToStaticMarkup(createElement(PlanDue, { plan, timezone: 'Africa/Tunis' })));
    expect(due).toContain('95 000 km');
    expect(due).toContain('dépassée de 120 km');
    expect(due).toContain('02/10/2026');
    expect(due).toContain('dans 40 j');
    expect(text(renderToStaticMarkup(createElement(PlanDueKm, { plan })))).toBe('95 000 km dépassée de 120 km');
    expect(text(renderToStaticMarkup(createElement(PlanDueDate, { plan, timezone: 'Africa/Tunis' })))).toBe('02/10/2026 dans 40 j');
    expect(text(renderToStaticMarkup(createElement(PlanStatusBadge, { status: plan.status })))).toBe('À jour');
  });
});
