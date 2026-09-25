import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * /tableau-de-bord et /rapports (CDC 10.2, 11.1, 11.2) contre la pile réelle : une tuile ouvre une liste
 * justificative de même total (écran de liste ou panneau de la route de l'API), le filtre par véhicule
 * restreint indicateurs et listes, un rapport filtré s'exporte en CSV téléchargé avec ses métadonnées, et
 * la fiche du véhicule s'imprime par le navigateur (styles d'impression, PDF de Chromium).
 * Le véhicule du parcours est créé par l'API réelle (société E2E-A), sans toucher aux véhicules des autres specs.
 */

/** Suffixe unique par test : la base n'est réinitialisée qu'une fois (setup global). */
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();

async function apiCall<T>(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface Created {
  id: string;
  code: string;
  registration: string;
}

/** Véhicule actif neuf de la société E2E-A : disponible, sans relevé (kilométrage inconnu). */
async function createVehicle(page: Page): Promise<Created> {
  const s = unique();
  const companies = await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/companies?pageSize=100');
  const categories = await apiCall<{ items: Array<{ id: string; code: string }> } | Array<{ id: string; code: string }>>(page, 'GET', '/vehicle-categories?pageSize=100');
  const categoryList = Array.isArray(categories) ? categories : categories.items;
  const companyId = companies.items.find((c) => c.code === E2E.companyA)?.id;
  const categoryId = categoryList.find((c) => c.code === 'VP')?.id;
  expect(companyId && categoryId).toBeTruthy();
  const vehicle = await apiCall<Created>(page, 'POST', '/vehicles', { companyId, categoryId, code: `TB-${s}`, registration: `${s} TU 77`, make: 'Dacia', model: 'Duster' });
  return { id: vehicle.id, code: vehicle.code, registration: vehicle.registration };
}

/** Tuile d'indicateur par son libellé (titre de niveau 3). */
function tile(page: Page, label: string): Locator {
  return page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { level: 3, name: label, exact: true }) }).first();
}

/** Valeur entière affichée par une tuile (espaces fines de milliers retirées). */
async function tileValue(card: Locator): Promise<number> {
  const text = await card.locator('p span.tabular-nums').first().innerText();
  return Number(text.replace(/\s/g, ''));
}

