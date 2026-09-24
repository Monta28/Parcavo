import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

test.describe('Dossier véhicule', () => {
  test('crée un véhicule, refuse le doublon d’immatriculation et déclare une localisation', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/vehicules/nouveau');
    await page.getByLabel('Code interne *').fill('E2E-NEW');
    await page.getByLabel('Immatriculation ou identifiant provisoire *').fill('303 TU 2026');
    await page.getByRole('combobox', { name: 'Catégorie *' }).click();
    await page.getByRole('option', { name: 'Véhicule particulier' }).click();
    await page.getByLabel('Marque *').fill('Renault');
    await page.getByLabel('Modèle *').fill('Clio');
    await page.getByRole('button', { name: 'Créer le véhicule' }).click();
    await expect(page.getByRole('heading', { name: /E2E-NEW · 303 TU 2026/ })).toBeVisible();
    await expect(page.getByText('Disponible', { exact: true })).toBeVisible();
    await expect(page.getByText('Kilométrage inconnu : aucun relevé accepté.')).toBeVisible();

    // doublon d'immatriculation après normalisation
    await page.goto('/vehicules/nouveau');
    await page.getByLabel('Code interne *').fill('E2E-DUP');
    await page.getByLabel('Immatriculation ou identifiant provisoire *').fill('303-tu-2026');
    await page.getByRole('combobox', { name: 'Catégorie *' }).click();
    await page.getByRole('option', { name: 'Véhicule particulier' }).click();
    await page.getByLabel('Marque *').fill('Renault');
    await page.getByLabel('Modèle *').fill('Clio');
    await page.getByRole('button', { name: 'Créer le véhicule' }).click();
    await expect(page.getByText(/Cette immatriculation existe déjà/)).toBeVisible();

    // localisation déclarée
    await page.goto('/vehicules');
    await page.getByRole('link', { name: 'E2E-NEW' }).click();
    await page.getByRole('tab', { name: 'Localisation' }).click();
    await page.getByRole('combobox', { name: 'Site' }).click();
    await page.getByRole('option', { name: 'Dépôt Tunis' }).click();
    await page.getByLabel('Commentaire').fill('garé au dépôt');
    await page.getByRole('button', { name: 'Déclarer' }).click();
    await expect(page.getByRole('cell', { name: 'Dépôt Tunis' })).toBeVisible();
    await page.getByRole('tab', { name: 'Synthèse' }).click();
    await expect(page.getByText('Dépôt Tunis')).toBeVisible();
  });

  test('un identifiant de véhicule hors périmètre affiche un accès refusé', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/vehicules/00000000-0000-7000-8000-000000000000');
    await expect(page.getByRole('main').getByRole('alert')).toContainText(/hors de votre périmètre|introuvable/i);
  });
});
