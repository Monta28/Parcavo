import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

test.describe('Connexion et périmètre', () => {
  test('refuse un mot de passe invalide avec un message non énumérant', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Adresse e-mail').fill(E2E.chefA);
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Adresse e-mail ou mot de passe incorrect');
    await expect(page).toHaveURL(/\/login/);
  });

  test('redirige un visiteur anonyme vers la connexion et conserve la page demandée', async ({ page }) => {
    await page.goto('/vehicules');
    await expect(page).toHaveURL(/\/login\?suite=%2Fvehicules/);
  });

  test('le chef de A voit uniquement les véhicules de A et se déconnecte', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/vehicules');
    await expect(page.getByRole('heading', { name: 'Véhicules' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VA1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VB1' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/vehicules');
    await expect(page).toHaveURL(/\/login/);
  });

  test('l’administrateur bascule entre toutes les sociétés et une société', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await page.goto('/vehicules');
    await expect(page.getByRole('link', { name: 'E2E-VB1' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Société courante' }).click();
    await page.getByRole('option', { name: /E2E-A/ }).click();
    await expect(page.getByRole('link', { name: 'E2E-VB1' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'E2E-VA1' })).toBeVisible();
  });
});