test.describe('Tableau de bord et rapports', () => {
  test('une tuile ouvre une liste de même total ; le filtre par véhicule restreint indicateurs et listes justificatives', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, E2E.admin);
    const vehicle = await createVehicle(page);

    // Vue consolidée : « Parc actif » ouvre l'écran des véhicules actifs, dont le total est celui de la tuile.
    await page.goto('/tableau-de-bord');
    await expect(page.getByRole('heading', { level: 1, name: 'Tableau de bord' })).toBeVisible();
    // Écran attendu (10.2) : indicateurs, alertes prioritaires, retours attendus et actions rapides.
    for (const section of ['État du parc', 'Points de vigilance', 'Alertes prioritaires', 'Retours attendus', 'Actions rapides']) {
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Nouvelle remise' })).toBeVisible();
    const activeTile = tile(page, 'Parc actif');
    await expect(activeTile).toBeVisible();
    const active = await tileValue(activeTile);
    expect(active).toBeGreaterThan(0);
    await activeTile.getByRole('link', { name: 'Voir la liste : Parc actif' }).click();
    await expect(page).toHaveURL(/\/vehicules\?.*lifecycle=ACTIF/);
    await expect(page.getByText(new RegExp(`^\\d+–\\d+ sur ${active}$`))).toBeVisible();

    // Filtre par véhicule (11.1) : conservé dans l'URL, calculé par l'API.
    await page.goto('/tableau-de-bord');
    await page.getByRole('combobox', { name: 'Filtrer sur un véhicule' }).click();
    await page.getByPlaceholder('Code, immatriculation, marque…').fill(vehicle.code);
    await page.getByRole('option', { name: new RegExp(vehicle.code) }).click();
    await expect(page).toHaveURL(new RegExp(`vehicule=${vehicle.id}`));
    await expect(page.getByText('Tous les indicateurs, compteurs et listes justificatives portent sur ce seul véhicule.')).toBeVisible();
    await expect.poll(async () => tileValue(tile(page, 'Parc actif'))).toBe(1);
    expect(await tileValue(tile(page, 'Disponibles'))).toBe(1);
    // Aucun indicateur opaque (11.1) : numérateur, dénominateur, horodatage d'un état ou période d'un flux, définition.
    await expect(tile(page, 'Disponibles')).toContainText('sur 1 véhicules actifs');
    await expect(tile(page, 'Disponibles')).toContainText(/au \d{2}\/\d{2}\/\d{4}/);
    await expect(tile(page, 'Interventions terminées')).toContainText(/du \d{2}\/\d{2}\/\d{4} au \d{2}\/\d{2}\/\d{4}/);
    await tile(page, 'Disponibles').getByText('Définition et source').click();
    await expect(tile(page, 'Disponibles')).toContainText('Véhicules actifs ni immobilisés ni en utilisation.');
    expect(await tileValue(tile(page, 'Hors service'))).toBe(0);
    const unknownTile = tile(page, 'Kilométrage inconnu');
    expect(await tileValue(unknownTile)).toBe(1);

    // Liste justificative sans écran équivalent : panneau alimenté par la route de l'API, même total.
    await unknownTile.getByRole('button', { name: 'Voir la liste : Kilométrage inconnu' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kilométrage inconnu' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/vehicleId=/)).toBeVisible();
    await expect(sheet.getByRole('link', { name: vehicle.code })).toBeVisible();
    await expect(sheet.getByRole('row')).toHaveCount(2);
    await expect(sheet.getByText('1–1 sur 1')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // Liste justificative avec écran : l'écran reçoit le même filtre véhicule.
    await tile(page, 'Entretiens urgents').getByRole('link', { name: 'Voir la liste : Entretiens urgents' }).click();
    await expect(page).toHaveURL(new RegExp(`/entretiens\\?.*urgent=1.*vehicule=${vehicle.id}|/entretiens\\?.*vehicule=${vehicle.id}.*urgent=1`));

    // Filtre retiré : retour à la vue consolidée.
    await page.goto(`/tableau-de-bord?vehicule=${vehicle.id}`);
    await page.getByRole('button', { name: 'Retirer le filtre véhicule' }).click();
    await expect(page).not.toHaveURL(/vehicule=/);
    await expect.poll(async () => tileValue(tile(page, 'Parc actif'))).toBe(active);
  });

  test('rapport filtré exporté en CSV (métadonnées, filtres, fuseau) et fiche du véhicule imprimable par le navigateur', async ({ page }) => {
    test.setTimeout(120_000);
    // Compte les appels à l'impression du navigateur sans les remplacer (l'impression réelle est appelée).
    await page.addInitScript(() => {
      const w = window as unknown as { print: () => void; __printCalls: number };
      const original = w.print.bind(window);
      w.__printCalls = 0;
      w.print = () => {
        w.__printCalls += 1;
        original();
      };
    });
    await loginAs(page, E2E.admin);
    const vehicle = await createVehicle(page);

    // Rapport « Inventaire du parc », recherche sur le véhicule du parcours : une ligne, puis export CSV.
    await page.goto(`/rapports?rapport=inventaire&vue=vehicules&q=${encodeURIComponent(vehicle.code)}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Rapports' })).toBeVisible();
    await expect(page.getByRole('cell', { name: vehicle.code, exact: true })).toBeVisible();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exporter CSV' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const csv = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Rapport;Inventaire du parc — Véhicules');
    expect(lines).toContain(`Filtre — Recherche;${vehicle.code}`);
    expect(lines.find((l) => l.startsWith('Généré le;'))).toMatch(/\(Africa\/Tunis\)$/);
    expect(lines).toContain('Lignes;1');
    const dataLines = lines.filter((l) => l.includes(vehicle.code) && !l.startsWith('Filtre'));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain(vehicle.registration);
    await expect(page.getByText(/Export téléchargé/)).toBeVisible();

    // Fiche imprimable depuis le dossier du véhicule.
    await page.goto(`/vehicules/${vehicle.id}`);
    await page.getByRole('link', { name: 'Fiche imprimable' }).click();
    await expect(page).toHaveURL(new RegExp(`/vehicules/${vehicle.id}/fiche`));
    const heading = page.getByRole('heading', { level: 1, name: `Fiche véhicule ${vehicle.code} · ${vehicle.registration}` });
    await expect(heading).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Identité' })).toBeVisible();
    await expect(page.getByText('Kilométrage inconnu : aucun relevé accepté.')).toBeVisible();
    await page.getByRole('button', { name: 'Imprimer' }).click();
    expect(await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(1);

    // Rendu d'impression : navigation et boutons masqués, fiche visible ; PDF produit par Chromium.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Retour au dossier' })).toBeHidden();
    await expect(heading).toBeVisible();
    const pdf = await page.pdf({ format: 'A4', printBackground: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
    await page.emulateMedia({ media: 'screen' });
    await expect(page.getByRole('button', { name: 'Imprimer' })).toBeVisible();
  });
});
