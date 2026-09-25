import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Réception webhook d'un fournisseur télématique (CDC 14.4, 14.6 ; D-298 ; R-14.4-02, R-14.4-X01) : écran
 * d'administration (URL à communiquer, génération puis rotation du secret de signature affiché une seule
 * fois), puis lots signés HMAC-SHA256 envoyés comme le ferait le fournisseur, au travers du relais web
 * /api/v1 (octets transmis tels quels). Le module est activé pour E2E-B le temps du parcours, puis désactivé.
 * Sans worker dans la pile e2e, les lots acceptés restent « En attente » : l'ingestion est couverte par
 * les tests d'intégration de l'API et du worker.
 */

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

async function apiCall(page: Page, method: 'GET' | 'POST', path: string, data?: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<unknown>;
}

/** Lot envoyé par le « fournisseur » : aucun cookie, corps brut signé avec l'horodatage courant. */
function push(request: APIRequestContext, url: string, secret: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return request.post(url, { data: body, headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': `sha256=${signature}` } });
}

test.describe('Télématique : réception webhook signée (14.4, D-298)', () => {
  test('l’administrateur communique l’URL, génère puis fait tourner le secret de signature ; les lots signés sont acceptés et mis en file, les autres refusés', async ({ page, playwright }) => {
    test.setTimeout(120_000);
    await loginAs(page, E2E.admin);
    const companies = (await apiCall(page, 'GET', '/telemetry/companies')) as Array<{ companyId: string; code: string }>;
    const companyB = companies.find((c) => c.code === E2E.companyB);
    expect(companyB).toBeDefined();
    const companyId = (companyB as { companyId: string }).companyId;
    const supplier = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
    await apiCall(page, 'POST', `/telemetry/companies/${companyId}/enable`, { reason: 'Parcours webhook (e2e)' });
    try {
      const name = `Webhook e2e ${unique()}`;
      const created = (await apiCall(page, 'POST', '/telemetry/providers', { name, kind: 'WEBHOOK_GENERIQUE', companyIds: [companyId] })) as { id: string };

      // Fiche du fournisseur : URL de réception, aucun secret, aucune synchronisation manuelle.
      await page.goto(`/administration/telematique?fournisseur=${created.id}`);
      await expect(page.getByRole('heading', { name: /Réception webhook/ }).or(page.getByText('Réception webhook', { exact: true })).first()).toBeVisible();
      const urlField = page.getByLabel(/URL à communiquer au fournisseur/);
      const expectedUrl = `${new URL(page.url()).origin}/api/v1/telemetry/webhooks/${created.id}`;
      await expect(urlField).toHaveValue(expectedUrl);
      await expect(urlField).toHaveAttribute('readonly', '');
      await expect(page.getByText('Aucun secret de signature : tout lot est refusé (401)', { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Synchroniser maintenant' })).toHaveCount(0);

      // Génération : secret affiché une seule fois (lecture seule), enregistrement après confirmation.
      await page.getByRole('button', { name: 'Générer le secret de signature' }).click();
      const dialog = page.getByRole('dialog', { name: 'Secret de signature du webhook' });
      const secretField = dialog.getByLabel('Secret généré');
      await expect(secretField).toHaveAttribute('readonly', '');
      const secret = await secretField.inputValue();
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      const save = dialog.getByRole('button', { name: 'Enregistrer le secret' });
      await expect(save).toBeDisabled();
      await dialog.getByLabel('J’ai copié ce secret pour le transmettre au fournisseur.').check();
      await save.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(/Configuré le .* ; jamais réaffiché \(chiffré au repos\)\./)).toBeVisible();
      expect(await page.content()).not.toContain(secret);

      // Lot signé refusé tant que le fournisseur n'est pas actif (422), puis activation.
      const declare = JSON.stringify({ version: 1, units: [{ externalId: 'E2E-U1', label: 'Boîtier E2E', registration: '201 TU 2026' }] });
      const inactive = await push(supplier, expectedUrl, secret, declare);
      expect(inactive.status()).toBe(422);
      expect(((await inactive.json()) as { code: string }).code).toBe('FOURNISSEUR_INACTIF');
      await page.getByRole('button', { name: 'Activer', exact: true }).click();
      const activation = page.getByRole('dialog', { name: new RegExp(`Activer le fournisseur ${name}`) });
      await activation.getByRole('button', { name: 'Activer', exact: true }).click();
      await expect(activation).toBeHidden();

      // Lots poussés au travers du relais web : signés → 202 ; faux secret ou sans signature → 401.
      const accepted = await push(supplier, expectedUrl, secret, declare);
      expect(accepted.status(), await accepted.text()).toBe(202);
      expect(await accepted.json()).toMatchObject({ status: 'EN_ATTENTE', units: 1, odometers: 0, fuel: 0 });
      expect((await push(supplier, expectedUrl, `whsec_${'x'.repeat(43)}`, declare)).status()).toBe(401);
      const unsigned = await supplier.post(expectedUrl, { data: declare, headers: { 'Content-Type': 'application/json' } });
      expect(unsigned.status()).toBe(401);
      expect(((await unsigned.json()) as { code: string }).code).toBe('SIGNATURE_ABSENTE');

      await page.reload();
      const row = page.getByRole('row', { name: /1 unité\(s\), 0 kilométrage\(s\), 0 carburant/ });
      await expect(row).toBeVisible();
      await expect(row.getByText('En attente')).toBeVisible();

      // Rotation : nouveau secret, l'ancien reste accepté pendant le recouvrement.
      await page.getByRole('button', { name: 'Générer un nouveau secret (rotation)' }).click();
      const rotation = page.getByRole('dialog', { name: 'Rotation du secret de signature' });
      await expect(rotation.getByText(/L’ancien secret reste accepté pendant 24 h/)).toBeVisible();
      const rotated = await rotation.getByLabel('Secret généré').inputValue();
      expect(rotated).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(rotated).not.toBe(secret);
      await rotation.getByLabel('J’ai copié ce secret pour le transmettre au fournisseur.').check();
      await rotation.getByRole('button', { name: 'Enregistrer le secret' }).click();
      await expect(rotation).toBeHidden();
      await expect(page.getByText(/Ancien secret encore accepté jusqu’au .* \(recouvrement de 24 h\)\./)).toBeVisible();
      const later = (km: string) => JSON.stringify({ version: 1, odometers: [{ unitExternalId: 'E2E-U1', kind: 'COMPTEUR_CAN', valueKm: km, observedAt: new Date(Date.now() - 60_000).toISOString() }] });
      expect((await push(supplier, expectedUrl, rotated, later('1000'))).status()).toBe(202);
      expect((await push(supplier, expectedUrl, secret, later('1001'))).status()).toBe(202);
      await page.reload();
      await expect(page.getByRole('row', { name: /1 unité\(s\), 1 kilométrage\(s\), 0 carburant/ })).toHaveCount(2);
      expect(await page.content()).not.toContain(rotated);
    } finally {
      await apiCall(page, 'POST', `/telemetry/companies/${companyId}/disable`, { reason: 'Fin du parcours webhook (e2e)' });
      await supplier.dispose();
    }
  });
});
