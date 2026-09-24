import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * /entretiens (CDC 10.2, 6.1, 17.1) : calendrier mensuel des échéances en date et des interventions planifiées,
 * et prévisualisation de l'impact avant d'appliquer un modèle en « mettre à jour ». Données posées par l'API
 * réelle sur E2E-VA2 (hors des véhicules des autres parcours) puis retirées : plan désactivé, intervention annulée.
 */

async function apiCall<T>(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

function monthName(month: string): RegExp {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new RegExp(`^${new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))}$`, 'i');
}

test.describe('Entretien : calendrier des échéances et prévisualisation d’un modèle (10.2, 17.1)', () => {
  test('le chef voit l’échéance en date et l’intervention planifiée dans le calendrier, prévisualise l’impact d’un modèle sans rien enregistrer, voit refuser un aperçu périmé puis confirme l’application', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, E2E.chefA);
    const vehicle = (await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/vehicles?q=E2E-VA2')).items.find((v) => v.code === 'E2E-VA2');
    expect(vehicle).toBeDefined();
    const vehicleId = (vehicle as { id: string }).id;
    const types = await apiCall<Array<{ id: string; label: string }>>(page, 'GET', '/maintenance-types');
    const battery = types.find((t) => t.label === 'Remplacement batterie');
    expect(battery).toBeDefined();

    // Échéance en date dans 45 jours (base il y a 4 ans, intervalle 48 mois) ; intervention planifiée dans 40 jours.
    const due = civilDate(45);
    const [dy, dm, dd] = due.split('-');
    const plan = await apiCall<{ id: string; nextDueDate: string; status: string; version: number }>(page, 'POST', '/maintenance-plans', {
      vehicleId,
      maintenanceTypeId: (battery as { id: string }).id,
      intervalMonths: 48,
      base: { baseMode: 'DERNIERE_OPERATION', baseDate: `${Number(dy) - 4}-${dm}-${dd}` },
    });
    expect(plan.nextDueDate).toBe(due);
    expect(plan.status).toBe('A_JOUR');
    const plannedDay = civilDate(40);
    const intervention = await apiCall<{ id: string; reference: string; version: number; status: string }>(page, 'POST', '/interventions', {
      vehicleId,
      kind: 'PREVENTIF',
      tasks: [{ planId: plan.id }],
      plannedStartAt: `${plannedDay}T08:00:00+01:00`,
    });
    expect(intervention.status).toBe('PLANIFIEE');

    try {
      // Calendrier : mois en cours par défaut, navigation au mois suivant.
      await page.goto('/entretiens');
      await page.getByRole('tab', { name: 'Calendrier' }).click();
      const currentMonth = civilDate(0).slice(0, 7);
      await expect(page.getByRole('heading', { level: 2, name: monthName(currentMonth) })).toBeVisible();
      await page.getByRole('button', { name: 'Mois suivant' }).click();
      const [cy, cm] = currentMonth.split('-').map(Number) as [number, number];
      const next = `${cm === 12 ? cy + 1 : cy}-${String(cm === 12 ? 1 : cm + 1).padStart(2, '0')}`;
      await expect(page).toHaveURL(new RegExp(`mois=${next}`));
      await expect(page.getByRole('heading', { level: 2, name: monthName(next) })).toBeVisible();

      // Mois de l'échéance : statut calculé par l'API (« À jour »), ouverture de la fiche du plan.
      await page.goto(`/entretiens?onglet=calendrier&mois=${due.slice(0, 7)}`);
      const dueItem = page.getByRole('button', { name: 'Échéance Remplacement batterie du véhicule E2E-VA2 : À jour' }).first();
      await expect(dueItem).toBeVisible();
      await dueItem.click();
      await expect(page.getByRole('dialog', { name: 'Remplacement batterie · E2E-VA2' })).toBeVisible();
      await page.keyboard.press('Escape');

      // Mois de l'intervention planifiée : lien vers sa fiche.
      await page.goto(`/entretiens?onglet=calendrier&mois=${plannedDay.slice(0, 7)}`);
      const link = page.getByRole('link', { name: new RegExp(intervention.reference) }).first();
      await expect(link).toBeVisible();
      await expect(link).toContainText('E2E-VA2 · Préventive planifiée');
      await link.click();
      await expect(page.getByRole('heading', { level: 1, name: `Intervention ${intervention.reference}` })).toBeVisible();

      // Modèle en « mettre à jour » : impact calculé par le serveur, présenté avant toute confirmation.
      await page.goto('/entretiens?onglet=modeles');
      const templateCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Entretien courant E2E' }) });
      await templateCard.getByRole('button', { name: 'Appliquer à des véhicules' }).click();
      const apply = page.getByRole('dialog', { name: 'Appliquer le modèle « Entretien courant E2E »' });
      await apply.getByLabel('Rechercher un véhicule').fill('E2E-VA2');
      await apply.getByRole('checkbox', { name: /^E2E-VA2 · 102 TU 2026/ }).click();
      await apply.getByRole('radio', { name: 'Mettre à jour ses intervalles et préavis (base conservée)' }).click();
      await apply.getByRole('button', { name: 'Prévisualiser l’impact' }).click();
      await expect(apply.getByText('Prévisualisation de l’impact — rien n’est encore enregistré')).toBeVisible();
      await expect(apply.getByText('Plans existants mis à jour (1)')).toBeVisible();
      const updated = apply.getByRole('row').filter({ hasText: 'Remplacement batterie' });
      await expect(updated).toContainText('E2E-VA2');
      await expect(updated).toContainText('tous les 48 mois');
      await expect(apply.getByText('Nouveaux plans (1)')).toBeVisible();
      await expect(apply.getByText(/E2E-VA2 · Vidange moteur/)).toBeVisible();
      await apply.getByRole('button', { name: 'Revenir à la sélection' }).click();
      await expect(apply.getByRole('button', { name: 'Prévisualiser l’impact' })).toBeVisible();
      await apply.getByRole('button', { name: 'Annuler' }).click();
      await expect(apply).toBeHidden();

      // Rien n'a été enregistré : un seul plan sur le véhicule, version inchangée.
      const plans = await apiCall<{ items: Array<{ id: string; version: number }> }>(page, 'GET', `/maintenance-plans?vehicleId=${vehicleId}`);
      expect(plans.items.map((p) => [p.id, p.version])).toEqual([[plan.id, plan.version]]);

      // Aperçu périmé : le plan présenté est modifié entre l'aperçu et la confirmation → refus, rien n'est appliqué.
      await templateCard.getByRole('button', { name: 'Appliquer à des véhicules' }).click();
      await apply.getByLabel('Rechercher un véhicule').fill('E2E-VA2');
      await apply.getByRole('checkbox', { name: /^E2E-VA2 · 102 TU 2026/ }).click();
      await apply.getByRole('radio', { name: 'Mettre à jour ses intervalles et préavis (base conservée)' }).click();
      await apply.getByRole('button', { name: 'Prévisualiser l’impact' }).click();
      await expect(apply.getByText('Plans existants mis à jour (1)')).toBeVisible();
      await apiCall(page, 'PATCH', `/maintenance-plans/${plan.id}`, { noticeDays: 20, reason: 'Préavis ajusté pendant l’aperçu', expectedVersion: plan.version });
      await apply.getByRole('button', { name: 'Confirmer l’application' }).click();
      await expect(apply.getByText(/Les plans concernés ont changé depuis la prévisualisation/)).toBeVisible();
      const afterRefusal = await apiCall<{ items: Array<{ id: string; version: number; noticeDays: number | null }> }>(page, 'GET', `/maintenance-plans?vehicleId=${vehicleId}`);
      expect(afterRefusal.items.map((p) => [p.id, p.version, p.noticeDays])).toEqual([[plan.id, plan.version + 1, 20]]);

      // Nouvel aperçu (préavis de 20 j avant), puis confirmation : appliquée telle que présentée.
      await apply.getByRole('button', { name: 'Prévisualiser l’impact' }).click();
      const updatedAgain = apply.getByRole('row').filter({ hasText: 'Remplacement batterie' });
      await expect(updatedAgain).toContainText('Préavis 20 j');
      await apply.getByRole('button', { name: 'Confirmer l’application' }).click();
      await expect(apply.getByText('Résultat par véhicule')).toBeVisible();
      const result = apply.getByRole('row').filter({ hasText: 'E2E-VA2' });
      await expect(result).toContainText('Vidange moteur');
      await expect(result).toContainText('Remplacement batterie');
      await apply.getByRole('button', { name: 'Terminer' }).click();
      await expect(apply).toBeHidden();
      const applied = await apiCall<{ items: Array<{ id: string; version: number; maintenanceTypeLabel: string }> }>(page, 'GET', `/maintenance-plans?vehicleId=${vehicleId}`);
      expect(applied.items.find((p) => p.id === plan.id)?.version).toBe(plan.version + 2);
      expect(applied.items.map((p) => p.maintenanceTypeLabel).sort()).toEqual(['Remplacement batterie', 'Vidange moteur']);
    } finally {
      // Nettoyage : l'intervention est annulée et le plan désactivé (motivés), sans effet sur les autres parcours.
      const current = await apiCall<{ version: number }>(page, 'GET', `/interventions/${intervention.id}`);
      await apiCall(page, 'POST', `/interventions/${intervention.id}/cancel`, { reason: 'Fin du parcours calendrier', expectedVersion: current.version });
      // Plans actifs du véhicule (celui du parcours et, si le modèle a été appliqué, la vidange créée) désactivés.
      const remaining = await apiCall<{ items: Array<{ id: string; version: number; active: boolean }> }>(page, 'GET', `/maintenance-plans?vehicleId=${vehicleId}`);
      for (const p of remaining.items.filter((x) => x.active)) {
        await apiCall(page, 'POST', `/maintenance-plans/${p.id}/deactivate`, { reason: 'Fin du parcours calendrier', expectedVersion: p.version });
      }
    }
  });
});
