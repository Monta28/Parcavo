import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Mobile conducteur (CDC 10.3, 10.1, 5.1) sur un téléphone (390 × 844, tactile) : les trois actions sont
 * visibles, la page ne défile pas horizontalement, les champs photo ouvrent l'appareil photo, et hors
 * connexion l'écran l'annonce et ne prétend jamais avoir enregistré une saisie (vérifié côté serveur).
 * Conductrice du parcours carburant (utilisation en cours sur E2E-FUEL2) ; aucune donnée n'est écrite.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function totalReadings(page: Page): Promise<number> {
  const res = await page.request.get('/api/v1/readings?pageSize=1');
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { total: number }).total;
}

/** PNG valide 32×32 (photo du compteur « prise » par l'appareil, réduite en JPEG par le navigateur avant l'envoi). */
function png(size = 32): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RVB
  const rows = Buffer.concat(Array.from({ length: size }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 40 + y * 4)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Session de chef de parc dans un contexte séparé, pour décider par l'API réelle. */
async function chefSession(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, E2E.chefA);
  const csrf = (await context.cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const call = async <T>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
    expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
  return { call, close: () => context.close() };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
}

test.describe('Mobile conducteur', () => {
  test('trois actions visibles, appareil photo, pas de défilement horizontal ; hors connexion : erreur explicite et rien d’enregistré', async ({ page, context }) => {
    test.setTimeout(90_000);
    await loginAs(page, E2E.conducteurCarburant);
    await page.goto('/mon-vehicule');
    await expect(page.getByRole('heading', { level: 1, name: 'Mon véhicule' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^E2E-FUEL2 · / })).toBeVisible();

    // Les trois actions du conducteur (10.3), visibles sans menu.
    for (const name of ['Ajouter un kilométrage', 'Signaler un problème', 'Ajouter un ticket carburant']) {
      const action = page.getByRole('button', { name, exact: true }).first();
      await expect(action).toBeVisible();
      await expect(action).toBeEnabled();
    }
    await noHorizontalScroll(page);

    // Chaque saisie mobile ouvre l'appareil photo du navigateur (ticket, signalement, relevé), sans application native.
    const photoInputs = page.locator('input[type="file"]');
    for (const action of ['Ajouter un ticket carburant', 'Signaler un problème']) {
      await expect(photoInputs).toHaveCount(0);
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect(photoInputs.first()).toBeAttached();
      for (const input of await photoInputs.all()) {
        await expect(input).toHaveAttribute('accept', 'image/*');
        await expect(input).toHaveAttribute('capture', 'environment');
      }
      await noHorizontalScroll(page);
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible();
    }

    // Formulaire de kilométrage : la photo passe par l'appareil photo du navigateur.
    const before = await totalReadings(page);
    await page.getByRole('button', { name: 'Ajouter un kilométrage', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ajouter un kilométrage' })).toBeVisible();
    const photo = page.locator('input[type="file"]').first();
    await expect(photo).toHaveAttribute('accept', 'image/*');
    await expect(photo).toHaveAttribute('capture', 'environment');
    await noHorizontalScroll(page);

    // Hors connexion : bandeau et avertissement, puis échec d'envoi annoncé sans prétendre avoir enregistré.
    await context.setOffline(true);
    await expect(page.getByText('Vous êtes hors connexion.')).toBeVisible();
    await expect(page.getByText('Hors connexion : l’envoi échouera et rien ne sera enregistré.', { exact: false })).toBeVisible();
    await page.getByLabel('Kilométrage affiché au compteur *').fill('123456');
    await page.getByRole('button', { name: 'Envoyer le kilométrage' }).click();
    await expect(page.getByText('Impossible de joindre le serveur. Vérifiez votre connexion : rien n’a été enregistré.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Kilométrage envoyé' })).toHaveCount(0);
    await expect(page.getByText('la saisie est enregistrée')).toHaveCount(0);

    // Connexion rétablie : le serveur n'a reçu aucun relevé ; l'abandon de la saisie n'envoie rien.
    await context.setOffline(false);
    await expect(page.getByText('Vous êtes hors connexion.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Annuler' }).click();
    expect(await totalReadings(page)).toBe(before);
  });

  test('relevé avec photo depuis le téléphone : « En attente », puis refusé par le chef avec motif, affiché au conducteur', async ({ page, browser }) => {
    test.setTimeout(90_000);
    const chef = await chefSession(browser);
    try {
      const vehicle = (await chef.call<{ items: Array<{ id: string; code: string }> }>('GET', '/vehicles?q=E2E-FUEL2')).items.find((v) => v.code === 'E2E-FUEL2');
      expect(vehicle).toBeDefined();
      const vehicleId = (vehicle as { id: string }).id;
      const current = await chef.call<{ reading: { physicalKm: string | null; cumulativeKm: string | null } | null }>('GET', `/vehicles/${vehicleId}/odometer`);
      // Hausse très au-delà du seuil de plausibilité : la soumission reste en attente (T11).
      const km = String(Math.floor(Number(current.reading?.physicalKm ?? current.reading?.cumulativeKm ?? '10000')) + 90_000);

      await loginAs(page, E2E.conducteurCarburant);
      await page.goto('/mon-vehicule');
      await page.getByRole('button', { name: 'Ajouter un kilométrage', exact: true }).click();
      await page.getByLabel('Kilométrage affiché au compteur *').fill(km);
      await page.locator('input[type="file"]').first().setInputFiles({ name: 'compteur.png', mimeType: 'image/png', buffer: png() });
      await expect(page.getByRole('button', { name: /Retirer la photo/ })).toBeVisible();
      await page.getByRole('button', { name: 'Envoyer le kilométrage' }).click();
      const result = page.getByRole('status').filter({ hasText: 'Relevé du' });
      await expect(page.getByRole('heading', { name: 'Kilométrage envoyé' })).toBeVisible();
      await expect(result).toContainText('En attente');
      await expect(page.getByText('Le gestionnaire du parc doit le valider.', { exact: false })).toBeVisible();
      await noHorizontalScroll(page);

      // Le chef retrouve la soumission (photo jointe) et la refuse avec un motif.
      const pending = await chef.call<{ items: Array<{ id: string; physicalKm: string | null; attachmentId: string | null; version: number }> }>('GET', `/readings?vehicleId=${vehicleId}&status=EN_ATTENTE&pageSize=100`);
      const submitted = pending.items.find((r) => Number(r.physicalKm) === Number(km));
      expect(submitted, JSON.stringify(pending.items)).toBeDefined();
      expect(submitted?.attachmentId).toBeTruthy();
      await chef.call('POST', `/readings/${submitted?.id}/reject`, { expectedVersion: submitted?.version, reason: 'Photo illisible : valeur non confirmée' });

      // Le conducteur voit le refus et son motif dans « Mes soumissions ».
      await page.goto('/mon-vehicule');
      const submissions = page.getByRole('region', { name: 'Mes soumissions' });
      const item = submissions.getByRole('listitem').filter({ hasText: 'Motif du rejet' }).first();
      await expect(item).toContainText(/Refusé le \d{2}\/\d{2}\/\d{4}/);
      await expect(item).toContainText('Motif du rejet : Photo illisible : valeur non confirmée');
    } finally {
      await chef.close();
    }
  });
});
