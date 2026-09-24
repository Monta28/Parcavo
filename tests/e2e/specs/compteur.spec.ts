import { expect, type Page, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, frenchDate, km } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/** Justificatif PDF minimal (facture du remplacement de compteur), accepté par le contrôle de type réel. */
const PROOF_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1');

/** Crée un véhicule de la société du chef par le formulaire réel (aucune donnée injectée en base). */
async function createVehicle(page: Page, code: string, registration: string): Promise<void> {
  await page.goto('/vehicules/nouveau');
  await page.getByLabel('Code interne *').fill(code);
  await page.getByLabel('Immatriculation ou identifiant provisoire *').fill(registration);
  await page.getByRole('combobox', { name: 'Catégorie *' }).click();
  await page.getByRole('option', { name: 'Véhicule particulier' }).click();
  await page.getByLabel('Marque *').fill('Peugeot');
  await page.getByLabel('Modèle *').fill('Partner');
  await page.getByRole('button', { name: 'Créer le véhicule' }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${code} · `) })).toBeVisible();
}

async function addReading(page: Page, physicalKm: string, observedAt: string): Promise<void> {
  await page.getByRole('button', { name: 'Ajouter un relevé' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter un relevé' });
  await dialog.getByLabel('Valeur affichée (km) *').fill(physicalKm);
  await dialog.getByLabel('Date et heure d’observation *').fill(observedAt);
  await dialog.getByRole('button', { name: 'Enregistrer le relevé' }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Changement de compteur et affichage du compteur courant (CDC 5.3, 5.4 ; T14) : compteur physique et
 * kilométrage cumulé séparés, justificatif obligatoire, valeur / date / source / fraîcheur affichées, base du
 * compteur suivant protégée contre une correction, cumul incomplet signalé.
 */
test.describe('Compteur kilométrique : remplacement et cumul (T14)', () => {
  test('remplacement à 120 000 km par un compteur à 0 : lecture 500 = 120 500 km cumulés, compteur courant daté, sourcé et frais ; la base du nouveau compteur ne se corrige pas', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await createVehicle(page, 'E2E-CPT1', '771 TU 2026');
    await page.getByRole('tab', { name: 'Kilométrage' }).click();
    const counter = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Compteur courant' }) });
    await expect(counter).toContainText('Kilométrage inconnu : aucun relevé accepté.');
    await expect(counter).toContainText('Fraîcheur : Inconnu');

    // 1. Compteur d'origine : 100 000 km il y a 30 jours, puis 120 000 km il y a 10 jours.
    await addReading(page, '100000', `${civilDate(-30)}T08:00`);
    await addReading(page, '120000', `${civilDate(-10)}T08:00`);
    await expect(counter).toContainText(km(120_000));

    // 2. Remplacement du compteur il y a 5 jours : justificatif obligatoire, nouveau compteur à 0.
    await page.getByRole('button', { name: 'Remplacement de compteur' }).click();
    const replacement = page.getByRole('dialog', { name: 'Remplacement de compteur' });
    await expect(replacement).toContainText(`dernier relevé accepté ${km(120_000)}`);
    await replacement.getByLabel('Date du remplacement *').fill(`${civilDate(-5)}T08:00`);
    await replacement.getByLabel('Valeur affichée par le nouveau compteur (km) *').fill('0');
    await replacement.getByLabel('Motif du remplacement *').fill('Bloc compteur remplacé en atelier');
    await replacement.getByRole('button', { name: 'Enregistrer le remplacement' }).click();
    await expect(replacement.getByText('Joignez le justificatif du remplacement (photo, facture ou attestation).')).toBeVisible();
    await replacement.locator('input[type="file"]').setInputFiles({ name: 'facture-compteur.pdf', mimeType: 'application/pdf', buffer: PROOF_PDF });
    await expect(replacement.getByText('facture-compteur.pdf')).toBeVisible();
    await replacement.getByRole('button', { name: 'Enregistrer le remplacement' }).click();
    await expect(replacement).toBeHidden();
    await expect(page.getByText(`Compteur n° 2 enregistré : cumul de départ ${km(120_000)}.`)).toBeVisible();

    const segments = page.getByRole('table', { name: 'Compteurs successifs du véhicule' });
    // Colonnes : n°, période, valeur de départ, cumul de départ, dernière valeur validée, cumul, motif, justificatif.
    const closed = segments.getByRole('row').filter({ hasText: `au ${frenchDate(civilDate(-5))} 08:00` });
    await expect(closed.getByRole('cell').nth(2)).toHaveText(km(100_000));
    await expect(closed.getByRole('cell').nth(4)).toHaveText(km(120_000));
    const current = segments.getByRole('row').filter({ hasText: 'en service' });
    await expect(current.getByRole('cell').nth(2)).toHaveText(km(0));
    await expect(current.getByRole('cell').nth(3)).toHaveText(km(120_000));
    await expect(current).toContainText('Bloc compteur remplacé en atelier');
    await expect(current.getByRole('link', { name: 'Voir le justificatif' })).toBeVisible();

    // 3. Lecture de 500 sur le nouveau compteur : physique 500, cumul 120 500 (formule de 5.4).
    await addReading(page, '500', `${civilDate(-1)}T08:00`);
    await expect(counter).toContainText(km(500));
    await expect(counter).toContainText(`Cumul véhicule : ${km(120_500)}`);
    // Valeur, date d'observation, source et fraîcheur du compteur courant (5.3).
    await expect(counter).toContainText(`Manuel · Compteur affiché · compteur n° 2 · observé le ${frenchDate(civilDate(-1))} 08:00`);
    await expect(counter).toContainText(/Fraîcheur : À jour \(\d+ j\)/);
    const readings = page.getByRole('table', { name: 'Relevés du véhicule' });
    await expect(readings.getByRole('row').filter({ hasText: km(120_500) })).toContainText(km(500));

    // 4. La valeur qui a fixé la base du nouveau compteur ne se corrige pas : message de l'API, rien n'est remplacé.
    await readings.getByRole('button', { name: `Corriger le relevé E2E-CPT1 du ${frenchDate(civilDate(-10))} 08:00` }).click();
    const correction = page.getByRole('dialog', { name: 'Corriger le relevé' });
    await correction.getByLabel('Valeur physique corrigée (km) *').fill('119000');
    await correction.getByLabel('Motif de la correction *').fill('Faute de frappe sur le dernier relevé');
    await correction.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(correction.getByRole('alert').filter({ hasText: 'Correction bloquée' })).toContainText(`La valeur de ce relevé a fixé la base cumulée (${km(120_000)})`);
    await expect(correction.getByLabel('Valeur physique corrigée (km) *')).toHaveAttribute('aria-invalid', 'true');
    await correction.getByRole('button', { name: 'Annuler' }).click();
    await expect(correction).toBeHidden();
    await expect(readings.getByText('Remplacé', { exact: true })).toHaveCount(0);
    await expect(counter).toContainText(`Cumul véhicule : ${km(120_500)}`);
  });

  test('compteur initialisé sans historique connu : « cumul incomplet » signalé, jamais une distance fabriquée', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await createVehicle(page, 'E2E-CPT2', '772 TU 2026');
    await page.getByRole('tab', { name: 'Kilométrage' }).click();
    await page.getByRole('button', { name: 'Initialiser le compteur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Initialiser le compteur' });
    await dialog.getByLabel('Date d’effet *').fill(`${civilDate(-2)}T09:00`);
    await dialog.getByLabel('Valeur affichée par le compteur (km) *').fill('45000');
    await dialog.getByRole('radio', { name: 'Historique antérieur inconnu : cumul incomplet' }).click();
    await dialog.getByRole('button', { name: 'Initialiser le compteur' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Compteur initialisé : ${km(45_000)} affichés, cumul incomplet.`)).toBeVisible();
    const counter = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Compteur courant' }) });
    await expect(counter).toContainText(km(45_000));
    await expect(counter).toContainText('Cumul incomplet : historique antérieur inconnu');
    await expect(page.getByRole('table', { name: 'Compteurs successifs du véhicule' }).getByRole('row').filter({ hasText: 'en service' })).toContainText('Cumul incomplet');
  });
});
