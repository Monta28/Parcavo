import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/** Suffixe unique par test : la base n'est réinitialisée qu'une fois (setup global). */
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();

const HEADER = 'Société;Code;registration;make;model;category';

/** Téléverse un fichier CSV pour le modèle déjà choisi et attend l'ouverture du lot. */
async function uploadCsv(page: Page, name: string, content: string): Promise<void> {
  await page.getByLabel('Fichier CSV ou XLSX').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
  await page.getByRole('button', { name: 'Envoyer le fichier' }).click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page).toHaveURL(/[?&]lot=[0-9a-f-]{36}/);
}

/** Associe les en-têtes français du fichier aux colonnes du modèle puis lance le contrôle. */
async function mapAndValidate(page: Page): Promise<void> {
  await page.getByLabel(/^company_code/).selectOption('Société');
  await page.getByLabel(/^vehicle_code/).selectOption('Code');
  await page.getByRole('button', { name: /Contrôler le fichier|Relancer le contrôle/ }).click();
  await expect(page.getByRole('heading', { name: '4. Aperçu et résultat du contrôle' })).toBeVisible();
}

test.describe('Imports assistés', () => {
  test('modèle, association, contrôle en erreur et abandon, puis import confirmé, rapport et historique', async ({ page }) => {
    const s = unique();
    await loginAs(page, E2E.chefA);
    await page.goto('/imports');
    await expect(page.getByRole('heading', { level: 1, name: 'Imports' })).toBeVisible();

    // 1. Modèle : colonnes décrites par l'API et modèle vierge téléchargeable.
    await page.getByRole('radio', { name: /^Véhicules/ }).click();
    await expect(page).toHaveURL(/modele=VEHICULES/);
    await expect(page.getByRole('cell', { name: 'company_code', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Code de la catégorie de véhicule' })).toBeVisible();
    const template = page.waitForEvent('download');
    await page.getByRole('link', { name: /Modèle CSV/ }).click();
    expect((await template).suggestedFilename()).toBe('modele-import-vehicules.csv');

    // 2-4. Fichier avec une catégorie inconnue : association incomplète refusée par colonne, puis ligne en erreur.
    const refused = `vehicules-${s}-a.csv`;
    await uploadCsv(page, refused, `${HEADER}\nE2E-A;IMP-${s}-1;${s} TU 1;Renault;Clio;VP\nE2E-A;IMP-${s}-2;${s} TU 2;Renault;Clio;XX\n`);
    await expect(page.getByLabel(/^registration/)).toHaveValue('registration');
    await page.getByRole('button', { name: 'Contrôler le fichier' }).click();
    await expect(page.getByText('Colonne obligatoire non associée.')).toHaveCount(2);
    await mapAndValidate(page);
    const result = page.getByRole('region', { name: '4. Aperçu et résultat du contrôle' });
    const errorRow = result.getByRole('row').filter({ hasText: 'Catégorie « XX » inconnue ou archivée.' });
    await expect(errorRow).toContainText('En erreur');
    await expect(errorRow.getByRole('cell', { name: 'XX (en erreur)' })).toBeVisible();
    await expect(page.getByText(/1 ligne en erreur : la confirmation est impossible/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Confirmer l’import/ })).toBeDisabled();
    await result.getByRole('combobox', { name: 'Statut des lignes' }).click();
    await page.getByRole('option', { name: 'En erreur' }).click();
    await expect(result.getByRole('row')).toHaveCount(2);

    // 7. Abandon confirmé : rien n'est importé.
    await page.getByRole('button', { name: 'Abandonner', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Motif (facultatif)').fill('Catégorie inconnue');
    await dialog.getByRole('button', { name: 'Abandonner le lot' }).click();
    await expect(page.getByText(/Ce lot a été abandonné : aucune ligne n’a été importée/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Contrôler le fichier' })).toHaveCount(0);

    // 2-6. Fichier corrigé : contrôle sans erreur, confirmation, rapport et lien vers la fiche créée.
    await page.getByRole('button', { name: 'Retour aux imports' }).click();
    await page.getByRole('radio', { name: /^Véhicules/ }).click();
    const accepted = `vehicules-${s}-b.csv`;
    const acceptedContent = `${HEADER}\nE2E-A;IMP-${s}-1;${s} TU 1;Renault;Clio;VP\nE2E-A;IMP-${s}-2;${s} TU 2;Renault;Clio;VP\n`;
    await uploadCsv(page, accepted, acceptedContent);
    await mapAndValidate(page);
    await expect(page.getByText('Aucune ligne n’est écrite avant la confirmation.')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmer l’import de 2 lignes' }).click();
    await expect(page.getByRole('heading', { name: 'Rapport d’import' })).toBeVisible();
    const report = page.getByRole('region', { name: 'Rapport d’import' });
    await expect(report.getByRole('row').filter({ hasText: `IMP-${s}-1` })).toContainText('Importée');
    const reportFile = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Rapport CSV' }).click();
    expect((await reportFile).suggestedFilename()).toBe(`rapport-vehicules-${s}-b.csv`);
    await report.getByRole('link', { name: 'Ouvrir la fiche créée par la ligne 2' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`IMP-${s}-1`) })).toBeVisible();

    // Même fichier téléversé à nouveau : avertissement « déjà importé le … », lot repris depuis l'historique.
    await page.goto('/imports?modele=VEHICULES');
    await uploadCsv(page, accepted, acceptedContent);
    await expect(page.getByText(/Ce fichier a déjà été importé le/)).toBeVisible();
    const lotUrl = page.url();
    await page.getByRole('button', { name: 'Retour aux imports' }).click();
    const history = page.getByRole('region', { name: 'Historique des lots' });
    await history.getByRole('combobox', { name: 'Statut du lot' }).click();
    await page.getByRole('option', { name: 'Téléversé' }).click();
    await expect(page).toHaveURL(/statut=TELEVERSE/);
    await history.getByRole('button', { name: `Reprendre le lot ${accepted}` }).first().click();
    await expect(page).toHaveURL(new RegExp(`[?&]lot=${new URL(lotUrl).searchParams.get('lot') ?? 'absent'}`));
    await expect(page.getByRole('heading', { name: '3. Associer les colonnes' })).toBeVisible();
    await page.goto('/imports?statut=CONFIRME');
    await expect(page.getByRole('region', { name: 'Historique des lots' }).getByRole('row').filter({ hasText: accepted })).toContainText('Confirmé');
  });

  test('l’import est refusé à un conducteur', async ({ page }) => {
    await loginAs(page, E2E.conducteur);
    await page.goto('/imports');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('L’import est réservé au chef de parc et à l’administrateur.');
  });
});
