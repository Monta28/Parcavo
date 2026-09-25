import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { km } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Responsable habituel sans utilisation en cours (CDC 10.3 ; D-268) : un conducteur nommé responsable habituel
 * d'un véhicule voit les trois actions de « Mon véhicule » grisées tant que l'administrateur n'a pas activé
 * drivers.allowHabitualVehicleSubmissions ; une fois le paramètre activé depuis l'écran des paramètres, il
 * déclare un kilométrage, un ticket carburant et un problème sur ce véhicule, et le serveur les enregistre sur
 * ce véhicule sans utilisation. Le menu du conducteur mène aussi à ses documents (D-209). Véhicule, conducteur
 * et compte sont créés par l'API pour ce seul parcours ; le paramètre est remis à « Non » en fin de parcours.
 */

const SETTING_KEY = 'drivers.allowHabitualVehicleSubmissions';
const SETTING_LABEL = 'Soumissions du conducteur sur le véhicule dont il est responsable habituel (sans utilisation en cours)';
/** Photo de ticket valide (PNG 16 × 16), réduite en JPEG par le navigateur avant l'envoi. */
const TICKET_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM406FEEmIY1TCqYfhqAAB+o3YQ4nn/XQAAAABJRU5ErkJggg==', 'base64');
const ACTIONS = ['Ajouter un kilométrage', 'Ajouter un ticket carburant', 'Signaler un problème'] as const;

