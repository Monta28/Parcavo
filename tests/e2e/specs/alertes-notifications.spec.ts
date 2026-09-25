import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { logout } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Centre d'alertes (CDC 9.1, 10.2 : lecture, responsable et action de résolution) et canal e-mail sans
 * SMTP (CDC 9.4 : « Canal e-mail non configuré », jamais de succès d'envoi fictif). La pile e2e tourne sans
 * serveur SMTP. Véhicule neuf créé pour le parcours : aucune alerte d'un autre parcours n'est modifiée.
 */

async function apiCall<T>(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const unique = () => Date.now().toString(36).slice(-5).toUpperCase();

test.describe('Centre d’alertes et canal e-mail', () => {
  test('incident critique : l’alerte affiche son responsable de suivi et mène à l’action ; résolue à la prise en charge', async ({ page }) => {
    test.setTimeout(120_000);
    const s = unique();
    const code = `AL-${s}`;
    await loginAs(page, E2E.admin);
    const companies = await apiCall<{ items: Array<{ id: string; code: string }> }>(page, 'GET', '/companies?pageSize=100');
    const categories = await apiCall<{ items: Array<{ id: string; code: string }> } | Array<{ id: string; code: string }>>(page, 'GET', '/vehicle-categories?pageSize=100');
    const categoryId = (Array.isArray(categories) ? categories : categories.items).find((c) => c.code === 'VP')?.id;
    const companyId = companies.items.find((c) => c.code === E2E.companyA)?.id;
    const vehicle = await apiCall<{ id: string }>(page, 'POST', '/vehicles', { companyId, categoryId, code, registration: `${s} TU 88`, make: 'Renault', model: 'Clio' });
    const chef = (await apiCall<{ items: Array<{ id: string; email: string }> }>(page, 'GET', `/users?q=${encodeURIComponent(E2E.chefA)}`)).items.find((u) => u.email === E2E.chefA);
    expect(chef).toBeTruthy();
    const incident = await apiCall<{ id: string; version: number; reference: string }>(page, 'POST', '/incidents', { vehicleId: vehicle.id, type: 'PANNE', severity: 'CRITIQUE', description: `Voyant moteur rouge ${s}`, followUpUserId: chef?.id });
    await logout(page);

    // Le chef de parc voit l'alerte, son responsable (lui-même) et le lien vers l'action utile.
    await loginAs(page, E2E.chefA);
    await page.goto(`/alertes?q=${code}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Alertes' })).toBeVisible();
    const item = page.getByRole('listitem', { name: `Incident critique non traité — ${code}` });
    await expect(item).toContainText('Critique');
    await expect(item).toContainText('Active');
    await expect(item).toContainText('Non lue');
    await expect(item).toContainText('responsable : Chaima Chef');
    await expect(item).toContainText(`${incident.reference} : Voyant moteur rouge ${s}`);
    // Date de déclenchement dans le fuseau du groupe, jamais un horodatage ISO brut.
    await expect(item).toContainText(/déclenchée le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    await expect(item).not.toContainText(/\d{4}-\d{2}-\d{2}T/);

    // « Lue » ne résout rien : l'alerte reste active.
    await item.getByRole('button', { name: `Marquer comme lue : Incident critique non traité — ${code}` }).click();
    await expect(item).toContainText('Lue');
    await expect(item).toContainText('Active');

    // Action de résolution : le titre mène à l'incident ; sa prise en charge résout l'alerte.
    await item.getByRole('link', { name: `Incident critique non traité — ${code}` }).click();
    await expect(page).toHaveURL(new RegExp(`/incidents/${incident.id}$`));
    await apiCall(page, 'POST', `/incidents/${incident.id}/transition`, { to: 'EN_TRAITEMENT', expectedVersion: incident.version });
    await page.goto(`/alertes?q=${code}`);
    await expect(page.getByRole('listitem', { name: `Incident critique non traité — ${code}` })).toHaveCount(0);
    await page.goto(`/alertes?q=${code}&statut=RESOLUE`);
    const resolved = page.getByRole('listitem', { name: `Incident critique non traité — ${code}` });
    await expect(resolved).toContainText('Résolue');
    await expect(resolved).toContainText('responsable : Chaima Chef');
    await expect(resolved).toContainText(/Résolue le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} — incident pris en charge/);

    // Une alerte sans responsable l'annonce honnêtement.
    await page.goto('/alertes?q=E2E-AL1');
    await expect(page.getByRole('listitem', { name: 'Kilométrage inconnu — E2E-AL1' })).toContainText('responsable : Non attribué');
  });

  test('sans SMTP : « Canal e-mail non configuré » pour l’administrateur et dans les préférences, file vide, aucun envoi annoncé', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await page.goto('/administration/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Canal e-mail non configuré', { exact: true })).toBeVisible();
    await expect(main.getByText('Sans serveur SMTP, aucun e-mail n’est mis en file ni envoyé.', { exact: false })).toBeVisible();
    await expect(main.getByText('Canal e-mail configuré', { exact: true })).toHaveCount(0);
    // Compteurs exacts de l'outbox : rien en file, rien d'envoyé.
    for (const label of ['En attente', 'Envoyé', 'Échec (nouvelle tentative prévue)', 'Abandonné']) {
      await expect(main.locator('dl div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('0');
    }
    await expect(main).toContainText('dernier envoi réussi : aucun');
    const status = await apiCall<{ emailChannelConfigured: boolean; message: string }>(page, 'GET', '/notifications/status');
    expect(status).toMatchObject({ emailChannelConfigured: false, message: 'Canal e-mail non configuré' });
    await logout(page);

    // Le chef de parc le voit aussi dans ses préférences ; l'enregistrement des préférences reste possible.
    await loginAs(page, E2E.chefA);
    await page.goto('/profil/notifications');
    await expect(page.getByRole('main').getByText('Canal e-mail non configuré', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('Canal e-mail configuré', { exact: true })).toHaveCount(0);
  });
});
