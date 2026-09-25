import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/** Photo de ticket fictive (PNG 16 × 16), réencodée en JPEG par le navigateur avant le téléversement. */
const TICKET_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM406FEEmIY1TCqYfhqAAB+o3YQ4nn/XQAAAABJRU5ErkJggg==', 'base64');

/** Espace conducteur mobile d'abord (CDC 10.3) : largeur d'un téléphone. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Valeur d'un champ datetime-local : jour local (Africa/Tunis) d'il y a `daysAgo` jours, à l'heure donnée. */
function localDateTime(daysAgo: number, hour: number): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - daysAgo * 86_400_000));
  return `${day}T${String(hour).padStart(2, '0')}:00`;
}

/** Aucun défilement horizontal de la page (lisibilité sur téléphone). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe('Carburant', () => {
  test('le chef saisit un plein avec anomalies : avertissements de l’API, confirmation de la capacité, consommation N/D motivée puis 12,5 L/100 km (T25)', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await page.goto('/carburant');
    await expect(page.getByRole('heading', { level: 1, name: 'Carburant' })).toBeVisible();
    await page.getByRole('link', { name: 'Saisir un plein' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Saisir un plein' })).toBeVisible();

    // Contrôles de saisie avant l'envoi : champs obligatoires signalés à côté des champs.
    await page.getByRole('button', { name: 'Enregistrer le plein' }).click();
    await expect(page.getByText('Choisissez le véhicule.')).toBeVisible();
    await expect(page.getByText('Indiquez si le plein est complet ou partiel.')).toBeVisible();

    await page.getByRole('combobox', { name: 'Véhicule *' }).click();
    await page.getByRole('combobox', { name: 'Rechercher un véhicule' }).fill('E2E-FUEL1');
    await page.getByRole('option', { name: /E2E-FUEL1/ }).click();
    await expect(page.getByRole('combobox', { name: 'Véhicule *' })).toContainText('E2E-FUEL1 · 301 TU 2026');
    // Plein A du scénario T25, trois jours avant les deux pleins suivants (chronologie des relevés).
    await page.getByLabel('Date et heure du plein *').fill(localDateTime(3, 8));
    await page.getByLabel('Kilométrage au compteur').fill('15000');
    // 60 L dans un réservoir de 50 L ; 60 × 2,525 = 151,500 ≠ 160,000 : deux anomalies signalées par l'API.
    await page.getByLabel('Litres *').fill('60');
    await page.getByLabel(/^Prix unitaire TTC/).fill('2,525');
    await page.getByLabel(/^Montant total TTC/).fill('160,000');
    await page.getByRole('radio', { name: 'Plein complet' }).click();
    await page.getByRole('button', { name: 'Enregistrer le plein' }).click();

    await expect(page.getByRole('heading', { name: 'Plein enregistré' })).toBeVisible();
    const warnings = page.getByRole('status').filter({ hasText: 'Avertissements du serveur' });
    await expect(warnings).toContainText('Écart entre litres × prix unitaire et montant total : 8,500 TND');
    await expect(warnings).toContainText('Litres supérieurs à la capacité du réservoir');
    await expect(warnings).toContainText('Capacité du réservoir dépassée : exclu tant que le chef de parc n’a pas confirmé.');

    await page.getByRole('link', { name: 'Voir le plein' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Plein du / })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Validé', { exact: true })).toBeVisible();
    await expect(main.getByText('Écart montant', { exact: true })).toBeVisible();
    await expect(main.getByText('Capacité dépassée', { exact: true })).toBeVisible();
    await expect(main.getByText('160,000 TND')).toBeVisible();
    await expect(main.getByText('Accepté', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Confirmer la capacité' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmer la capacité' });
    await dialog.getByRole('button', { name: 'Confirmer les litres' }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByText('Capacité confirmée', { exact: true })).toBeVisible();
    await expect(main.getByText('Admissible au calcul de consommation.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmer la capacité' })).toHaveCount(0);
    await page.reload();
    await expect(main.getByText('Capacité confirmée', { exact: true })).toBeVisible();

    // Onglet « Carburant » du dossier véhicule (CDC 3.2) : pleins du véhicule, et un seul plein complet,
    // donc consommation N/D motivée par l'API (jamais un chiffre).
    await main.getByRole('link', { name: 'E2E-FUEL1 · 301 TU 2026' }).click();
    await expect(page).toHaveURL(/\/vehicules\/[0-9a-f-]+$/);
    const vehicleUrl = page.url();
    await page.getByRole('tab', { name: 'Carburant' }).click();
    const entriesTable = page.getByRole('table', { name: 'Pleins du véhicule' });
    await expect(entriesTable.getByRole('row').filter({ hasText: '60 L' })).toContainText('Capacité confirmée');
    await expect(page.getByText('Estimation fondée sur les pleins saisis, pas une mesure télématique.')).toBeVisible();
    await expect(page.getByText('N/D', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Aucun plein complet validé de référence avant ce plein.').first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Intervalles de consommation' }).getByRole('cell', { name: '60 L' })).toBeVisible();

    // T25 : plein partiel intermédiaire de 20 L puis plein complet B de 30 L, 400 km après A.
    await page.getByRole('link', { name: 'Saisir un plein' }).click();
    await expect(page.getByRole('combobox', { name: 'Véhicule *' })).toContainText('E2E-FUEL1 · 301 TU 2026');
    await page.getByLabel('Date et heure du plein *').fill(localDateTime(2, 8));
    await page.getByLabel('Kilométrage au compteur').fill('15200');
    await page.getByLabel('Litres *').fill('20');
    await page.getByLabel(/^Montant total TTC/).fill('50,500');
    await page.getByRole('radio', { name: 'Plein partiel' }).click();
    await page.getByRole('button', { name: 'Enregistrer le plein' }).click();
    await expect(page.getByRole('heading', { name: 'Plein enregistré' })).toBeVisible();
    await page.getByRole('button', { name: 'Saisir un autre plein' }).click();
    await expect(page.getByRole('combobox', { name: 'Véhicule *' })).toContainText('E2E-FUEL1 · 301 TU 2026');
    await page.getByLabel('Date et heure du plein *').fill(localDateTime(1, 8));
    await page.getByLabel('Kilométrage au compteur').fill('15400');
    await page.getByLabel('Litres *').fill('30');
    await page.getByLabel(/^Montant total TTC/).fill('75,750');
    await page.getByRole('radio', { name: 'Plein complet' }).click();
    await page.getByRole('button', { name: 'Enregistrer le plein' }).click();
    await expect(page.getByRole('heading', { name: 'Plein enregistré' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Avertissements du serveur' })).toHaveCount(0);

    await page.goto(vehicleUrl);
    await page.getByRole('tab', { name: 'Carburant' }).click();
    await expect(entriesTable.getByRole('row')).toHaveCount(4);
    // Consommation calculée par l'API : 50 L / 400 km × 100 = 12,5 L/100 km (le carburant de A est exclu).
    await expect(page.getByText('12,5 L/100 km').first()).toBeVisible();
    await expect(page.getByText('50 L sur 400 km')).toBeVisible();
    const intervals = page.getByRole('table', { name: 'Intervalles de consommation' });
    const retained = intervals.getByRole('row').filter({ hasText: '12,5 L/100 km' });
    await expect(retained).toHaveCount(1);
    await expect(retained).toContainText('Retenu');
    await expect(retained).toContainText('400 km');
    await expect(retained).toContainText('50 L');
    const excluded = intervals.getByRole('row').filter({ hasText: 'Exclu' });
    await expect(excluded).toHaveCount(1);
    await expect(excluded).toContainText('Aucun plein complet validé de référence avant ce plein.');
  });

  test('le conducteur déclare un plein depuis Mon véhicule ; le chef le voit en attente, le valide, et une seconde validation est refusée', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await loginAs(page, E2E.conducteurCarburant);
    await page.goto('/mon-vehicule');
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Ajouter un ticket carburant' }).click();
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Déclarer un plein' }) });
    await expect(card).toContainText('E2E-FUEL2 · 302 TU 2026');
    await expect(card).toContainText('Utilisation en cours');

    // Photo du ticket obligatoire : refus local avant tout envoi.
    await card.getByLabel('Litres *').fill('30');
    await card.getByLabel(/^Montant payé/).fill('80');
    await card.getByLabel(/^Prix au litre/).fill('2,525');
    await card.getByLabel('Kilométrage au compteur').fill('41250');
    await card.getByRole('radio', { name: 'Plein complet' }).click();
    await card.getByRole('button', { name: 'Envoyer le ticket' }).click();
    await expect(card.getByText('Prenez le ticket en photo.')).toBeVisible();

    await card.locator('input[type="file"]').setInputFiles({ name: 'ticket.png', mimeType: 'image/png', buffer: TICKET_PNG });
    await expect(card.getByRole('img', { name: 'Photo du ticket jointe' })).toBeVisible();

    // Relance après une coupure (D-267, CDC 8.4) : le serveur enregistre la soumission mais la réponse se perd.
    // L'écran n'annonce aucun succès ; le nouvel envoi réutilise la même clé et le serveur rejoue sa réponse.
    let responseDropped = false;
    await page.route('**/api/v1/fuel-entries', async (route) => {
      if (route.request().method() !== 'POST' || responseDropped) return route.fallback();
      responseDropped = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await card.getByRole('button', { name: 'Envoyer le ticket' }).click();
    const lost = card.getByRole('alert').filter({ hasText: 'Le nouvel envoi réutilise la même clé' });
    await expect(lost).toContainText('Impossible de joindre le serveur');
    await expect(page.getByRole('heading', { name: 'Ticket envoyé' })).toHaveCount(0);
    expect(responseDropped).toBe(true);
    await page.unroute('**/api/v1/fuel-entries');
    await card.getByRole('button', { name: 'Envoyer le ticket' }).click();
    await expect(page.getByRole('heading', { name: 'Ticket envoyé' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Plein du' })).toContainText('Soumis (à valider)');

    const declarations = page.getByRole('region', { name: 'Mes déclarations de plein' });
    // Une seule déclaration malgré les deux envois.
    await expect(declarations.getByRole('listitem')).toHaveCount(1);
    await expect(declarations).toContainText('30 L · 80,000 TND');
    await expect(declarations).toContainText('Soumis (à valider)');
    await expect(declarations).toContainText('En attente de validation par le gestionnaire du parc.');
    await expectNoHorizontalScroll(page);
    // L'écran de gestion /carburant n'est pas proposé au conducteur : renvoi vers son espace.
    await page.goto('/carburant');
    await expect(page.getByText('Écran réservé au personnel du parc')).toBeVisible();
    await expect(page.getByText(/attend(ent)? une validation/)).toHaveCount(0);
    await logout(page);

    // Le chef voit la soumission en attente dans la liste filtrée, avec les anomalies signalées par l'API.
    await page.setViewportSize(DESKTOP);
    await loginAs(page, E2E.chefA);
    await page.goto('/carburant');
    await expect(page.getByText('1 ticket conducteur attend une validation.')).toBeVisible();
    await page.getByRole('button', { name: 'Afficher les pleins à valider' }).click();
    await expect(page).toHaveURL(/statut=SOUMIS/);
    const row = page.getByRole('row').filter({ hasText: 'E2E-FUEL2 · 302 TU 2026' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Soumis (à valider)');
    await expect(row).toContainText('Écart montant');
    await expect(row).toContainText('Compteur à valider');
    await row.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: /^Plein du / })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ouvrir le ticket' })).toBeVisible();

    // Second onglet ouvert sur la même soumission avant la validation (vue devenue obsolète).
    const stale = await page.context().newPage();
    await stale.goto(page.url());
    await expect(stale.getByRole('button', { name: 'Valider', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    const validate = page.getByRole('dialog', { name: 'Valider le plein' });
    // L'écart signalé exige une confirmation explicite (D-224).
    await validate.getByRole('button', { name: 'Valider le plein' }).click();
    await expect(validate.getByText('Cochez la confirmation de l’écart signalé.')).toBeVisible();
    await validate.getByRole('checkbox', { name: /Je confirme l’écart signalé/ }).click();
    await validate.getByRole('button', { name: 'Valider le plein' }).click();
    await expect(validate).toBeHidden();
    const main = page.getByRole('main');
    await expect(main.getByText('Validé', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Valider', exact: true })).toHaveCount(0);

    // Le même plein validé une seconde fois (autre onglet, autre clé) : refus de l'API affiché, aucune seconde dépense.
    await stale.getByRole('button', { name: 'Valider', exact: true }).click();
    const staleDialog = stale.getByRole('dialog', { name: 'Valider le plein' });
    await staleDialog.getByRole('checkbox', { name: /Je confirme l’écart signalé/ }).click();
    await staleDialog.getByRole('button', { name: 'Valider le plein' }).click();
    await expect(staleDialog.getByRole('alert').filter({ hasText: 'Ce plein est déjà validé : sa dépense existe déjà.' })).toBeVisible();
    await stale.close();

    // Lien direct vers la dépense de synthèse : son détail renvoie à ce plein.
    const fuelPath = new URL(page.url()).pathname;
    await page.getByRole('link', { name: 'Dépense de synthèse', exact: true }).click();
    await expect(page).toHaveURL(/\/depenses\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: /^Carburant du \d{2}\/\d{2}\/\d{4}$/ })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('80,000 TND');
    await expect(page.getByRole('main').getByRole('link', { name: 'Synthèse d’un plein' })).toHaveAttribute('href', fuelPath);
    await page.goto(fuelPath);

    // T24 : une seule dépense de synthèse pour ce plein au registre (pas de double comptage).
    await page.getByRole('link', { name: 'voir au registre des dépenses' }).click();
    await expect(page).toHaveURL(/\/depenses\?.*source=PLEIN/);
    const register = page.getByRole('table', { name: 'Registre des dépenses' });
    const fuelExpenses = register.getByRole('row').filter({ hasText: 'Synthèse d’un plein' });
    await expect(fuelExpenses).toHaveCount(1);
    await expect(fuelExpenses).toContainText('E2E-FUEL2');
    await expect(fuelExpenses).toContainText('80,000 TND');

    // La liste ne présente plus de soumission en attente pour ce véhicule.
    await page.goto('/carburant?statut=SOUMIS');
    await expect(page.getByText('Aucun plein', { exact: true })).toBeVisible();
    await logout(page);

    // Le conducteur voit sa déclaration validée dans « Mes déclarations de plein ».
    await page.setViewportSize(PHONE);
    await loginAs(page, E2E.conducteurCarburant);
    await page.goto('/mon-vehicule');
    await expect(page.getByRole('region', { name: 'Mes déclarations de plein' })).toContainText('Validé');
  });
});
