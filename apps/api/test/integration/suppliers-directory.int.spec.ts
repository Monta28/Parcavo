import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

type SupplierBody = { id: string; version: number; name: string; companyId: string; status: string; category: string };

/**
 * Répertoire des fournisseurs (CDC 8.1, 15.2 : GET /suppliers) : listes filtrées (société, catégorie,
 * statut, recherche), cloisonnement côté serveur et liste fermée des catégories.
 */
describe('Fournisseurs : liste filtrée, cloisonnement et catégories fermées (CDC 8.1, 15.2)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-24T10:00:00.000Z' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set('2026-09-24T10:00:00.000Z');
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  });

  async function supplier(agent: Agent, body: Record<string, unknown>): Promise<SupplierBody> {
    const res = await agent.post('/suppliers', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as SupplierBody;
  }

  const names = (body: { items: Array<{ name: string }> }) => body.items.map((s) => s.name);

  async function seedDirectory(): Promise<{ garage: SupplierBody; station: SupplierBody; assureur: SupplierBody; loueur: SupplierBody; archived: SupplierBody; garageB: SupplierBody }> {
    const garage = await supplier(chefA, { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE', contactName: 'Mourad Ben Ali', phone: '+216 71 000 001' });
    const station = await supplier(operateurA, { companyId: f.companies.A, name: 'Station du Lac', category: 'STATION', contactName: 'Service client' });
    const assureur = await supplier(chefA, { companyId: f.companies.A, name: 'Assurances Carthage', category: 'ASSURANCE', contactName: 'Nadia Trabelsi', email: 'Contact@Carthage.tn' });
    const loueur = await supplier(chefA, { companyId: f.companies.A, name: 'Loc Auto Sahel', category: 'LOUEUR' });
    const archived = await supplier(chefA, { companyId: f.companies.A, name: 'Garage Ancien', category: 'GARAGE', notes: 'Fermé en 2026' });
    const done = await chefA.post(`/suppliers/${archived.id}/archive`, { expectedVersion: archived.version });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const garageB = await supplier(chefB, { companyId: f.companies.B, name: 'Garage de Sfax', category: 'GARAGE', contactName: 'Mourad Kefi' });
    return { garage, station, assureur, loueur, archived: done.body as SupplierBody, garageB };
  }

  it('GET /suppliers : actifs par défaut, filtres société, catégorie, statut et recherche (nom ou contact), total exact et pagination', async () => {
    const d = await seedDirectory();

    // Actifs par défaut, triés par nom ; l'archivé n'apparaît pas.
    const all = await chefA.get('/suppliers');
    expect(all.status).toBe(200);
    expect(names(all.body)).toEqual(['Assurances Carthage', 'Garage Central', 'Loc Auto Sahel', 'Station du Lac']);
    expect(all.body.total).toBe(4);
    expect(all.body.items[0]).toMatchObject({ companyId: f.companies.A, category: 'ASSURANCE', contactName: 'Nadia Trabelsi', email: 'contact@carthage.tn', status: 'ACTIF', archivedAt: null });

    // Catégorie : liste fermée, filtre exact.
    const garages = await chefA.get('/suppliers?category=GARAGE');
    expect(names(garages.body)).toEqual(['Garage Central']);
    expect((await chefA.get('/suppliers?category=STATION')).body.items.map((s: SupplierBody) => s.id)).toEqual([d.station.id]);

    // Statut : archivés à la demande (historique conservé), avec leur date d'archivage.
    const archived = await chefA.get('/suppliers?status=ARCHIVE');
    expect(names(archived.body)).toEqual(['Garage Ancien']);
    expect(archived.body.items[0]).toMatchObject({ status: 'ARCHIVE', notes: 'Fermé en 2026' });
    expect(archived.body.items[0].archivedAt).toBe('2026-09-24T10:00:00.000Z');
    expect((await chefA.get('/suppliers?status=ARCHIVE&category=STATION')).body.total).toBe(0);

    // Recherche sur le nom ou le contact, sans tenir compte de la casse.
    expect(names((await chefA.get('/suppliers?q=garage')).body)).toEqual(['Garage Central']);
    expect(names((await chefA.get('/suppliers?q=MOURAD')).body)).toEqual(['Garage Central']);
    expect(names((await chefA.get('/suppliers?q=trabelsi')).body)).toEqual(['Assurances Carthage']);
    expect((await chefA.get('/suppliers?q=inexistant')).body).toMatchObject({ items: [], total: 0 });

    // Société explicite (dans le périmètre) et pagination bornée : total exact, pages disjointes.
    const byCompany = await chefA.get(`/suppliers?companyId=${f.companies.A}&pageSize=2&page=1`);
    expect(byCompany.body).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(names(byCompany.body)).toEqual(['Assurances Carthage', 'Garage Central']);
    const page2 = await chefA.get(`/suppliers?companyId=${f.companies.A}&pageSize=2&page=2`);
    expect(names(page2.body)).toEqual(['Loc Auto Sahel', 'Station du Lac']);

    // Filtres invalides : refus de validation (422), jamais une liste « au hasard ».
    for (const query of ['status=SUPPRIME', 'category=PARKING', 'companyId=pas-un-uuid']) {
      const res = await chefA.get(`/suppliers?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.code).toBe('VALIDATION');
    }
    // Filtre combiné société + catégorie + recherche.
    expect(names((await chefA.get(`/suppliers?companyId=${f.companies.A}&category=LOUEUR&q=sahel`)).body)).toEqual(['Loc Auto Sahel']);
    expect(d.garageB.companyId).toBe(f.companies.B);
  });

  it('cloisonnement de la liste : chaque chef ne voit que ses sociétés, société hors périmètre → 404, conducteur → 403, administrateur : toutes', async () => {
    const d = await seedDirectory();

    // Le chef de A ne voit ni ne compte les fournisseurs de B, même en cherchant leur nom ou leur contact.
    const listA = await chefA.get('/suppliers?q=mourad');
    expect(names(listA.body)).toEqual(['Garage Central']);
    expect((await chefA.get('/suppliers?q=sfax')).body.total).toBe(0);
    // Une société hors périmètre fournie par le navigateur ne fait pas autorité : 404, sans rien révéler.
    const forced = await chefA.get(`/suppliers?companyId=${f.companies.B}`);
    expect(forced.status).toBe(404);
    expect(JSON.stringify(forced.body)).not.toContain('Garage de Sfax');
    expect((await chefA.get(`/suppliers/${d.garageB.id}`)).status).toBe(404);
    expect((await chefA.get(`/suppliers?companyId=${randomUUID()}`)).status).toBe(404);

    // Le chef de B : uniquement B.
    const listB = await chefB.get('/suppliers');
    expect(names(listB.body)).toEqual(['Garage de Sfax']);
    expect((await chefB.get(`/suppliers?companyId=${f.companies.A}`)).status).toBe(404);

    // Lecteur et opérateur de A : répertoire de A en lecture ; le conducteur n'a aucun accès au répertoire.
    expect((await lecteurA.get('/suppliers')).body.total).toBe(4);
    expect((await operateurA.get('/suppliers')).body.total).toBe(4);
    const driver = await conducteurA.get('/suppliers');
    expect(driver.status).toBe(403);
    expect((await conducteurA.get(`/suppliers/${d.garage.id}`)).status).toBe(403);

    // Administrateur groupe : toutes les sociétés, filtrables.
    const everything = await admin.get('/suppliers?category=GARAGE');
    expect(names(everything.body)).toEqual(['Garage Central', 'Garage de Sfax']);
    expect((await admin.get(`/suppliers?companyId=${f.companies.B}`)).body.items.map((s: SupplierBody) => s.id)).toEqual([d.garageB.id]);
  });

  it('catégorie hors liste fermée (garage, station, assurance, loueur, autre) : 422 à la création et à la modification, rien n’est écrit', async () => {
    for (const category of ['PARKING', 'garage', '', 'CONCESSIONNAIRE']) {
      const res = await chefA.post('/suppliers', { companyId: f.companies.A, name: `Fournisseur ${category || 'vide'}`, category });
      expect(res.status, category).toBe(422);
      expect(res.body.code).toBe('VALIDATION');
      expect(res.body.fieldErrors.category, JSON.stringify(res.body)).toBeDefined();
    }
    expect(await t.prisma.client.supplier.count()).toBe(0);

    // Les cinq catégories du CDC sont acceptées.
    for (const category of ['GARAGE', 'STATION', 'ASSURANCE', 'LOUEUR', 'AUTRE']) {
      await supplier(chefA, { companyId: f.companies.A, name: `Fournisseur ${category}`, category });
    }
    const autre = (await chefA.get('/suppliers?category=AUTRE')).body.items[0] as SupplierBody;
    const update = await chefA.patch(`/suppliers/${autre.id}`, { category: 'PARKING', expectedVersion: autre.version });
    expect(update.status).toBe(422);
    expect(update.body.fieldErrors.category).toBeDefined();
    const row = await t.prisma.client.supplier.findUniqueOrThrow({ where: { id: autre.id } });
    expect(row.category).toBe('AUTRE');
    expect(row.version).toBe(1);

    // La base refuse aussi une valeur hors énumération, même sans passer par l'API.
    await expect(t.prisma.client.$executeRawUnsafe(`UPDATE "Supplier" SET "category" = 'PARKING' WHERE "id" = '${autre.id}'`)).rejects.toThrow();
  });
});
