import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * CDC 10.1 et 15.1 : listes paginées (25 par défaut, 100 au plus), tri au choix sur une liste autorisée,
 * sens croissant ou décroissant, ordre stable d'une page à l'autre ; un tri inconnu revient au tri par défaut.
 */
describe('Listes : pagination bornée et tri au choix (véhicules, conducteurs, utilisateurs, sociétés)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
  });

  it('véhicules : tri par code, immatriculation ou marque dans les deux sens ; pages stables à marque égale', async () => {
    const specs = [
      { code: 'V-03', registration: '100 TU 1', make: 'Renault' },
      { code: 'V-01', registration: '300 TU 1', make: 'Peugeot' },
      { code: 'V-02', registration: '200 TU 1', make: 'Peugeot' },
      { code: 'V-04', registration: '400 TU 1', make: 'Peugeot' },
    ];
    for (const s of specs) await createVehicle(t.prisma, f, 'A', s);
    const codes = async (query: string) => ((await admin.get(`/vehicles${query}`)).body.items as Array<{ code: string }>).map((v) => v.code);

    expect(await codes('')).toEqual(['V-01', 'V-02', 'V-03', 'V-04']);
    expect(await codes('?sort=code&order=desc')).toEqual(['V-04', 'V-03', 'V-02', 'V-01']);
    expect(await codes('?sort=registration&order=asc')).toEqual(['V-03', 'V-02', 'V-01', 'V-04']);
    expect(await codes('?sort=registration&order=desc')).toEqual(['V-04', 'V-01', 'V-02', 'V-03']);
    // Un tri non autorisé ne révèle ni n'utilise une colonne interne : tri par défaut.
    expect(await codes('?sort=qrToken')).toEqual(['V-01', 'V-02', 'V-03', 'V-04']);
    expect((await admin.get('/vehicles?order=sideways')).status).toBe(422);

    // Marque égale (Peugeot × 3) : les pages de 1 élément couvrent chaque véhicule une seule fois.
    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) seen.push(...(await codes(`?sort=make&order=asc&pageSize=1&page=${page}`)));
    expect(seen.slice(0, 3).sort()).toEqual(['V-01', 'V-02', 'V-04']);
    expect(seen[3]).toBe('V-03');
  });

  it('pagination : 25 par défaut, 100 au plus (422 au-delà), métadonnées items, total, page et pageSize', async () => {
    const res = await admin.get('/vehicles');
    expect(res.body).toMatchObject({ page: 1, pageSize: 25, total: 0, items: [] });
    expect((await admin.get('/vehicles?pageSize=100')).status).toBe(200);
    const tooBig = await admin.get('/vehicles?pageSize=101');
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.fieldErrors.pageSize).toBeDefined();
  });

  it('conducteurs, utilisateurs et sociétés : tri au choix dans les deux sens', async () => {
    const drivers = async (query: string) => ((await admin.get(`/drivers${query}`)).body.items as Array<{ lastName: string }>).map((d) => d.lastName);
    const byName = await drivers('?sort=lastName&order=asc');
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'en')));
    expect(await drivers('?sort=lastName&order=desc')).toEqual([...byName].reverse());

    const users = async (query: string) => ((await admin.get(`/users${query}`)).body.items as Array<{ email: string }>).map((u) => u.email);
    const byEmail = await users('?sort=email&order=asc');
    expect(byEmail).toHaveLength(6);
    expect(byEmail).toEqual([...byEmail].sort());
    expect(await users('?sort=email&order=desc')).toEqual([...byEmail].reverse());

    const companies = async (query: string) => ((await admin.get(`/companies${query}`)).body.items as Array<{ code: string }>).map((c) => c.code);
    expect(await companies('?sort=code&order=desc')).toEqual(['C', 'B', 'A']);
    expect(await companies('?sort=legalName&order=asc')).toEqual(['A', 'B', 'C']);
  });
});
