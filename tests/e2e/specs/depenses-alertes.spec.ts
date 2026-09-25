import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { logout } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/** Justificatif fictif : PDF minimal sans contenu actif (type réel vérifié par l'API). */
const TICKET_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'utf8');

/** Date civile du jour + n dans le fuseau du groupe (AAAA-MM-JJ). */
function civilDate(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + daysAhead * 24 * 3600_000));
}

function frenchDate(civil: string): string {
  const [y, m, d] = civil.split('-');
  return `${d}/${m}/${y}`;
}

async function pickVehicle(page: Page, combobox: Locator, code: string): Promise<void> {
  await combobox.click();
  await page.getByRole('combobox', { name: 'Rechercher un véhicule' }).fill(code);
  await page.getByRole('option', { name: new RegExp(code) }).click();
}

/** Valeur numérique d'un compteur du centre d'alertes, une fois chargé. */
async function counter(page: Page, key: string): Promise<number> {
  const tile = page.getByTestId(`compteur-${key}`);
  await expect(tile).not.toContainText('…');
  return Number((await tile.locator('span').first().textContent())?.trim());
}

test.describe('Dépenses', () => {
  test('le chef saisit une dépense avec justificatif, la retrouve dans la synthèse puis l’exclut du coût d’exploitation', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/depenses');
    await expect(page.getByRole('heading', { level: 1, name: 'Dépenses' })).toBeVisible();

    await page.getByRole('button', { name: 'Saisir une dépense' }).click();
    const dialog = page.getByRole('dialog', { name: 'Saisir une dépense ou un avoir' });
    // Contrôles de saisie avant l'envoi, messages attachés aux champs.
    await dialog.getByRole('button', { name: 'Enregistrer la dépense' }).click();
    await expect(dialog.getByText('Choisissez la catégorie.')).toBeVisible();
    await expect(dialog.getByText('Indiquez le montant TTC.')).toBeVisible();

    await pickVehicle(page, dialog.getByRole('combobox', { name: 'Véhicule *' }), 'E2E-DEP1');
    await expect(dialog.getByRole('combobox', { name: 'Véhicule *' })).toContainText('E2E-DEP1 · 401 TU 2026');
    await dialog.getByRole('combobox', { name: 'Catégorie *' }).click();
    await page.getByRole('option', { name: 'Péage' }).click();
    await dialog.getByLabel(/^Montant TTC/).fill('45,500');
    await dialog.getByLabel('Référence (facture, ticket)').fill('TICKET-E2E-1');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: /Justificatif .*Choisir un fichier/ }).click();
    await (await chooser).setFiles({ name: 'ticket-peage.pdf', mimeType: 'application/pdf', buffer: TICKET_PDF });
    await expect(dialog.getByRole('button', { name: /Retirer le fichier/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Enregistrer la dépense' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Dépense enregistrée : 45,500 TND · E2E-DEP1 — 401 TU 2026 · société E2E-A/)).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: 'TICKET-E2E-1' });
    await expect(row).toContainText('E2E-DEP1 — 401 TU 2026');
    await expect(row).toContainText('Péage');
    await expect(row).toContainText('45,500 TND');
    await expect(row).toContainText('Validée');
    // Justificatif privé : lien de téléchargement servi après contrôle des droits par l'API.
    const attachmentLink = row.getByRole('link', { name: /Ouvrir le justificatif/ });
    await expect(attachmentLink).toBeVisible();
    const download = await page.request.get((await attachmentLink.getAttribute('href')) ?? '');
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toContain('application/pdf');

    // Synthèse limitée au véhicule : totaux calculés par l'API.
    await pickVehicle(page, page.getByRole('combobox', { name: 'Véhicule', exact: true }), 'E2E-DEP1');
    await expect(page).toHaveURL(/vehicule=[0-9a-f-]{36}/);
    await expect(page.getByTestId('synthese-exploitation')).toContainText('45,500 TND');
    await expect(page.getByTestId('synthese-exploitation')).toContainText('1 écriture');
    await expect(page.getByTestId('synthese-non-ventile')).toContainText('0,000 TND');
    await expect(page.getByRole('table', { name: 'Coût d’exploitation par catégorie' }).getByRole('row').filter({ hasText: 'Péage' })).toContainText('45,500 TND');

    // Bascule « hors coût d'exploitation » : la dépense reste au registre, à titre informatif.
    await row.getByRole('button', { name: /Actions sur la dépense Péage/ }).click();
    await page.getByRole('menuitem', { name: 'Exclure du coût d’exploitation' }).click();
    const toggle = page.getByRole('dialog', { name: 'Exclure du coût d’exploitation' });
    await toggle.getByLabel('Motif (journal d’audit)').fill('Refacturé au client');
    await toggle.getByRole('button', { name: 'Exclure du coût d’exploitation' }).click();
    await expect(toggle).toBeHidden();
    await expect(row).toContainText('Hors coût d’exploitation');
    await expect(page.getByTestId('synthese-exploitation')).toContainText('0,000 TND');
    await expect(page.getByTestId('synthese-hors-exploitation')).toContainText('45,500 TND');
  });

  test('le chef corrige une dépense validée (nouvelle version, ancienne remplacée) puis l’annule avec motif', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/depenses?q=FACT-E2E-CORR');
    const row = page.getByRole('table', { name: 'Registre des dépenses' }).getByRole('row').filter({ hasText: 'FACT-E2E-CORR' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('E2E-AL1 — 402 TU 2026');
    await expect(row).toContainText('120,000 TND');

    // Correction : motif obligatoire ; seule la valeur modifiée est transmise, avec la version et une clé d'idempotence.
    await row.getByRole('button', { name: /^Actions sur la dépense Entretien/ }).click();
    await page.getByRole('menuitem', { name: 'Corriger' }).click();
    const correct = page.getByRole('dialog', { name: 'Corriger la dépense' });
    await correct.getByLabel(/^Montant TTC/).fill('150,000');
    await correct.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(correct.getByText('Indiquez le motif de la correction (3 caractères au moins).')).toBeVisible();
    await correct.getByLabel('Motif de la correction *').fill('Facture rectificative du garage');
    await correct.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(correct).toBeHidden();
    await expect(page.getByText(/Dépense corrigée : nouvelle version de 150,000 TND/)).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('150,000 TND');
    await expect(row).toContainText('Version corrigée');

    // L'ancienne version reste consultable, remplacée et sans action possible.
    const state = page.getByRole('combobox', { name: 'État', exact: true });
    await state.click();
    await page.getByRole('option', { name: 'Remplacées par une correction' }).click();
    await expect(page).toHaveURL(/etat=REMPLACEE/);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('120,000 TND');
    await expect(row).toContainText('Remplacée (corrigée)');
    await expect(row.getByRole('button', { name: /Actions sur la dépense/ })).toHaveCount(0);

    // Annulation motivée de la version en vigueur : elle quitte les dépenses validées.
    await state.click();
    await page.getByRole('option', { name: 'Validées (en vigueur)' }).click();
    await expect(row).toContainText('150,000 TND');
    await row.getByRole('button', { name: /^Actions sur la dépense Entretien/ }).click();
    await page.getByRole('menuitem', { name: 'Annuler la dépense' }).click();
    const cancel = page.getByRole('dialog', { name: 'Annuler la dépense' });
    await cancel.getByLabel('Motif de l’annulation *').fill('Facture émise par erreur');
    await cancel.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await expect(cancel).toBeHidden();
    await expect(page.getByText('Dépense annulée : elle n’est plus comptée dans les totaux de sa période.')).toBeVisible();
    await expect(page.getByText('Aucune dépense', { exact: true })).toBeVisible();

    await state.click();
    await page.getByRole('option', { name: 'Annulées' }).click();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('150,000 TND');
    await expect(row).toContainText('Annulée');
    await expect(row).toContainText('Facture émise par erreur');
  });

  test('un opérateur saisit une dépense sans pouvoir consulter le registre ; le chef la retrouve', async ({ page }) => {
    await loginAs(page, E2E.operateurA);
    await page.goto('/depenses');
    const denied = page.getByRole('main').getByRole('alert');
    await expect(denied).toContainText('Consultation des coûts non autorisée');
    await expect(denied).toContainText('Vous pouvez saisir une dépense');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByTestId('synthese-exploitation')).toHaveCount(0);

    await page.getByRole('button', { name: 'Saisir une dépense' }).click();
    const dialog = page.getByRole('dialog', { name: 'Saisir une dépense ou un avoir' });
    await dialog.getByRole('radio', { name: 'Sans véhicule' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Société imputée *' })).toContainText(`${E2E.companyA} · Société E2E A`);
    await dialog.getByRole('combobox', { name: 'Catégorie *' }).click();
    await page.getByRole('option', { name: 'Taxes' }).click();
    await dialog.getByLabel(/^Montant TTC/).fill('75');
    await dialog.getByLabel('Référence (facture, ticket)').fill('VIGNETTE-E2E-OP');
    await dialog.getByRole('button', { name: 'Enregistrer la dépense' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Dépense enregistrée : 75,000 TND · Dépense société non affectée · société ${E2E.companyA}.`)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await logout(page);

    await loginAs(page, E2E.chefA);
    await page.goto('/depenses?q=VIGNETTE-E2E-OP&sansVehicule=1');
    const row = page.getByRole('table', { name: 'Registre des dépenses' }).getByRole('row').filter({ hasText: 'VIGNETTE-E2E-OP' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Dépense société non affectée');
    await expect(row).toContainText('Taxes');
    await expect(row).toContainText('75,000 TND');
  });

  test('un compte sans permission de consulter les coûts voit un message clair, sans registre', async ({ page }) => {
    await loginAs(page, E2E.conducteur);
    await page.goto('/depenses');
    const denied = page.getByRole('main').getByRole('alert');
    await expect(denied).toContainText('Consultation des coûts non autorisée');
    await expect(denied).toContainText('réservé au personnel de gestion du parc');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Saisir une dépense' })).toHaveCount(0);
  });
});

test.describe('Alertes', () => {
  test('le chef marque une alerte comme lue puis la reporte : elle reste active', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/alertes');
    await expect(page.getByRole('heading', { level: 1, name: 'Alertes' })).toBeVisible();
    const unreadBefore = await counter(page, 'non-lues');
    const snoozedBefore = await counter(page, 'reportees');
    const activeBefore = await counter(page, 'actives');

    await page.getByLabel('Recherche').fill('E2E-AL1');
    const item = page.getByRole('listitem', { name: 'Kilométrage inconnu — E2E-AL1' });
    await expect(item).toContainText('Non lue');
    await expect(item).toContainText('Kilométrage absent');
    await expect(item.getByRole('link', { name: 'Kilométrage inconnu — E2E-AL1' })).toHaveAttribute('href', /\/vehicules\/[0-9a-f-]{36}\?onglet=kilometrage/);

    // « Lu » : état propre à l'utilisateur, sans effet sur l'alerte (T20).
    await item.getByRole('button', { name: /^Marquer comme lue/ }).click();
    await expect(item.getByText('Lue', { exact: true })).toBeVisible();
    await expect(item.getByText('Non lue', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('compteur-non-lues').locator('span').first()).toHaveText(String(unreadBefore - 1));
    await expect(item.getByText('Active', { exact: true })).toBeVisible();

    // Report motivé jusqu'à une date future : l'alerte reste active et comptée.
    const until = civilDate(7);
    await item.getByRole('button', { name: /^Reporter/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Reporter l’alerte' });
    await dialog.getByRole('button', { name: 'Confirmer le report' }).click();
    await expect(dialog.getByText('Indiquez la date de fin du report.')).toBeVisible();
    await dialog.getByLabel('Reporter jusqu’au *').fill(until);
    await dialog.getByLabel('Motif du report *').fill('Relevé attendu du conducteur à son retour');
    await dialog.getByRole('button', { name: 'Confirmer le report' }).click();
    await expect(dialog).toBeHidden();
    await expect(item).toContainText(`Reportée par vous jusqu’au ${frenchDate(until)} inclus — Relevé attendu du conducteur à son retour`);
    await expect(item.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByTestId('compteur-reportees').locator('span').first()).toHaveText(String(snoozedBefore + 1));
    await expect(page.getByTestId('compteur-actives').locator('span').first()).toHaveText(String(activeBefore));

    // Filtre « mes reports » puis annulation du report.
    await page.getByRole('combobox', { name: 'Reports' }).click();
    await page.getByRole('option', { name: 'Mes reports uniquement' }).click();
    await expect(page).toHaveURL(/reports=only/);
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: /^Annuler mon report/ }).click();
    await expect(page.getByText('Aucune alerte active')).toBeVisible();
    await expect(page.getByTestId('compteur-reportees').locator('span').first()).toHaveText(String(snoozedBefore));

    // Un compteur remplace les filtres en cours (type, recherche, reports) : la liste correspond au nombre affiché.
    await page.getByTestId('compteur-actives').click();
    await expect(page).not.toHaveURL(/[?&](q|reports)=/);
    await expect(page.getByLabel('Recherche')).toHaveValue('');
    await expect(page.getByTestId('compteur-actives')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('compteur-non-lues').click();
    await expect(page).toHaveURL(/lecture=non-lues/);
    await expect(page.getByTestId('compteur-non-lues')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('compteur-actives')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('compteur-attention').click();
    await expect(page).toHaveURL(/gravite=ATTENTION/);
    await expect(page).not.toHaveURL(/lecture=/);
    await expect(page.getByTestId('compteur-non-lues')).toHaveAttribute('aria-pressed', 'false');
  });
});
