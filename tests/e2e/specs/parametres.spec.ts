import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Administration › Paramètres (CDC 17.1) : valeur groupe et surcharge société, validation et messages du
 * serveur sous les champs, historique motivé, retrait de surcharge ; bornes de pagination non modifiables.
 * Les valeurs modifiées sont remises à leur état initial en fin de parcours (base partagée par les parcours).
 */

function row(page: Page, label: string) {
  return page.getByRole('row').filter({ has: page.getByText(label, { exact: true }) });
}

/** Recherche de l'écran (conservée dans l'URL, paramètre q). */
async function search(page: Page, text: string) {
  await page.getByRole('main').getByLabel('Recherche').fill(text);
  await expect(page).toHaveURL(/[?&]q=/);
}

test.describe('Paramètres de l’organisation', () => {
  test('modifie une valeur groupe avec motif, affiche les erreurs du serveur, l’historique et une surcharge société retirée', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await page.goto('/administration/parametres');
    await expect(page.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Paramètres', exact: true })).toHaveAttribute('aria-current', 'page');

    // Bornes de pagination : valeurs fixes du contrat de l'API, sans action de modification.
    await search(page, 'pagination');
    await expect(row(page, 'Pagination maximale')).toContainText('100 lignes');
    await expect(row(page, 'Pagination maximale')).toContainText('Valeur fixe');
    await expect(page.getByRole('button', { name: 'Modifier « Pagination maximale »' })).toHaveCount(0);

    // Valeur hors bornes : refus du serveur affiché sous le champ, rien n'est enregistré.
    await search(page, 'Kilométrage ancien');
    await page.getByRole('button', { name: 'Modifier « Kilométrage ancien après »' }).click();
    const dialog = page.getByRole('dialog', { name: 'Modifier un paramètre' });
    await dialog.getByLabel(/Nouvelle valeur/).fill('0');
    await dialog.getByLabel('Motif *').fill('Essai de borne');
    await dialog.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(dialog.locator('#value-error')).toHaveText('valeur minimale 1 jours.');
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(row(page, 'Kilométrage ancien après')).toContainText('Défaut du produit');

    // Valeur groupe : motif exigé par le serveur, puis nouvelle version enregistrée.
    await search(page, 'récapitulatif');
    await page.getByRole('button', { name: 'Modifier « Heure du récapitulatif e-mail »' }).click();
    const digest = page.getByRole('dialog', { name: 'Modifier un paramètre' });
    await digest.getByLabel(/Nouvelle valeur/).fill('07:30');
    await digest.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(digest.locator('#reason-error')).toBeVisible();
    await digest.getByLabel('Motif *').fill('Arrivée plus tôt des équipes');
    await digest.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(page.getByText('Heure du récapitulatif e-mail : version 1 enregistrée.')).toBeVisible();
    await expect(row(page, 'Heure du récapitulatif e-mail')).toContainText('07:30');
    await expect(row(page, 'Heure du récapitulatif e-mail')).toContainText('Valeur groupe');

    // Historique : version, valeur, motif et auteur.
    await page.getByRole('button', { name: 'Historique de « Heure du récapitulatif e-mail »' }).click();
    const history = page.getByRole('dialog', { name: 'Historique du paramètre' });
    const version = history.getByRole('row').filter({ hasText: 'Arrivée plus tôt des équipes' });
    await expect(version).toContainText('Groupe');
    await expect(version).toContainText('07:30');
    await expect(version).toContainText('En vigueur');
    await expect(version).toContainText('Amel Admin');
    await history.getByRole('button', { name: 'Fermer' }).last().click();

    // Surcharge pour la société B, puis retrait motivé : retour à la valeur par défaut.
    await page.getByRole('combobox', { name: 'Niveau affiché' }).click();
    await page.getByRole('option', { name: /E2E-B/ }).click();
    await expect(page).toHaveURL(/societe=/);
    await search(page, 'muette');
    await expect(row(page, 'Source GPS muette après')).toContainText('24 heures');
    await page.getByRole('button', { name: 'Surcharger « Source GPS muette après »' }).click();
    const override = page.getByRole('dialog', { name: 'Surcharger pour une société' });
    await override.getByLabel(/Nouvelle valeur/).fill('48');
    await override.getByLabel('Motif *').fill('Boîtiers en zone blanche');
    await override.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(row(page, 'Source GPS muette après')).toContainText('48 heures');
    await expect(row(page, 'Source GPS muette après')).toContainText('Surcharge société');
    await page.getByRole('button', { name: 'Retirer la surcharge de « Source GPS muette après »' }).click();
    const removal = page.getByRole('dialog', { name: 'Retirer la surcharge' });
    await removal.getByLabel('Motif *').fill('Couverture rétablie');
    await removal.getByRole('button', { name: 'Retirer la surcharge' }).click();
    await expect(row(page, 'Source GPS muette après')).toContainText('24 heures');
    await expect(row(page, 'Source GPS muette après')).toContainText('Défaut du produit');

    // Remise à l'état initial de la valeur groupe (nouvelle version, l'historique garde la précédente).
    await page.getByRole('combobox', { name: 'Niveau affiché' }).click();
    await page.getByRole('option', { name: /Groupe/ }).click();
    await search(page, 'récapitulatif');
    await page.getByRole('button', { name: 'Modifier « Heure du récapitulatif e-mail »' }).click();
    const restore = page.getByRole('dialog', { name: 'Modifier un paramètre' });
    await restore.getByLabel(/Nouvelle valeur/).fill('08:00');
    await restore.getByLabel('Motif *').fill('Retour à la valeur initiale');
    await restore.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(row(page, 'Heure du récapitulatif e-mail')).toContainText('08:00');
    await expect(row(page, 'Heure du récapitulatif e-mail')).toContainText('version 2');
  });

  test('le chef de parc n’accède pas à l’onglet Paramètres', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/administration/parametres');
    await expect(page.getByText('Cette rubrique est réservée à l’administrateur groupe.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /Modifier « / })).toHaveCount(0);
  });

  test('liste des véhicules : tri au choix par colonne, conservé dans l’URL', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await page.goto('/vehicules');
    const header = page.getByRole('columnheader', { name: /Immatriculation/ });
    await expect(header).toHaveAttribute('aria-sort', 'none');
    await header.getByRole('button').click();
    await expect(page).toHaveURL(/tri=registration&sens=asc/);
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const ascending = await page.getByRole('row').locator('td:nth-child(2)').allTextContents();
    await header.getByRole('button').click();
    await expect(page).toHaveURL(/tri=registration&sens=desc/);
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(async () => (await page.getByRole('row').locator('td:nth-child(2)').allTextContents())[0]).not.toBe(ascending[0]);
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /Immatriculation/ })).toHaveAttribute('aria-sort', 'descending');
  });
});
