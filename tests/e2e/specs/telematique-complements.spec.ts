import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { km, wallTime } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/**
 * Télématique côté navigateur (CDC 5.6, 8.5, 14.4 ; R-5.6-17, R-8.5-X01, R-14.4-08, R-8.5-07) contre la pile
 * réelle : un fournisseur Traccar de test (serveur HTTP local du parcours, formats de l'API REST Traccar 6)
 * alimente l'API par une synchronisation manuelle (ingestion réelle, sans worker). Le parcours vérifie l'aide
 * télématique de la remise et de la restitution (valeur enregistrée = valeur saisie), la remise et la
 * restitution pendant une panne du fournisseur, le renvoi des pages carburant vers les événements
 * télématiques du véhicule et leur qualification par le chef, puis les seuils carburant propres au véhicule.
 * Le module est activé pour E2E-A le temps du parcours, puis désactivé.
 */

const TOKEN = `jeton-lecture-e2e-${Date.now().toString(36)}`;
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();

/**
 * Faux serveur Traccar : appareil 7 ; positions émises à partir d'un instant choisi par le parcours (après
 * l'association du boîtier), une par seconde ; panne simulable.
 */
class TraccarTestServer {
  failing = false;
  private readonly server: Server = createServer((req, res) => this.handle(req, res));
  private positions: Array<Record<string, unknown>> = [];

  /** Positions à partir de `origin` : baisse de 12 L moteur coupé, véhicule à l'arrêt (seuil de la société : 10 L ou 5 %). */
  emitFrom(origin: number): number {
    const at = (second: number) => new Date(origin + second * 1000).toISOString();
    const levels: Array<[number, number, number]> = [
      [0, 40100, 60],
      [1, 40110, 60],
      [2, 40110, 57],
      [3, 40110, 54],
      [4, 40110, 51],
      [5, 40110, 48],
    ];
    this.positions = levels.map(([offset, odometerKm, fuel], i) => ({
      id: 9000 + i,
      deviceId: 7,
      protocol: 'osmand',
      valid: true,
      fixTime: at(offset),
      deviceTime: at(offset),
      serverTime: at(offset),
      latitude: 36.8,
      longitude: 10.18,
      speed: 0,
      attributes: { odometer: odometerKm * 1000, fuel, ignition: false },
    }));
    return origin + 6000;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://localhost:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (this.failing) return json(503, { message: 'Service indisponible (panne simulée)' });
    if (req.method !== 'GET') return json(405, { message: 'Lecture seule' });
    if (url.pathname === '/api/server') return json(200, { id: 1, version: '6.15', readonly: true });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Unauthorized' });
    if (url.pathname === '/api/devices') return json(200, [{ id: 7, name: 'Boîtier E2E télématique', uniqueId: '865000000000777', status: 'online', disabled: false, attributes: {} }]);
    if (url.pathname === '/api/positions') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from && to) return json(200, this.positions.filter((p) => String(p['fixTime']) >= from && String(p['fixTime']) <= to));
      return json(200, [this.positions.at(-1)]);
    }
    return json(404, { message: 'Introuvable' });
  }
}

