import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, frenchDate, logout } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Écran /fournisseurs (CDC 8.1, 10.2 : répertoire, contacts et historique autorisé) et détail d'une
 * dépense (/depenses/:id : chaîne des corrections, synthèse filtrée comme la liste, mention « le registre ne
 * remplace pas la comptabilité »). Données propres au parcours (noms et références uniques), créées par
 * l'interface ou par l'API réelle ; aucune dépense n'est rattachée à un véhicule d'un autre parcours.
 */

async function apiCall<T>(page: Page, method: 'GET' | 'POST', path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...headers } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function companyAId(page: Page): Promise<string> {
  const companies = await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/companies?pageSize=100');
  const id = companies.items.find((c) => c.code === E2E.companyA)?.id;
  expect(id).toBeTruthy();
  return id as string;
}

const unique = () => Date.now().toString(36).slice(-5).toUpperCase();

test.describe('Fournisseurs', () => {
  test('le chef tient le répertoire : création, recherche, fiche avec contacts et historique des dépenses, archivage puis réactivation', async ({ page }) => {
    test.setTimeout(120_000);
    const s = unique();
    const name = `Garage Médina ${s}`;
    await loginAs(page, E2E.chefA);
    await page.goto('/fournisseurs');
    await expect(page.getByRole('heading', { level: 1, name: 'Fournisseurs' })).toBeVisible();

    // Création : contrôles de saisie, puis enregistrement réel.
    await page.getByRole('button', { name: 'Nouveau fournisseur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau fournisseur' });
    await dialog.getByRole('button', { name: 'Créer le fournisseur' }).click();
    await expect(dialog.getByText('Indiquez le nom (2 caractères au moins).')).toBeVisible();
    await expect(dialog.getByText('Choisissez la catégorie.')).toBeVisible();
    const company = dialog.getByRole('combobox', { name: /^Société/ });
    if (!(await company.textContent())?.includes(E2E.companyA)) {
      await company.click();
      await page.getByRole('option', { name: new RegExp(`^${E2E.companyA} · `) }).click();
    }
    await dialog.getByRole('combobox', { name: 'Catégorie *' }).click();
    // Liste fermée du CDC 8.1.
    for (const category of ['Garage', 'Station', 'Assurance', 'Loueur', 'Autre']) await expect(page.getByRole('option', { name: category, exact: true })).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(5);
    await page.getByRole('option', { name: 'Garage', exact: true }).click();
    await dialog.getByLabel('Nom *').fill(name);
    await dialog.getByLabel('Contact').fill(`Hichem ${s}`);
    await dialog.getByLabel('Téléphone').fill('+216 71 222 333');
    await dialog.getByLabel('E-mail').fill(`atelier.${s.toLowerCase()}@medina.tn`);
    await dialog.getByLabel('Notes').fill('Ouvert le samedi matin');
    await dialog.getByRole('button', { name: 'Créer le fournisseur' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Fournisseur « ${name} » créé.`)).toBeVisible();

    // Recherche par contact (insensible à la casse) : seule cette fiche ; filtre de catégorie combiné.
    await page.getByLabel('Recherche').fill(`hichem ${s.toLowerCase()}`);
    await expect(page).toHaveURL(/q=hichem/);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Garage');
    await expect(row).toContainText(`Hichem ${s}`);
    await expect(row.getByRole('link', { name: '+216 71 222 333' })).toHaveAttribute('href', 'tel:+216 71 222 333');
    await expect(page.getByRole('row')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Catégorie' }).click();
    await page.getByRole('option', { name: 'Station', exact: true }).click();
    await expect(page.getByText('Aucun fournisseur ne correspond aux filtres dans votre périmètre.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Catégorie' }).click();
    await page.getByRole('option', { name: 'Toutes les catégories' }).click();
    await expect(row).toHaveCount(1);

    // Fiche : contacts, notes et historique autorisé (dépenses du registre, costs.read).
    await row.getByRole('button', { name, exact: true }).click();
    let sheet = page.getByRole('dialog', { name });
    await expect(sheet).toContainText(`Hichem ${s}`);
    await expect(sheet.getByRole('link', { name: `atelier.${s.toLowerCase()}@medina.tn` })).toHaveAttribute('href', `mailto:atelier.${s.toLowerCase()}@medina.tn`);
    await expect(sheet).toContainText('Ouvert le samedi matin');
    await expect(sheet.getByText('Aucune dépense validée ne référence ce fournisseur.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // Une dépense réelle référence ce fournisseur (API, même session) : elle apparaît dans l'historique.
    const suppliers = await apiCall<{ items: Array<{ id: string; name: string }> }>(page, 'GET', `/suppliers?q=${encodeURIComponent(name)}`);
    const supplierId = suppliers.items.find((x) => x.name === name)?.id as string;
    const expense = await apiCall<{ id: string }>(page, 'POST', '/expenses', { companyId: await companyAId(page), occurredOn: civilDate(0), category: 'AUTRE', supplierId, reference: `FAC-MED-${s}`, amount: '380.750' }, { 'Idempotency-Key': randomUUID() });
    await page.reload();
    await row.getByRole('button', { name, exact: true }).click();
    sheet = page.getByRole('dialog', { name });
    const history = sheet.getByRole('listitem').filter({ hasText: `Réf. FAC-MED-${s}` });
    await expect(history).toContainText('380,750 TND');
    await expect(history).toContainText(frenchDate(civilDate(0)));
    await history.getByRole('link', { name: 'Autre' }).click();
    await expect(page).toHaveURL(new RegExp(`/depenses/${expense.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: `Autre du ${frenchDate(civilDate(0))}` })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(name);

    // Archivage : retiré des actifs, visible parmi les archivés, puis réactivé.
    await page.goto(`/fournisseurs?q=${encodeURIComponent(name)}`);
    await row.getByRole('button', { name: `Actions pour ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Archiver' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Archiver « ${name} » ?` });
    await confirm.getByRole('button', { name: 'Archiver' }).click();
    await expect(page.getByText(`Fournisseur « ${name} » archivé.`)).toBeVisible();
    await expect(page.getByText('Aucun fournisseur ne correspond aux filtres dans votre périmètre.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Statut' }).click();
    await page.getByRole('option', { name: 'Archivés' }).click();
    await expect(row).toContainText('Archivé');
    await row.getByRole('button', { name: `Actions pour ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Réactiver' }).click();
    await page.getByRole('alertdialog', { name: `Réactiver « ${name} » ?` }).getByRole('button', { name: 'Réactiver' }).click();
    await expect(page.getByText(`Fournisseur « ${name} » réactivé.`)).toBeVisible();
    await page.getByRole('combobox', { name: 'Statut' }).click();
    await page.getByRole('option', { name: 'Actifs' }).click();
    await expect(row).toContainText('Actif');
  });

  test('l’administrateur copie un fournisseur vers une autre société : nouvelle fiche sans historique ; le conducteur n’a pas accès au répertoire', async ({ page }) => {
    const s = unique();
    const name = `Station Sahel ${s}`;
    await loginAs(page, E2E.admin);
    const companyA = await companyAId(page);
    await apiCall(page, 'POST', '/suppliers', { companyId: companyA, name, category: 'STATION', contactName: 'Service client' });
    await page.goto(`/fournisseurs?q=${encodeURIComponent(name)}`);
    const rows = page.getByRole('row').filter({ hasText: name });
    await expect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: `Actions pour ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Copier vers une autre société' }).click();
    const copy = page.getByRole('alertdialog', { name: `Copier « ${name} » vers une autre société` });
    await expect(copy).toContainText('L’historique (dépenses, interventions, pleins) et les montants ne sont pas copiés');
    // Destination explicite (présélectionnée quand une seule société est possible).
    const target = copy.getByRole('combobox', { name: 'Société de destination *' });
    if (!(await target.textContent())?.includes(E2E.companyB)) {
      await target.click();
      await page.getByRole('option', { name: new RegExp(`^${E2E.companyB} · `) }).click();
    }
    await expect(target).toContainText(E2E.companyB);
    await copy.getByRole('button', { name: 'Copier' }).click();
    await expect(page.getByText(`Fournisseur « ${name} » copié vers la société ${E2E.companyB}.`)).toBeVisible();

    // Deux fiches indépendantes (A et B), la copie sans historique ni montants.
    const both = await apiCall<{ items: Array<{ id: string; companyId: string; name: string }> }>(page, 'GET', `/suppliers?q=${encodeURIComponent(name)}`);
    expect(both.items.map((x) => x.name)).toEqual([name, name]);
    const copied = both.items.find((x) => x.companyId !== companyA) as { id: string };
    const history = await apiCall<{ total: number }>(page, 'GET', `/expenses?supplierId=${copied.id}`);
    expect(history.total).toBe(0);
    await page.reload();
    await expect(rows).toHaveCount(2);
    await logout(page);

    // Le conducteur n'a pas accès au répertoire : refus de l'API (403).
    await loginAs(page, E2E.conducteur);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
    const denied = await page.request.fetch('/api/v1/suppliers', { headers: { 'X-CSRF-Token': csrf } });
    expect(denied.status()).toBe(403);
  });
});

test.describe('Détail d’une dépense', () => {
  test('chaîne des corrections navigable depuis le registre ; synthèse filtrée comme la liste ; le registre ne remplace pas la comptabilité', async ({ page }) => {
    const s = unique();
    const reference = `FAC-CHAINE-${s}`;
    await loginAs(page, E2E.chefA);
    const v1 = await apiCall<{ id: string; version: number }>(page, 'POST', '/expenses', { companyId: await companyAId(page), occurredOn: civilDate(0), category: 'AUTRE', reference, amount: '200' }, { 'Idempotency-Key': randomUUID() });
    const v2 = await apiCall<{ id: string }>(page, 'POST', `/expenses/${v1.id}/correct`, { reason: 'Remise commerciale', expectedVersion: v1.version, amount: '180' }, { 'Idempotency-Key': randomUUID() });

    await page.goto(`/depenses?q=${reference}`);
    await expect(page.getByText('Le registre ne remplace pas la comptabilité et ne calcule aucune obligation fiscale.')).toBeVisible();
    // La synthèse reçoit la recherche de la liste : seule la version en vigueur est comptée.
    await expect(page.getByTestId('synthese-exploitation')).toContainText('180,000 TND');
    await expect(page.getByTestId('synthese-exploitation')).toContainText('1 écriture');
    const row = page.getByRole('table', { name: 'Registre des dépenses' }).getByRole('row').filter({ hasText: reference });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Version corrigée');

    // Détail de la version en vigueur, puis navigation dans la chaîne.
    await row.getByRole('link', { name: /détail de la dépense/ }).click();
    await expect(page).toHaveURL(new RegExp(`/depenses/${v2.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: `Autre du ${frenchDate(civilDate(0))}` })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main).toContainText('180,000 TND');
    await expect(main).toContainText('Validée');
    await expect(main).toContainText(reference);
    await main.getByRole('link', { name: 'la version précédente' }).click();
    await expect(page).toHaveURL(new RegExp(`/depenses/${v1.id}$`));
    await expect(main).toContainText('200,000 TND');
    await expect(main).toContainText('Remplacée (corrigée)');
    await expect(main.getByRole('button', { name: 'Corriger' })).toHaveCount(0);
    await main.getByRole('link', { name: 'la version corrigée' }).click();
    await expect(page).toHaveURL(new RegExp(`/depenses/${v2.id}$`));
    await expect(main.getByRole('button', { name: 'Corriger' })).toBeVisible();

    // Hors périmètre ou identifiant inconnu : introuvable, sans donnée.
    await page.goto(`/depenses/${randomUUID()}`);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Accès refusé ou élément hors de votre périmètre');
    await expect(page.getByRole('heading', { level: 1, name: /du \d{2}\/\d{2}\/\d{4}/ })).toHaveCount(0);
  });
});
