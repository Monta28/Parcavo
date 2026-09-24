import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * CDC 10.1 : interface en français, sélecteur de société et périmètre courant ; « Toutes mes sociétés »
 * réservé aux personnes habilitées. Contrôles sur le web compilé (production), sans donnée modifiée.
 */
test.describe('Interface en français et périmètre courant', () => {
  test('adresse inconnue : page introuvable en français (pas l’écran anglais de Next.js), retour à l’accueil', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    const response = await page.goto('/adresse-inexistante');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page introuvable' })).toBeVisible();
    await expect(page.getByText(/could not be found/i)).toHaveCount(0);
    await expect(page).toHaveTitle(/Page introuvable/);
    await page.getByRole('link', { name: 'Retour à l’accueil' }).click();
    await expect(page).toHaveURL(/\/tableau-de-bord/);
  });

  test('le chef d’une seule société voit son périmètre courant en clair, sans sélecteur ni « Toutes mes sociétés »', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/vehicules');
    await expect(page.getByRole('banner').getByText(`${E2E.companyA} · Société E2E A`)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Société courante' })).toHaveCount(0);
    await expect(page.getByText('Toutes mes sociétés')).toHaveCount(0);
  });

  test('l’administrateur voit « Toutes mes sociétés » dans le sélecteur de société courante', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await page.goto('/vehicules');
    const selector = page.getByRole('combobox', { name: 'Société courante' });
    await expect(selector).toContainText('Toutes mes sociétés');
    await selector.click();
    await expect(page.getByRole('option', { name: 'Toutes mes sociétés' })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(E2E.companyA) })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
