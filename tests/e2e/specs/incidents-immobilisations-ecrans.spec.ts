import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { openVehicle } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Écrans /incidents et /immobilisations côté personnel (CDC 7.3, 7.4, 10.2) : déclaration d'un incident depuis
 * /incidents, suivi du garage (intervention corrective ouverte depuis l'incident, garage de la société),
 * déclaration d'une immobilisation depuis /immobilisations (cause « incident », au garage), puis remise en
 * disponibilité par l'action dédiée de fin d'immobilisation. Véhicule E2E-VA1 (seuls des contrôles de
 * visibilité l'utilisent ailleurs) ; l'intervention et l'incident sont clos en fin de parcours par l'API réelle.
 * Puis relevé ancien (CDC 5.5, 6.2, T12) sur E2E-VB1 : plan « À jour » selon ce relevé, avertissement « Kilométrage
 * ancien » affiché à part du statut (liste, fiche du plan) et fraîcheur « À actualiser » sur la fiche véhicule.
 */

async function apiCall<T>(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function pickVehicle(page: Page, label: string, code: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('combobox', { name: 'Rechercher un véhicule' }).fill(code);
  await page.getByRole('option', { name: new RegExp(`^${code} · `) }).click();
  await expect(page.getByRole('combobox', { name: label })).toContainText(code);
}

test.describe('Incidents et immobilisations : déclaration, suivi du garage, remise en disponibilité (7.3, 7.4, 10.2)', () => {
  test('le chef déclare un incident depuis /incidents, ouvre l’intervention au garage, immobilise depuis /immobilisations puis remet le véhicule en disponibilité', async ({ page }) => {
    test.setTimeout(180_000);
    await loginAs(page, E2E.chefA);
    let incidentId: string | null = null;
    let interventionId: string | null = null;

    try {
      // 1. Déclaration depuis /incidents : contrôles du formulaire, puis dossier créé « Ouvert ».
      await page.goto('/incidents');
      await page.getByRole('link', { name: 'Déclarer un incident' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Déclarer un incident' })).toBeVisible();
      await page.getByRole('button', { name: 'Déclarer l’incident' }).click();
      await expect(page.getByText('Choisissez le véhicule.')).toBeVisible();
      await pickVehicle(page, 'Véhicule *', 'E2E-VA1');
      await page.getByRole('combobox', { name: 'Type *' }).click();
      await page.getByRole('option', { name: 'Dommage', exact: true }).click();
      await page.getByLabel('Lieu (texte libre)').fill('Parking du siège, niveau -1');
      await page.getByLabel('Description *').fill('Portière arrière gauche enfoncée, fermeture difficile');
      await page.getByRole('combobox', { name: 'Responsable du suivi' }).click();
      await page.getByRole('option', { name: /Chaima Chef/ }).click();
      await page.getByRole('button', { name: 'Déclarer l’incident' }).click();
      const heading = page.getByRole('heading', { level: 1, name: /^Incident INC-\d{4}-\d{6}$/ });
      await expect(heading).toBeVisible();
      const reference = ((await heading.textContent()) ?? '').replace('Incident ', '').trim();
      incidentId = new URL(page.url()).pathname.split('/').pop() ?? null;
      const main = page.getByRole('main');
      await expect(main.getByText('Ouvert', { exact: true })).toBeVisible();
      await expect(main).toContainText('Parking du siège, niveau -1');
      await expect(main).toContainText('Portière arrière gauche enfoncée, fermeture difficile');
      await expect(main).toContainText('Chaima Chef');
      await expect(main).toContainText('Aucune intervention ouverte depuis cet incident.');

      // Retrouvé dans la liste /incidents par sa référence.
      await page.goto('/incidents');
      await page.getByLabel('Recherche').fill(reference);
      await expect(page).toHaveURL(new RegExp(`q=${reference}`));
      const listed = page.getByRole('row').filter({ hasText: reference });
      await expect(listed).toContainText('E2E-VA1');
      await expect(listed).toContainText('Ouvert');
      await listed.getByRole('link', { name: reference }).click();
      await expect(heading).toBeVisible();

      // 2. Suivi du garage : intervention corrective ouverte depuis l'incident, chez le garage de la société.
      await page.getByRole('button', { name: 'Ouvrir une intervention' }).click();
      const open = page.getByRole('dialog', { name: 'Ouvrir une intervention' });
      await expect(open.getByRole('radio', { name: 'Corrective (réparation)' })).toBeChecked();
      await open.getByRole('combobox', { name: 'Garage' }).click();
      await page.getByRole('option', { name: 'Lafayette Auto Services E2E', exact: true }).click();
      await open.getByLabel('Diagnostic').fill('Devis carrosserie demandé');
      await open.getByRole('button', { name: 'Ouvrir l’intervention' }).click();
      const interventionHeading = page.getByRole('heading', { level: 1, name: /^Intervention INT-\d{4}-\d{6}$/ });
      await expect(interventionHeading).toBeVisible();
      const interventionRef = ((await interventionHeading.textContent()) ?? '').replace('Intervention ', '').trim();
      interventionId = new URL(page.url()).pathname.split('/').pop() ?? null;
      await expect(page.getByRole('main')).toContainText('Lafayette Auto Services E2E');
      await page.goto(`/incidents/${incidentId}`);
      await expect(main.getByRole('link', { name: `Intervention ${interventionRef}` })).toBeVisible();
      await expect(main).toContainText('Aucune immobilisation liée à cet incident.');

      // 3. Déclaration d'une immobilisation depuis /immobilisations : cause « incident », au garage.
      await page.goto('/immobilisations');
      await page.getByRole('button', { name: 'Immobiliser un véhicule' }).click();
      const immobilize = page.getByRole('dialog', { name: 'Immobiliser un véhicule' });
      await immobilize.getByRole('button', { name: 'Immobiliser' }).click();
      await expect(immobilize.getByText('Choisissez le véhicule.')).toBeVisible();
      await expect(immobilize.getByText('Indiquez le motif (3 caractères au moins).')).toBeVisible();
      await pickVehicle(page, 'Véhicule *', 'E2E-VA1');
      await immobilize.getByLabel('Motif *').fill('Réparation carrosserie au garage');
      await immobilize.getByRole('radio', { name: 'Incident du véhicule' }).click();
      await immobilize.getByRole('combobox', { name: 'Incident *' }).click();
      await page.getByRole('option', { name: `${reference} · Dommage` }).click();
      await immobilize.getByRole('radio', { name: 'Garage (fournisseur)' }).click();
      await immobilize.getByRole('combobox', { name: 'Garage *' }).click();
      await page.getByRole('option', { name: 'Lafayette Auto Services E2E · Garage' }).click();
      await immobilize.getByRole('button', { name: 'Immobiliser' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Immobilisation E2E-VA1' })).toBeVisible();
      const immobilizationUrl = page.url();
      await expect(main.getByText('Active', { exact: true })).toBeVisible();
      await expect(main.getByText('1 cause ouverte', { exact: true })).toBeVisible();
      await expect(main).toContainText('Garage Lafayette Auto Services E2E');
      const cause = main.getByRole('row').filter({ hasText: 'Réparation carrosserie au garage' }).first();
      await expect(cause).toContainText('Ouverte');
      await expect(cause).toContainText(reference);

      // Le véhicule est indisponible ; la liste /immobilisations et l'incident montrent l'immobilisation active.
      await openVehicle(page, 'E2E-VA1');
      await expect(main.getByText('Immobilisé', { exact: true }).first()).toBeVisible();
      await page.goto('/immobilisations');
      const row = page.getByRole('row').filter({ hasText: 'E2E-VA1' }).first();
      await expect(row).toContainText('Active');
      await expect(row).toContainText('Lafayette Auto Services E2E');
      await page.goto(`/incidents/${incidentId}`);
      await expect(main.getByText('Cause en cours', { exact: true })).toBeVisible();

      // 4. Remise en disponibilité par l'action dédiée « Fin d’immobilisation » (motif obligatoire).
      await page.goto(immobilizationUrl);
      await page.getByRole('button', { name: 'Fin d’immobilisation' }).click();
      const end = page.getByRole('dialog', { name: 'Fin d’immobilisation' });
      await end.getByRole('button', { name: 'Terminer l’immobilisation' }).click();
      await expect(end.getByText('Indiquez le motif (3 caractères au moins).')).toBeVisible();
      await end.getByLabel('Motif *').fill('Carrosserie réparée, véhicule récupéré');
      await end.getByRole('button', { name: 'Terminer l’immobilisation' }).click();
      await expect(end).toBeHidden();
      await expect(page.getByText('Immobilisation terminée : E2E-VA1 est remis en disponibilité.')).toBeVisible();
      await expect(main.getByText('Terminée', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Fin d’immobilisation' })).toHaveCount(0);
      await openVehicle(page, 'E2E-VA1');
      await expect(main.getByText('Disponible', { exact: true }).first()).toBeVisible();
      await page.goto(`/incidents/${incidentId}`);
      await expect(main.getByText(/^Cause terminée le /)).toBeVisible();
    } finally {
      // Nettoyage par l'API réelle : intervention annulée, incident résolu puis clôturé (motifs explicites).
      if (interventionId) {
        const current = await apiCall<{ version: number; status: string }>(page, 'GET', `/interventions/${interventionId}`);
        if (current.status !== 'ANNULEE' && current.status !== 'TERMINEE') await apiCall(page, 'POST', `/interventions/${interventionId}/cancel`, { reason: 'Fin du parcours incidents', expectedVersion: current.version });
      }
      if (incidentId) {
        let incident = await apiCall<{ version: number; status: string }>(page, 'GET', `/incidents/${incidentId}`);
        if (incident.status === 'OUVERT' || incident.status === 'EN_TRAITEMENT') {
          incident = await apiCall(page, 'POST', `/incidents/${incidentId}/transition`, { to: 'RESOLU', note: 'Fin du parcours incidents', expectedVersion: incident.version });
        }
        if (incident.status === 'RESOLU') await apiCall(page, 'POST', `/incidents/${incidentId}/transition`, { to: 'CLOTURE', expectedVersion: incident.version });
      }
    }
  });
});

test.describe('Entretien : données anciennes affichées à part du statut (5.5, 6.2, T12)', () => {
  test('relevé ancien (5.5, 6.2, T12) : le plan kilométrique « À jour » porte l’avertissement « Kilométrage ancien », affiché à part du statut dans la liste et la fiche', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, E2E.admin);
    const vehicle = (await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/vehicles?q=E2E-VB1')).items.find((v) => v.code === 'E2E-VB1');
    expect(vehicle).toBeDefined();
    const vehicleId = (vehicle as { id: string }).id;
    const oil = (await apiCall<Array<{ id: string; label: string }>>(page, 'GET', '/maintenance-types')).find((t) => t.label === 'Vidange moteur');
    expect(oil).toBeDefined();
    // Dernier relevé accepté il y a 10 jours (seuil initial : 7 jours sans observation acceptée).
    await apiCall(page, 'POST', `/vehicles/${vehicleId}/readings`, { physicalKm: '45000', observedAt: new Date(Date.now() - 10 * 24 * 3600_000).toISOString() });
    const plan = await apiCall<{ id: string; status: string; warnings: string[] }>(page, 'POST', '/maintenance-plans', { vehicleId, maintenanceTypeId: (oil as { id: string }).id, intervalKm: '10000', base: { baseMode: 'BASE_TECHNIQUE', baseKm: '40000' } });
    expect(plan.status).toBe('A_JOUR');
    expect(plan.warnings).toEqual(['KILOMETRAGE_ANCIEN']);
    try {
      // Liste des échéances : statut dans sa colonne, avertissement dans la colonne des données manquantes ou anciennes.
      await page.goto(`/entretiens?vehicule=${vehicleId}`);
      const row = page.getByRole('row').filter({ hasText: 'Vidange moteur' }).filter({ hasText: 'E2E-VB1' });
      await expect(row.getByText('À jour', { exact: true }).first()).toBeVisible();
      const warnings = row.getByRole('list', { name: 'Avertissements' });
      await expect(warnings).toContainText('Kilométrage ancien : relevé à actualiser');
      await expect(warnings).not.toContainText('À jour');
      // Fiche du plan : avertissement dans une zone distincte du statut.
      await row.getByRole('button', { name: 'Détail du plan Vidange moteur du véhicule E2E-VB1' }).click();
      const sheet = page.getByRole('dialog', { name: 'Vidange moteur · E2E-VB1' });
      await expect(sheet.getByText('À jour', { exact: true }).first()).toBeVisible();
      await expect(sheet.getByRole('region', { name: 'Données manquantes ou anciennes' })).toContainText('Kilométrage ancien : relevé à actualiser');
      await page.keyboard.press('Escape');
      // Fiche véhicule : fraîcheur du kilométrage affichée pour elle-même.
      await openVehicle(page, 'E2E-VB1');
      await expect(page.getByRole('main').getByText('Kilométrage : À actualiser', { exact: true })).toBeVisible();
    } finally {
      const current = await apiCall<{ version: number }>(page, 'GET', `/maintenance-plans/${plan.id}`);
      await apiCall(page, 'POST', `/maintenance-plans/${plan.id}/deactivate`, { reason: 'Fin du parcours relevé ancien', expectedVersion: current.version });
    }
  });
});