const unique = () => `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();

async function apiCall<T>(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function settingValue(page: Page): Promise<unknown> {
  const settings = await apiCall<Array<{ key: string; value: unknown }>>(page, 'GET', '/settings');
  return settings.find((s) => s.key === SETTING_KEY)?.value;
}

test.describe('Responsable habituel sans utilisation (D-268)', () => {
  test('actions grisées tant que le paramètre est inactif ; activé par l’administrateur, le conducteur déclare kilométrage, ticket et problème sur son véhicule', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const s = unique();
    const code = `E2E-HAB-${s}`;
    const registration = `${s.slice(-4)} TU 6868`;
    const email = `conducteur.habituel.${s.toLowerCase()}@parc-auto.test`;

    // Préparation par l'API (administrateur) : véhicule diesel au compteur initialisé, conducteur nommé
    // responsable habituel depuis deux jours, compte conducteur lié. Aucune utilisation n'est ouverte.
    await loginAs(page, E2E.admin);
    if ((await settingValue(page)) === true) await apiCall(page, 'PUT', `/settings/${SETTING_KEY}`, { value: false, reason: 'État initial du parcours responsable habituel (e2e)' });
    const companies = await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/companies?pageSize=100');
    const companyId = companies.items.find((c) => c.code === E2E.companyA)?.id as string;
    const categories = await apiCall<Array<{ id: string; code: string }> | { items: Array<{ id: string; code: string }> }>(page, 'GET', '/vehicle-categories');
    const categoryId = (Array.isArray(categories) ? categories : categories.items).find((c) => c.code === 'VP')?.id as string;
    expect(companyId && categoryId).toBeTruthy();
    const vehicle = await apiCall<{ id: string }>(page, 'POST', '/vehicles', { companyId, categoryId, code, registration, make: 'Peugeot', model: '3008', energy: 'DIESEL', tankCapacityLiters: '55' });
    await apiCall(page, 'POST', `/vehicles/${vehicle.id}/odometer-segments`, { mode: 'INITIAL', startedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), physicalKm: '30000' });
    const driver = await apiCall<{ id: string }>(page, 'POST', '/drivers', { companyId, code: `D-HAB-${s}`, firstName: 'Habib', lastName: `Habituel${s}` });
    await apiCall(page, 'POST', '/responsible-assignments', { vehicleId: vehicle.id, driverId: driver.id, startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await apiCall(page, 'POST', '/users', { email, firstName: 'Habib', lastName: `Habituel${s}`, password: E2E.password, memberships: [{ companyId, role: 'CONDUCTEUR' }], driverId: driver.id });

    const driverContext = await browser.newContext();
    const driverPage = await driverContext.newPage();
    try {
      // 1. Paramètre inactif : « Aucun véhicule remis », trois actions grisées ; le menu mène aussi aux documents.
      await loginAs(driverPage, email);
      await driverPage.goto('/mon-vehicule');
      await expect(driverPage.getByRole('heading', { level: 1, name: 'Mon véhicule' })).toBeVisible();
      await expect(driverPage.getByText('Aucun véhicule remis')).toBeVisible();
      for (const name of ACTIONS) await expect(driverPage.getByRole('button', { name, exact: true })).toBeDisabled();
      await expect(driverPage.getByText('Disponible pendant une utilisation en cours, ou sur le véhicule dont vous êtes responsable habituel si votre organisation l’autorise.')).toBeVisible();
      await expect(driverPage.getByRole('heading', { name: `${code} · ${registration}` })).toHaveCount(0);
      const nav = driverPage.getByRole('navigation', { name: 'Navigation principale' });
      await expect(nav.getByRole('link')).toHaveText(['Mon véhicule', 'Documents']);
      await nav.getByRole('link', { name: 'Documents' }).click();
      await expect(driverPage).toHaveURL(/\/documents$/);
      await expect(driverPage.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
      await expect(driverPage.getByText('Mes documents', { exact: true })).toBeVisible();
      await expect(driverPage.getByText('Aucune utilisation en cours : les documents d’un véhicule ne sont consultables que pendant son utilisation.')).toBeVisible();

      // 2. L'administrateur active le paramètre depuis l'écran des paramètres (motif obligatoire).
      await page.goto('/administration/parametres');
      await page.getByRole('main').getByLabel('Recherche').fill('responsable habituel');
      await expect(page).toHaveURL(/[?&]q=/);
      await page.getByRole('button', { name: `Modifier « ${SETTING_LABEL} »` }).click();
      const dialog = page.getByRole('dialog', { name: 'Modifier un paramètre' });
      await dialog.getByRole('combobox', { name: /Nouvelle valeur/ }).click();
      await page.getByRole('option', { name: 'Oui', exact: true }).click();
      await dialog.getByLabel('Motif *').fill('Véhicules de fonction : déclarations sans remise');
      await dialog.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
      await expect(page.getByText(new RegExp(`^${SETTING_LABEL.replace(/[()]/g, '\\$&')} : version \\d+ enregistrée\\.$`))).toBeVisible();
      await expect(page.getByRole('row').filter({ has: page.getByText(SETTING_LABEL, { exact: true }) })).toContainText('Oui');

      // 3. Le conducteur retrouve son véhicule habituel et les trois actions disponibles.
      await driverPage.goto('/mon-vehicule');
      await expect(driverPage.getByText('Aucun véhicule remis')).toBeVisible();
      const vehicleCard = driverPage.locator('[data-slot="card"]').filter({ has: driverPage.getByRole('heading', { name: `${code} · ${registration}` }) });
      await expect(vehicleCard).toContainText('Véhicule dont vous êtes responsable habituel');
      await expect(vehicleCard).toContainText(km(30_000));
      for (const name of ACTIONS) await expect(driverPage.getByRole('button', { name, exact: true })).toBeEnabled();

      // Relevé de compteur : soumission en attente de validation sur le véhicule habituel.
      await driverPage.getByRole('button', { name: 'Ajouter un kilométrage', exact: true }).click();
      const readingCard = driverPage.locator('[data-slot="card"]').filter({ has: driverPage.getByRole('heading', { name: 'Ajouter un kilométrage' }) });
      await expect(readingCard).toContainText(`${code} · ${registration}.`);
      await expect(readingCard).toContainText('véhicule dont vous êtes responsable habituel');
      await readingCard.getByLabel('Kilométrage affiché au compteur *').fill('30180');
      await readingCard.getByRole('button', { name: 'Envoyer le kilométrage' }).click();
      await expect(driverPage.getByRole('heading', { name: 'Kilométrage envoyé' })).toBeVisible();
      await expect(driverPage.getByRole('status').filter({ hasText: 'Relevé du' })).toContainText('En attente');
      await driverPage.getByRole('button', { name: 'Fermer', exact: true }).click();

      // Ticket carburant : véhicule proposé au titre de la responsabilité habituelle, photo obligatoire.
      await driverPage.getByRole('button', { name: 'Ajouter un ticket carburant', exact: true }).click();
      const fuelCard = driverPage.locator('[data-slot="card"]').filter({ has: driverPage.getByRole('heading', { name: 'Déclarer un plein' }) });
      await expect(fuelCard).toContainText(`${code} · ${registration}`);
      await expect(fuelCard).toContainText('Véhicule dont vous êtes responsable habituel');
      await fuelCard.getByLabel('Litres *').fill('32');
      await fuelCard.getByLabel(/^Montant payé/).fill('80,800');
      await fuelCard.getByRole('radio', { name: 'Plein partiel' }).click();
      await fuelCard.locator('input[type="file"]').setInputFiles({ name: 'ticket.png', mimeType: 'image/png', buffer: TICKET_PNG });
      await expect(fuelCard.getByRole('img', { name: 'Photo du ticket jointe' })).toBeVisible();
      await fuelCard.getByRole('button', { name: 'Envoyer le ticket' }).click();
      await expect(driverPage.getByRole('heading', { name: 'Ticket envoyé' })).toBeVisible();
      await driverPage.getByRole('button', { name: 'Fermer', exact: true }).click();

      // Signalement : véhicule habituel affiché en tête du formulaire, aucune utilisation rattachée.
      await driverPage.getByRole('button', { name: 'Signaler un problème', exact: true }).click();
      const reportCard = driverPage.locator('[data-slot="card"]').filter({ has: driverPage.getByRole('heading', { name: 'Signaler un problème' }) });
      await expect(reportCard).toContainText(`${code} · ${registration}`);
      await expect(reportCard).toContainText('Véhicule dont vous êtes responsable habituel');
      await reportCard.getByRole('combobox', { name: 'Type de problème *' }).click();
      await driverPage.getByRole('option', { name: 'Crevaison', exact: true }).click();
      await reportCard.getByLabel('Que se passe-t-il ? *').fill('Pneu arrière droit crevé sur le parking du siège');
      await reportCard.getByRole('button', { name: 'Envoyer le signalement' }).click();
      await expect(driverPage.getByRole('heading', { name: 'Signalement enregistré' })).toBeVisible();
      await expect(driverPage.getByRole('status').filter({ hasText: 'Crevaison' })).toContainText(`${code} · ${registration}`);
      await driverPage.getByRole('button', { name: 'Fermer', exact: true }).click();

      // 4. Côté serveur : les trois soumissions portent sur le véhicule habituel, sans utilisation.
      const readings = await apiCall<{ items: Array<{ physicalKm: string | null; status: string }> }>(page, 'GET', `/readings?vehicleId=${vehicle.id}&status=EN_ATTENTE&pageSize=100`);
      expect(readings.items.map((r) => [Number(r.physicalKm), r.status])).toEqual([[30180, 'EN_ATTENTE']]);
      const fuelEntries = await apiCall<{ items: Array<{ status: string; driverId: string | null }> }>(page, 'GET', `/fuel-entries?vehicleId=${vehicle.id}&pageSize=100`);
      expect(fuelEntries.items.map((e) => [e.status, e.driverId])).toEqual([['SOUMIS', driver.id]]);
      const incidents = await apiCall<{ items: Array<{ type: string; usageId: string | null; driverId: string | null }> }>(page, 'GET', `/incidents?vehicleId=${vehicle.id}&pageSize=100`);
      expect(incidents.items.map((i) => [i.type, i.usageId, i.driverId])).toEqual([['CREVAISON', null, driver.id]]);
    } finally {
      await driverContext.close();
      if ((await settingValue(page)) === true) await apiCall(page, 'PUT', `/settings/${SETTING_KEY}`, { value: false, reason: 'Fin du parcours responsable habituel (e2e)' });
    }
  });
});
