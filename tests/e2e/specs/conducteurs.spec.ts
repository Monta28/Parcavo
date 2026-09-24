import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/** Suffixe unique par test : la base n'est réinitialisée qu'une fois (setup global). */
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();

/** Crée un conducteur depuis /conducteurs/nouveau et retourne l'identifiant de sa fiche. */
async function createDriver(page: Page, driver: { company: RegExp; code: string; firstName: string; lastName: string }): Promise<string> {
  await page.goto('/conducteurs/nouveau');
  await expect(page.getByRole('heading', { name: 'Nouveau conducteur' })).toBeVisible();
  const company = page.getByRole('combobox', { name: 'Société *' });
  await company.click();
  await page.getByRole('option', { name: driver.company }).click();
  await expect(company).toHaveText(driver.company);
  await page.getByLabel('Identifiant interne *').fill(driver.code);
  await page.getByLabel('Nom *', { exact: true }).fill(driver.lastName);
  await page.getByLabel('Prénom *', { exact: true }).fill(driver.firstName);
  await page.getByRole('button', { name: 'Créer le conducteur' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${driver.firstName} ${driver.lastName}` })).toBeVisible();
  await expect(page).toHaveURL(/\/conducteurs\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop();
  if (!id) throw new Error('Identifiant du conducteur introuvable dans l’URL.');
  return id;
}

test.describe('Dossier conducteur', () => {
  test('crée un conducteur, renseigne puis modifie son permis, le désactive avec motif et le réactive', async ({ page }) => {
    const suffix = unique();
    const code = `D-${suffix}`;
    const name = { firstName: 'Nadia', lastName: `Permis${suffix}` };
    const fullName = `${name.firstName} ${name.lastName}`;
    await loginAs(page, E2E.chefA);

    await createDriver(page, { company: /E2E-A/, code, ...name });
    const main = page.getByRole('main');
    await expect(main).toContainText(`Identifiant ${code} · Société ${E2E.companyA}`);
    await expect(main.getByText('Actif', { exact: true })).toBeVisible();

    // Permis : saisie initiale (numéro, catégorie B exigée par la catégorie VP, dates de validité).
    const permitCard = page.locator('[data-slot="card"]').filter({ has: page.getByText('Permis de conduire', { exact: true }) });
    await expect(permitCard).toContainText('Aucune information de permis enregistrée.');
    await permitCard.getByRole('button', { name: 'Renseigner le permis' }).click();
    await permitCard.getByLabel('Numéro du permis *').fill(`P-${suffix}`);
    const categoryB = permitCard.getByRole('checkbox', { name: 'B', exact: true });
    await categoryB.check();
    await expect(categoryB).toBeChecked();
    await permitCard.getByLabel('Délivré le').fill('2020-01-15');
    await permitCard.getByLabel('Expire le').fill('2035-01-14');
    await permitCard.getByRole('button', { name: 'Enregistrer le permis' }).click();
    const permitValues = permitCard.getByRole('definition');
    await expect(permitValues).toHaveText([`P-${suffix}`, 'B', '15/01/2020', '14/01/2035', 'Aucun justificatif téléversé.']);

    await page.reload();
    await expect(permitValues).toHaveText([`P-${suffix}`, 'B', '15/01/2020', '14/01/2035', 'Aucun justificatif téléversé.']);

    // Permis : modification (renouvellement) conservée après rechargement.
    await permitCard.getByRole('button', { name: 'Modifier le permis' }).click();
    await expect(permitCard.getByLabel('Numéro du permis *')).toHaveValue(`P-${suffix}`);
    await expect(permitCard.getByRole('checkbox', { name: 'B', exact: true })).toBeChecked();
    await permitCard.getByLabel('Numéro du permis *').fill(`P-${suffix}-R`);
    await permitCard.getByLabel('Délivré le').fill('2025-02-01');
    await permitCard.getByLabel('Expire le').fill('2035-01-31');
    await permitCard.getByRole('button', { name: 'Enregistrer le permis' }).click();
    await expect(permitValues).toHaveText([`P-${suffix}-R`, 'B', '01/02/2025', '31/01/2035', 'Aucun justificatif téléversé.']);
    await page.reload();
    await expect(permitValues).toHaveText([`P-${suffix}-R`, 'B', '01/02/2025', '31/01/2035', 'Aucun justificatif téléversé.']);

    // Désactivation : le motif est obligatoire (3 caractères minimum).
    await page.getByRole('button', { name: 'Désactiver' }).click();
    const dialog = page.getByRole('dialog', { name: `Désactiver ${fullName}` });
    const confirmDeactivation = dialog.getByRole('button', { name: 'Désactiver' });
    await expect(confirmDeactivation).toBeDisabled();
    const reason = dialog.getByLabel(/^Motif/);
    await reason.fill('ab');
    await expect(confirmDeactivation).toBeDisabled();
    await reason.fill('Départ de la société');
    await confirmDeactivation.click();
    await expect(dialog).toBeHidden();
    await expect(main.getByText('Inactif', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Désactiver' })).toHaveCount(0);

    await page.reload();
    await expect(main.getByText('Inactif', { exact: true })).toBeVisible();
    await page.goto('/conducteurs');
    await page.getByLabel('Rechercher').fill(code);
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: code, exact: true }) });
    await expect(row).toContainText('Inactif');
    await expect(row).toContainText('expire le 31/01/2035');
    await page.getByRole('link', { name: code, exact: true }).click();

    // Réactivation après confirmation.
    await page.getByRole('button', { name: 'Réactiver' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Réactiver ${fullName} ?` });
    await confirm.getByRole('button', { name: 'Réactiver' }).click();
    await expect(confirm).toBeHidden();
    await expect(main.getByText('Actif', { exact: true })).toBeVisible();
    await expect(main.getByText('Inactif', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Désactiver' })).toBeVisible();
    await page.reload();
    await expect(main.getByText('Actif', { exact: true })).toBeVisible();
  });

  test('la fiche d’un conducteur de la société B est refusée au chef de parc de A', async ({ page }) => {
    const suffix = unique();
    const code = `DB-${suffix}`;
    await loginAs(page, E2E.admin);
    const driverId = await createDriver(page, { company: /E2E-B/, code, firstName: 'Bilel', lastName: `Horsperimetre${suffix}` });
    await expect(page.getByRole('main')).toContainText(`Identifiant ${code} · Société ${E2E.companyB}`);
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);

    await loginAs(page, E2E.chefA);
    await page.goto(`/conducteurs/${driverId}`);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Accès refusé ou élément hors de votre périmètre');
    await expect(page.getByRole('heading', { name: `Bilel Horsperimetre${suffix}` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Désactiver' })).toHaveCount(0);

    // La liste du chef de A n'expose pas non plus ce conducteur.
    await page.goto('/conducteurs');
    await expect(page.getByRole('link', { name: 'D-E2E-1', exact: true })).toBeVisible();
    await page.getByLabel('Rechercher').fill(code);
    await expect(page.getByText('Aucun conducteur', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: code, exact: true })).toHaveCount(0);
  });
});
