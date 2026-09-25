import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/infra/prisma.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

type ExpenseBody = { id: string; version: number; status: string; replacesExpenseId: string | null; replacedByExpenseId: string | null; amount: string; signedAmount: string; sourceType: string | null; sourceId: string | null };

/**
 * Registre des dépenses (CDC 8.4, 15.2) : référence source unique garantie par la base (index partiel
 * expense_one_active_per_source), chaîne de corrections navigable par l'API, synthèse filtrée comme la liste.
 */
describe('Registre des dépenses : unicité de la source en base, chaîne de corrections, synthèse filtrée comme la liste (CDC 8.4, 15.2)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;
  let vehicleId: string;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'DEP-01' });
  });

  async function expense(body: Record<string, unknown>, key: string = randomUUID()): Promise<ExpenseBody> {
    const res = await chefA.post('/expenses', { vehicleId, occurredOn: '2026-09-10', category: 'PEAGE', amount: '100', ...body }).set('Idempotency-Key', key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ExpenseBody;
  }

  it('R-8.4-06 — l’index unique expense_one_active_per_source refuse en base une seconde dépense VALIDEE pour la même source ; annulées et remplacées ne comptent pas', async () => {
    expect((await chefA.patch(`/vehicles/${vehicleId}`, { energy: 'DIESEL', expectedVersion: 1 })).status).toBe(200);
    const fuel = await chefA.post('/fuel-entries', { vehicleId, filledAt: '2026-09-23T08:00:00Z', liters: '40', unitPrice: '2.525', totalAmount: '101.000', isFullTank: true }).set('Idempotency-Key', randomUUID());
    expect(fuel.status, JSON.stringify(fuel.body)).toBe(201);
    const source = await t.prisma.client.expense.findFirstOrThrow({ where: { sourceType: 'PLEIN', sourceId: fuel.body.id } });
    expect(source.status).toBe('VALIDEE');

    // Écriture directe en base, sans passer par le service : la contrainte refuse le doublon.
    const duplicate = { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, occurredOn: new Date('2026-09-23T00:00:00Z'), category: 'CARBURANT' as const, amount: '101.000', sourceType: 'PLEIN' as const, sourceId: fuel.body.id as string };
    let error: unknown = null;
    try {
      await t.prisma.client.expense.create({ data: duplicate });
    } catch (e) {
      error = e;
    }
    expect(isUniqueViolation(error, 'expense_one_active_per_source'), String(error)).toBe(true);
    // Même refus en SQL brut (la garantie est dans la base, pas dans le client).
    await expect(
      t.prisma.client.$executeRawUnsafe(
        `INSERT INTO "Expense" ("id", "organizationId", "companyId", "vehicleId", "occurredOn", "category", "amount", "sourceType", "sourceId", "status", "updatedAt") VALUES ('${randomUUID()}', '${f.organizationId}', '${f.companies.A}', '${vehicleId}', '2026-09-23', 'CARBURANT', 101, 'PLEIN', '${fuel.body.id}', 'VALIDEE', now())`,
      ),
    ).rejects.toThrow(/expense_one_active_per_source|unique/i);
    expect(await t.prisma.client.expense.count({ where: { sourceType: 'PLEIN', sourceId: fuel.body.id } })).toBe(1);

    // L'index est partiel : l'historique (ANNULEE, REMPLACEE) d'une même source reste possible.
    await t.prisma.client.expense.create({ data: { ...duplicate, status: 'ANNULEE', cancelReason: 'Historique de test' } });
    await t.prisma.client.expense.create({ data: { ...duplicate, status: 'REMPLACEE' } });
    expect(await t.prisma.client.expense.count({ where: { sourceType: 'PLEIN', sourceId: fuel.body.id } })).toBe(3);
    expect(await t.prisma.client.expense.count({ where: { sourceType: 'PLEIN', sourceId: fuel.body.id, status: 'VALIDEE' } })).toBe(1);

    // Relance d'une saisie manuelle : même clé → même écriture ; même référence fournisseur → 409.
    const supplier = (await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Autoroutes de Tunisie', category: 'AUTRE' })).body.id as string;
    const key = randomUUID();
    const first = await expense({ supplierId: supplier, reference: 'TICKET-42' }, key);
    const replay = await chefA.post('/expenses', { vehicleId, occurredOn: '2026-09-10', category: 'PEAGE', amount: '100', supplierId: supplier, reference: 'TICKET-42' }).set('Idempotency-Key', key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.id);
    const again = await chefA.post('/expenses', { vehicleId, occurredOn: '2026-09-11', category: 'PEAGE', amount: '100', supplierId: supplier, reference: 'ticket-42' }).set('Idempotency-Key', randomUUID());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DEPENSE_REFERENCE_EXISTANTE');
    expect(await t.prisma.client.expense.count({ where: { reference: { equals: 'TICKET-42', mode: 'insensitive' } } })).toBe(1);
  });

  it('chaîne de corrections navigable : chaque version expose la précédente et la suivante ; annulée à la fin ; hors périmètre → 404', async () => {
    const v1 = await expense({ amount: '120.000', reference: 'FACT-CHAIN' });
    const c1 = await chefA.post(`/expenses/${v1.id}/correct`, { reason: 'Montant erroné', expectedVersion: v1.version, amount: '125.000' }).set('Idempotency-Key', randomUUID());
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    const v2 = c1.body as ExpenseBody;
    const c2 = await chefA.post(`/expenses/${v2.id}/correct`, { reason: 'Remise obtenue', expectedVersion: v2.version, amount: '110.500' }).set('Idempotency-Key', randomUUID());
    expect(c2.status, JSON.stringify(c2.body)).toBe(201);
    const v3 = c2.body as ExpenseBody;

    const g1 = (await chefA.get(`/expenses/${v1.id}`)).body as ExpenseBody;
    const g2 = (await chefA.get(`/expenses/${v2.id}`)).body as ExpenseBody;
    const g3 = (await chefA.get(`/expenses/${v3.id}`)).body as ExpenseBody;
    expect(g1).toMatchObject({ status: 'REMPLACEE', replacesExpenseId: null, replacedByExpenseId: v2.id, amount: '120.000' });
    expect(g2).toMatchObject({ status: 'REMPLACEE', replacesExpenseId: v1.id, replacedByExpenseId: v3.id, amount: '125.000' });
    expect(g3).toMatchObject({ status: 'VALIDEE', replacesExpenseId: v2.id, replacedByExpenseId: null, amount: '110.500' });
    // Une version remplacée ne se corrige plus : seule la dernière est modifiable.
    const stale = await chefA.post(`/expenses/${v1.id}/correct`, { reason: 'Encore', expectedVersion: g1.version, amount: '1' }).set('Idempotency-Key', randomUUID());
    expect(stale.status).toBe(409);

    const cancelled = await chefA.post(`/expenses/${v3.id}/cancel`, { reason: 'Facture annulée par le fournisseur', expectedVersion: g3.version });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'ANNULEE', replacesExpenseId: v2.id, cancelReason: 'Facture annulée par le fournisseur' });
    // Toutes les versions restent consultables (état « Tous »), aucune n'est comptée.
    const history = await chefA.get('/expenses?status=TOUS&q=FACT-CHAIN');
    expect(history.body.items.map((e: ExpenseBody) => e.id).sort()).toEqual([v1.id, v2.id, v3.id].sort());
    expect((await chefA.get('/expenses/summary?q=FACT-CHAIN')).body.operating).toMatchObject({ net: '0.000', count: 0 });
    // Hors périmètre : aucune version n'est révélée.
    for (const id of [v1.id, v2.id, v3.id]) expect((await chefB.get(`/expenses/${id}`)).status).toBe(404);
  });

  it('synthèse filtrée comme la liste : « sans véhicule », nature, recherche et fournisseur donnent les totaux exacts des lignes validées listées', async () => {
    const supplier = (await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE' })).body.id as string;
    const repair = await expense({ category: 'ENTRETIEN_REPARATION', amount: '450.250', supplierId: supplier, reference: 'FAC-2026-001' });
    await expense({ kind: 'AVOIR', category: 'ENTRETIEN_REPARATION', amount: '50.125', supplierId: supplier, reference: 'AV-2026-001', relatedExpenseId: repair.id });
    await expense({ vehicleId: undefined, companyId: f.companies.A, category: 'ASSURANCE', amount: '1200.000', reference: 'POLICE-FLOTTE' });
    await expense({ category: 'PEAGE', amount: '12.500', notes: 'Péage autoroute A1' });
    const cancelled = await expense({ category: 'PEAGE', amount: '99.000', reference: 'PEAGE-ANNULE' });
    expect((await chefA.post(`/expenses/${cancelled.id}/cancel`, { reason: 'Doublon', expectedVersion: cancelled.version })).status).toBe(200);

    /** Somme exacte (en millièmes) des montants signés des lignes VALIDEE listées pour ces filtres. */
    async function listedNet(query: string): Promise<{ net: string; count: number }> {
      const list = await chefA.get(`/expenses?pageSize=100${query}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const millis = list.body.items.reduce((acc: number, e: ExpenseBody) => acc + Math.round(Number(e.signedAmount) * 1000), 0);
      return { net: (millis / 1000).toFixed(3), count: list.body.total as number };
    }
    const cases: Array<[string, string, number]> = [
      ['', '1612.625', 4],
      ['&unallocated=true', '1200.000', 1],
      ['&unallocated=false', '412.625', 3],
      ['&kind=AVOIR', '-50.125', 1],
      ['&kind=DEPENSE', '1662.750', 3],
      ['&q=FAC-2026', '450.250', 1],
      ['&q=autoroute', '12.500', 1],
      [`&supplierId=${supplier}`, '400.125', 2],
      [`&supplierId=${supplier}&kind=DEPENSE`, '450.250', 1],
    ];
    for (const [query, net, count] of cases) {
      const summary = await chefA.get(`/expenses/summary?${query.slice(1)}`);
      expect(summary.status, `${query} ${JSON.stringify(summary.body)}`).toBe(200);
      expect(summary.body.operating, query).toMatchObject({ net, count });
      expect(await listedNet(query), query).toEqual({ net, count });
    }
    // « Non ventilé » : la part sans véhicule, filtrée elle aussi.
    expect((await chefA.get('/expenses/summary?unallocated=true')).body.unallocated).toMatchObject({ net: '1200.000', count: 1 });
    expect((await chefA.get('/expenses/summary?unallocated=false')).body.unallocated).toMatchObject({ net: '0.000', count: 0 });
    // Filtres invalides : même refus que la liste.
    for (const query of ['kind=REMISE', 'unallocated=oui']) {
      const res = await chefA.get(`/expenses/summary?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.code).toBe('VALIDATION');
    }
  });
});
