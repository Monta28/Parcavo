import { expect, type Page } from '@playwright/test';
import { E2E } from './seed-e2e.js';

export async function loginAs(page: Page, email: string, password = E2E.password): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