async function apiCall<T>(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'pa_csrf')?.value ?? '';
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  expect(res.ok(), `${method} ${path} : ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function waitRun(page: Page, providerId: string, runId: string): Promise<{ status: string }> {
  for (let i = 0; i < 120; i += 1) {
    const runs = await apiCall<{ items: Array<{ id: string; status: string }> }>(page, 'GET', `/telemetry/sync-runs?providerId=${providerId}&pageSize=50`);
    const run = runs.items.find((r) => r.id === runId);
    if (run && run.status !== 'EN_COURS') return run;
    await page.waitForTimeout(500);
  }
  throw new Error(`Run ${runId} toujours en cours`);
}

test.describe('Télématique : aide à la saisie, panne du fournisseur, événements carburant et seuils (5.6, 8.5, 14.4)', () => {
  test('aide télématique à la remise et à la restitution pendant une panne ; /carburant → événements du véhicule qualifiés par le chef ; seuils propres au véhicule', async ({ page }) => {
    test.setTimeout(300_000);
    const traccar = new TraccarTestServer();
    const baseUrl = await traccar.start();
    const code = `E2E-TEL-${unique()}`;
    let companyId = '';
    await loginAs(page, E2E.admin);
    try {
      // Préparation par l'API (administrateur) : module activé pour E2E-A, véhicule, conducteur, fournisseur.
      const companies = await apiCall<Array<{ companyId: string; code: string }>>(page, 'GET', '/telemetry/companies');
      companyId = (companies.find((c) => c.code === E2E.companyA) as { companyId: string }).companyId;
      await apiCall(page, 'POST', `/telemetry/companies/${companyId}/enable`, { reason: 'Parcours télématique (e2e)' });
      const categories = await apiCall<Array<{ id: string; code: string }>>(page, 'GET', '/vehicle-categories');
      const vehicle = await apiCall<{ id: string; registration: string }>(page, 'POST', '/vehicles', {
        companyId,
        code,
        registration: `${code.slice(-4)} TU 7777`,
        make: 'Iveco',
        model: 'Daily',
        categoryId: (categories.find((c) => c.code === 'VP') as { id: string }).id,
        energy: 'DIESEL',
        tankCapacityLiters: '80',
      });
      await apiCall(page, 'POST', `/vehicles/${vehicle.id}/odometer-segments`, { mode: 'INITIAL', startedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), physicalKm: '40000' });
      const driver = await apiCall<{ id: string }>(page, 'POST', '/drivers', { companyId, code: `D-${code}`, firstName: 'Tarek', lastName: 'Télématique' });
      await apiCall(page, 'PUT', `/drivers/${driver.id}/permit`, { number: `P-${code}`, categories: ['B'], expiresOn: '2031-12-31' });
      const provider = await apiCall<{ id: string; version: number }>(page, 'POST', '/telemetry/providers', {
        name: `Traccar e2e ${code}`,
        kind: 'TRACCAR',
        baseUrl,
        settings: { fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' },
        companyIds: [companyId],
      });
      await apiCall(page, 'PUT', `/telemetry/providers/${provider.id}/credentials/JETON_API`, { secret: TOKEN });
      await apiCall(page, 'POST', `/telemetry/providers/${provider.id}/activate`, { expectedVersion: provider.version });
      const discovery = await apiCall<{ units: Array<{ unitId: string; externalId: string }> }>(page, 'POST', `/telemetry/providers/${provider.id}/discover`);
      const unitId = (discovery.units.find((u) => u.externalId === '7') as { unitId: string }).unitId;
      // Date d'effet par défaut : entrée du véhicule dans la société (sa création) ; données reçues ensuite.
      await apiCall(page, 'POST', '/telemetry/mappings', { unitId, vehicleId: vehicle.id, odometerKind: 'COMPTEUR_CAN', fuelKinds: ['NIVEAU_SONDE'] });
      const ready = traccar.emitFrom(Date.now() + 500);
      await page.waitForTimeout(Math.max(0, ready - Date.now() + 500));
      const sync = await apiCall<{ runs: Array<{ syncRunId: string }> }>(page, 'POST', `/telemetry/providers/${provider.id}/sync`, {});
      expect((await waitRun(page, provider.id, sync.runs[0]?.syncRunId as string)).status).toBe('SUCCES');

      // Panne du fournisseur : la synchronisation suivante échoue.
      traccar.failing = true;
      const failed = await apiCall<{ runs: Array<{ syncRunId: string }> }>(page, 'POST', `/telemetry/providers/${provider.id}/sync`, {});
      expect((await waitRun(page, provider.id, failed.runs[0]?.syncRunId as string)).status).toBe('ECHEC');

      // Une saisie manuelle est datée à la minute (D-149) : la remise a lieu dans une minute postérieure aux
      // positions reçues, sinon sa valeur (lue au tableau de bord) serait en conflit « même instant » avec le
      // relevé télématique de la même minute, quel que soit l'instant où le parcours démarre.
      const nextMinute = (Math.floor((ready - 1000) / 60_000) + 1) * 60_000;
      await page.waitForTimeout(Math.max(0, nextMinute - Date.now() + 1000));

      // Remise pendant la panne : l'aide télématique propose la dernière valeur CAN de l'association ; la valeur
      // enregistrée est celle lue sur le tableau de bord.
      await page.context().clearCookies();
      await loginAs(page, E2E.chefA);
      await page.goto('/utilisations/nouvelle');
      await page.getByRole('combobox', { name: 'Véhicule disponible *' }).click();
      await page.getByRole('combobox', { name: 'Code, immatriculation, marque…' }).fill(code);
      await page.getByRole('option', { name: new RegExp(code) }).click();
      await expect(page.getByText(/Aide télématique : 40\s110 km \(Compteur CAN\) le /)).toBeVisible();
      await expect(page.getByText('Indication seulement : saisissez la valeur lue sur le tableau de bord.')).toBeVisible();
      await page.getByRole('combobox', { name: 'Conducteur actif *' }).click();
      await page.getByRole('combobox', { name: 'Code, nom ou prénom…' }).fill(`D-${code}`);
      await page.getByRole('option', { name: /Tarek Télématique/ }).click();
      await expect(page.getByText('Aucun blocage détecté')).toBeVisible();
      await page.getByLabel('Retour prévu *').fill(wallTime(6 * 3_600_000));
      await page.getByLabel('Motif *').fill('Tournée pendant la panne du fournisseur GPS');
      await page.getByLabel('Compteur affiché (km) *').fill('40115');
      await page.getByRole('combobox', { name: 'Site *' }).click();
      await page.getByRole('option', { name: 'Dépôt Tunis' }).click();
      await page.getByRole('button', { name: 'Vérifier et enregistrer la remise' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Confirmer la remise' });
      await expect(confirm).toContainText('40115 km (valeur saisie)');
      await confirm.getByRole('button', { name: 'Confirmer la remise' }).click();
      await expect(page).toHaveURL(/\/utilisations\/[0-9a-f-]{36}$/);
      const main = page.getByRole('main');
      const checkoutCard = main.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Remise', exact: true }) });
      await expect(checkoutCard).toContainText(km(40_115));
      await expect(checkoutCard).toContainText('Accepté');

      // Restitution, toujours pendant la panne (une minute plus tard : un relevé par minute au plus) : aide
      // proposée, valeur saisie enregistrée.
      await page.waitForTimeout(61_000);
      await page.reload();
      await page.getByRole('button', { name: 'Enregistrer le retour' }).first().click();
      const returnForm = page.locator('#retour');
      await returnForm.getByLabel('Date et heure réelles du retour *').fill(wallTime(0));
      await expect(returnForm.getByText(/Aide télématique : 40\s110 km/)).toBeVisible();
      await returnForm.getByLabel('Compteur affiché (km) *').fill('40160');
      await returnForm.getByRole('radio', { name: 'Lieu libre' }).click();
      await returnForm.getByLabel('Lieu *').fill('Parking du dépôt');
      await returnForm.getByRole('button', { name: 'Enregistrer le retour' }).click();
      const confirmReturn = page.getByRole('alertdialog', { name: 'Confirmer le retour' });
      await confirmReturn.getByRole('button', { name: 'Confirmer le retour' }).click();
      await expect(page.getByText(`Retour enregistré : ${code} restitué.`)).toBeVisible();
      await expect(main.getByText('Terminée', { exact: true })).toBeVisible();

      // Pages carburant → événements carburant télématiques du véhicule (baisse anormale à qualifier).
      await page.goto(`/carburant?vehicule=${vehicle.id}`);
      await expect(page.getByText('Événements carburant télématiques de ce véhicule : 1, dont 1 à qualifier.', { exact: false })).toBeVisible();
      await page.getByRole('link', { name: 'Voir les événements carburant' }).click();
      await expect(page).toHaveURL(new RegExp(`/telematique\\?onglet=carburant&vehicule=${vehicle.id}&statut=__all__`));
      await expect(page.getByRole('status').filter({ hasText: 'Événements du véhicule' })).toContainText(code);
      await page.getByRole('button', { name: `Qualifier l’événement Baisse anormale à l'arrêt de ${code}` }).click();
      const qualify = page.getByRole('dialog', { name: /Qualifier : Baisse anormale/ });
      await expect(qualify).toContainText('Niveau sonde');
      await qualify.getByLabel('Anomalie confirmée').click();
      await qualify.getByLabel('Note *').fill('Siphonnage constaté au dépôt');
      await qualify.getByRole('button', { name: 'Qualifier' }).click();
      await expect(qualify).toBeHidden();
      await expect(page.getByRole('row').filter({ hasText: code })).toContainText('Anomalie confirmée');
      const expenses = await apiCall<{ total: number }>(page, 'GET', `/expenses?vehicleId=${vehicle.id}`);
      expect(expenses.total).toBe(0);
      await page.goto(`/carburant?vehicule=${vehicle.id}`);
      await expect(page.getByText('Événements carburant télématiques de ce véhicule : 1.', { exact: false })).toBeVisible();

      // Seuils carburant propres au véhicule (onglet Télématique de la fiche), modifiés par le chef.
      await page.goto(`/vehicules/${vehicle.id}?onglet=telematique`);
      const thresholds = page.locator('[data-slot="card"]').filter({ has: page.getByText('Seuils carburant du véhicule', { exact: true }) });
      await expect(thresholds).toContainText('Aucun seuil propre à ce véhicule');
      await thresholds.getByRole('button', { name: 'Modifier les seuils du véhicule' }).click();
      await thresholds.getByLabel('Baisse carburant à l’arrêt (litres) (L)').fill('5');
      await thresholds.getByLabel('Motif *').fill('Véhicule exposé au siphonnage');
      await thresholds.getByRole('button', { name: 'Enregistrer les seuils' }).click();
      await expect(thresholds).toContainText('Surcharge du véhicule : « Véhicule exposé au siphonnage »');
      await expect(thresholds.getByRole('row').filter({ hasText: 'Baisse carburant à l’arrêt (litres)' })).toContainText('Propre au véhicule');
      await expect(thresholds.getByRole('row').filter({ hasText: 'Baisse carburant à l’arrêt (litres)' })).toContainText('5 L');
    } finally {
      await traccar.stop();
      if (companyId) {
        await page.context().clearCookies();
        await loginAs(page, E2E.admin);
        await apiCall(page, 'POST', `/telemetry/companies/${companyId}/disable`, { reason: 'Fin du parcours télématique (e2e)' });
      }
    }
  });
});
