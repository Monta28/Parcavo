import { Decimal } from 'decimal.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoadSeedRefusedError, loadUserEmail, seedLoad } from '../../src/cli/seed-load.js';
import { localDate } from '../../src/domain/civil-date.js';
import { immobilizationIntervals } from '../../src/domain/immobilization-duration.js';
import { durationDays, unionWithinPeriod } from '../../src/domain/interval-union.js';
import { returnDelay } from '../../src/domain/return-delay.js';
import { NotFoundOrOutOfScopeError } from '../../src/common/errors.js';
import type { RequestContext } from '../../src/common/request-context.js';
import { PasswordService } from '../../src/infra/password.service.js';
import { ContextBuilderService } from '../../src/modules/auth/context-builder.service.js';
import { FuelService } from '../../src/modules/fuel/fuel.service.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';
const PASSWORD = 'Charge-Pagination-Test-2026';
const FROM = '2024-09-01';
const TO = '2026-09-24';
const PERIOD = `&from=${FROM}&to=${TO}`;

type Item = Record<string, unknown> & { id: string; companyId: string | null };

/** Vues dont la pagination est calculée en base par la réécriture (anciennement découpées en mémoire). */
const VIEWS: Array<{ path: string; big: boolean }> = [
  { path: '/reports/inventaire?vue=vehicules', big: true },
  { path: '/reports/inventaire?vue=vehicules&operationalStatus=DISPONIBLE', big: true },
  { path: `/reports/releves?vue=qualite${PERIOD}`, big: true },
  { path: `/reports/utilisations?vue=utilisations&lateOnly=true${PERIOD}`, big: true },
  { path: `/reports/incidents-immobilisations?vue=immobilisations${PERIOD}`, big: true },
  { path: `/reports/incidents-immobilisations?vue=causes${PERIOD}`, big: true },
  { path: '/reports/documents?vue=echeances', big: true },
  { path: `/reports/carburant?vue=vehicules${PERIOD}`, big: true },
  { path: `/reports/depenses?vue=vehicule${PERIOD}`, big: true },
  { path: `/reports/depenses?vue=detail${PERIOD}`, big: true },
  { path: `/reports/depenses?vue=fournisseur${PERIOD}`, big: false },
  { path: `/reports/depenses?vue=categorie${PERIOD}`, big: false },
  { path: `/reports/depenses?vue=societe${PERIOD}`, big: false },
];

const collator = (a: unknown, b: unknown) => String(a).localeCompare(String(b));

/**
 * Toutes les vues des rapports et la table d'historique qu'elles résument (lignes lues : CDC 17.2, « aucun
 * chargement de l'historique complet pour afficher une page »).
 */
const ALL_VIEWS: Array<{ path: string; history: string }> = [
  { path: '/reports/inventaire?vue=vehicules', history: 'OdometerReading' },
  { path: '/reports/inventaire?vue=vehicules&operationalStatus=DISPONIBLE', history: 'OdometerReading' },
  { path: `/reports/releves?vue=releves${PERIOD}`, history: 'OdometerReading' },
  { path: `/reports/releves?vue=qualite${PERIOD}`, history: 'OdometerReading' },
  { path: `/reports/utilisations?vue=utilisations${PERIOD}`, history: 'VehicleUsage' },
  { path: `/reports/utilisations?vue=utilisations&lateOnly=true${PERIOD}`, history: 'VehicleUsage' },
  { path: `/reports/utilisations?vue=affectations${PERIOD}`, history: 'VehicleResponsibleAssignment' },
  { path: '/reports/entretiens?vue=a-venir', history: 'VehicleMaintenancePlan' },
  { path: `/reports/entretiens?vue=realises${PERIOD}`, history: 'Intervention' },
  { path: '/reports/documents?vue=echeances', history: 'DocumentVersion' },
  { path: `/reports/carburant?vue=pleins${PERIOD}`, history: 'FuelEntry' },
  { path: `/reports/carburant?vue=vehicules${PERIOD}`, history: 'FuelEntry' },
  { path: `/reports/depenses?vue=categorie${PERIOD}`, history: 'Expense' },
  { path: `/reports/depenses?vue=vehicule${PERIOD}`, history: 'Expense' },
  { path: `/reports/depenses?vue=societe${PERIOD}`, history: 'Expense' },
  { path: `/reports/depenses?vue=fournisseur${PERIOD}`, history: 'Expense' },
  { path: `/reports/depenses?vue=detail${PERIOD}`, history: 'Expense' },
  { path: `/reports/incidents-immobilisations?vue=incidents${PERIOD}`, history: 'Incident' },
  { path: `/reports/incidents-immobilisations?vue=immobilisations${PERIOD}`, history: 'ImmobilizationCause' },
  { path: `/reports/incidents-immobilisations?vue=causes${PERIOD}`, history: 'ImmobilizationCause' },
  { path: `/reports/couts-distances?vue=vehicules${PERIOD}`, history: 'OdometerReading' },
];

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Lignes que PostgreSQL renvoie à l'API pendant une requête HTTP : instrumentation du pilote pg (même
 * processus que l'API de test, même module que l'adaptateur Prisma), sans rien changer aux résultats.
 */
async function rowsReadDuring(action: () => Promise<unknown>): Promise<number[]> {
  const proto = (pg.Client as unknown as { prototype: { query: QueryFn } }).prototype;
  const original = proto.query;
  const sizes: number[] = [];
  const record = (res: unknown) => {
    const rows = (res as { rows?: unknown } | undefined)?.rows;
    if (Array.isArray(rows)) sizes.push(rows.length);
  };
  proto.query = function (this: unknown, ...args: unknown[]) {
    const last = args.at(-1);
    if (typeof last === 'function') {
      args[args.length - 1] = (error: unknown, res: unknown) => {
        if (!error) record(res);
        return (last as (e: unknown, r: unknown) => unknown)(error, res);
      };
      return original.apply(this, args);
    }
    const out = original.apply(this, args) as { then?: (ok: (r: unknown) => void, ko: () => void) => unknown } | undefined;
    if (typeof out?.then === 'function') out.then(record, () => undefined);
    return out;
  };
  try {
    await action();
    return sizes;
  } finally {
    proto.query = original;
  }
}

describe('Rapports paginés en base sur un volume supérieur à une page (CDC 17.2, 11.2 — jeu de dimensionnement réduit)', () => {
  let t: TestApp;
  let admin: Agent;
  let chefB: Agent;
  let companies: Record<'A' | 'B' | 'C', string>;
  let counts: Record<string, number>;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
    await resetDatabase(t.prisma);
    const report = await seedLoad(t.prisma.client, { vehicles: 60, readings: 60 * 40, now: new Date(NOW), passwordHash: await new PasswordService().hash(PASSWORD) });
    counts = report.counts;
    const rows = await t.prisma.client.company.findMany({ select: { id: true, code: true } });
    const byCode = (code: string) => (rows.find((c) => c.code === code) as { id: string }).id;
    companies = { A: byCode('CH-A'), B: byCode('CH-B'), C: byCode('CH-C') };
    // Cas limites ajoutés au jeu : codes dont l'ordre dépend de la collation (casse, accent), homonymes de
    // fournisseurs dans deux sociétés, type de document restreint à une société et une catégorie.
    const [v1, v2, v3] = await t.prisma.client.vehicle.findMany({ where: { companyId: companies.A }, orderBy: { code: 'asc' }, take: 3 });
    await t.prisma.client.vehicle.update({ where: { id: (v1 as { id: string }).id }, data: { code: 'beta-03' } });
    await t.prisma.client.vehicle.update({ where: { id: (v2 as { id: string }).id }, data: { code: 'Éco-02' } });
    await t.prisma.client.vehicle.update({ where: { id: (v3 as { id: string }).id }, data: { code: 'alpha-01' } });
    for (const companyId of [companies.A, companies.B]) {
      const garage = await t.prisma.client.supplier.findFirstOrThrow({ where: { companyId, category: 'GARAGE' }, orderBy: { name: 'asc' } });
      await t.prisma.client.supplier.update({ where: { id: garage.id }, data: { name: 'Garage Commun' } });
    }
    const vu = await t.prisma.client.vehicleCategory.findFirstOrThrow({ where: { code: 'VU' } });
    const type = await t.prisma.client.documentType.create({
      data: { organizationId: (await t.prisma.client.organization.findFirstOrThrow()).id, code: 'CARTE_TRANSPORT', label: 'Carte de transport', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, noticeDays: [20], companyIds: [companies.B], vehicleCategoryIds: [vu.id] },
    });
    const applicable = await t.prisma.client.vehicle.findMany({ where: { companyId: companies.B, categoryId: vu.id }, orderBy: { code: 'asc' } });
    for (const [i, v] of applicable.entries()) {
      if (i % 3 === 0) continue;
      const validTo = new Date(Date.UTC(2026, 8, 24 + (i % 3 === 1 ? -5 : 15)));
      await t.prisma.client.documentVersion.create({ data: { organizationId: type.organizationId, companyId: v.companyId, documentTypeId: type.id, ownerType: 'VEHICULE', vehicleId: v.id, validFrom: new Date(Date.UTC(2025, 8, 1)), validTo } });
    }
    admin = await login(t.server, loadUserEmail(1), PASSWORD);
    chefB = await login(t.server, loadUserEmail(7), PASSWORD);
  });
  afterAll(async () => {
    await t.close();
  });

  async function all(agent: Agent, path: string, pageSize: number): Promise<{ items: Item[]; total: number }> {
    const items: Item[] = [];
    let total = 0;
    for (let page = 1; page < 1_000; page += 1) {
      const res = await agent.get(`${path}&page=${page}&pageSize=${pageSize}`);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
      total = res.body.total as number;
      items.push(...(res.body.items as Item[]));
      if ((res.body.items as Item[]).length < pageSize) break;
    }
    return { items, total };
  }

  it('jeu de dimensionnement : volumes demandés, contraintes respectées, refus sur une base non vide', async () => {
    expect(counts['véhicules']).toBe(60);
    expect(counts['conducteurs']).toBe(120);
    expect(counts['comptes']).toBe(50);
    expect(counts['relevés kilométriques']).toBe(2_400);
    expect(await t.prisma.client.odometerReading.count()).toBe(2_400);
    expect(counts['utilisations']).toBeGreaterThan(300);
    // Une seule utilisation ouverte par véhicule et par conducteur ; distance validée = écart des cumuls.
    const open = await t.prisma.client.vehicleUsage.findMany({ where: { status: 'EN_COURS' }, select: { vehicleId: true, driverId: true } });
    expect(new Set(open.map((u) => u.vehicleId)).size).toBe(open.length);
    expect(new Set(open.map((u) => u.driverId)).size).toBe(open.length);
    const usage = await t.prisma.client.vehicleUsage.findFirstOrThrow({ where: { status: 'TERMINEE' }, include: { checkoutReading: true, returnReading: true } });
    expect(new Decimal(usage.distanceKm?.toString() ?? '0').toFixed(3)).toBe(new Decimal(usage.returnReading?.cumulativeKm?.toString() ?? '0').minus(usage.checkoutReading?.cumulativeKm?.toString() ?? '0').toFixed(3));
    // Chaque plein validé a sa dépense CARBURANT validée, même montant.
    const validated = await t.prisma.client.fuelEntry.count({ where: { status: 'VALIDE' } });
    expect(await t.prisma.client.expense.count({ where: { sourceType: 'PLEIN', status: 'VALIDEE' } })).toBe(validated);
    await expect(seedLoad(t.prisma.client, { vehicles: 6, readings: 6 * 24, now: new Date(NOW), passwordHash: 'x' })).rejects.toBeInstanceOf(LoadSeedRefusedError);
  });

  it('chaque vue réécrite : pages de 7 et de 25 identiques à la lecture par pages de 100, total exact, sans doublon, volume supérieur à une page', async () => {
    for (const { path, big } of VIEWS) {
      const full = await all(admin, path, 100);
      const small = await all(admin, path, 7);
      expect(full.items.length, path).toBe(full.total);
      expect(small.total, path).toBe(full.total);
      expect(small.items, path).toEqual(full.items);
      expect(new Set(full.items.map((i) => i.id)).size, path).toBe(full.total);
      if (big) {
        expect(full.total, path).toBeGreaterThan(25);
        const second = await admin.get(`${path}&page=2&pageSize=25`);
        expect(second.body.items, path).toEqual(full.items.slice(25, 50));
      }
      // Au-delà de la dernière page : aucune ligne, même total.
      const beyond = await admin.get(`${path}&page=${Math.ceil(full.total / 25) + 1}&pageSize=25`);
      expect(beyond.body.items, path).toEqual([]);
      expect(beyond.body.total, path).toBe(full.total);
    }
  });

  it('ordre des vues regroupées : collation identique à localeCompare, urgence et durée', async () => {
    const quality = (await all(admin, `/reports/releves?vue=qualite${PERIOD}`, 100)).items;
    const rank: Record<string, number> = { INCONNU: 0, A_ACTUALISER: 1, A_JOUR: 2 };
    expect(new Set(quality.map((q) => q['freshness']))).toEqual(new Set(['INCONNU', 'A_ACTUALISER', 'A_JOUR']));
    expect([...quality].sort((a, b) => (rank[a['freshness'] as string] as number) - (rank[b['freshness'] as string] as number) || collator(a['vehicle'], b['vehicle']))).toEqual(quality);

    const fuel = (await all(admin, `/reports/carburant?vue=vehicules${PERIOD}`, 100)).items;
    expect(fuel.slice(0, 3).map((f) => f['vehicle'])).toEqual(['alpha-01', 'beta-03', 'CH-A-V0004']);
    expect([...fuel].sort((a, b) => collator(a['vehicle'], b['vehicle']) || collator(a['energy'], b['energy']) || collator(a.companyId, b.companyId))).toEqual(fuel);
    expect(fuel.findIndex((f) => f['vehicle'] === 'Éco-02')).toBeGreaterThan(fuel.findIndex((f) => f['vehicle'] === 'CH-C-V0015'));

    const byVehicle = (await all(admin, `/reports/depenses?vue=vehicule${PERIOD}`, 100)).items;
    const unallocated = byVehicle.filter((r) => r['label'] === 'Non ventilé');
    expect(unallocated.map((r) => r.companyId)).toEqual([companies.A, companies.B, companies.C].sort());
    expect(byVehicle.slice(-3)).toEqual(unallocated);
    const vehicles = byVehicle.slice(0, -3);
    expect([...vehicles].sort((a, b) => collator(a['label'], b['label']) || collator(a.companyId, b.companyId))).toEqual(vehicles);

    const suppliers = (await all(admin, `/reports/depenses?vue=fournisseur${PERIOD}`, 100)).items;
    expect(suppliers.at(-1)?.['label']).toBe('Sans fournisseur');
    expect([...suppliers.slice(0, -1)].sort((a, b) => collator(a['label'], b['label']))).toEqual(suppliers.slice(0, -1));
    // Homonymes : ordre de première apparition dans le détail (dépense la plus récente d'abord).
    const twins = suppliers.filter((s) => s['label'] === 'Garage Commun');
    expect(twins).toHaveLength(2);
    const latest = await Promise.all(twins.map((s) => t.prisma.client.expense.findFirstOrThrow({ where: { supplierId: s.id, status: 'VALIDEE', occurredOn: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T00:00:00Z`) } }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }] })));
    const recency = (e: { occurredOn: Date; createdAt: Date }) => [e.occurredOn.getTime(), e.createdAt.getTime()] as const;
    const [first, second] = latest.map(recency) as [readonly [number, number], readonly [number, number]];
    expect(first[0] > second[0] || (first[0] === second[0] && first[1] >= second[1])).toBe(true);

    const categories = (await all(admin, `/reports/depenses?vue=categorie${PERIOD}`, 100)).items.map((c) => c.id);
    const order = ['ENTRETIEN_REPARATION', 'CARBURANT', 'ASSURANCE', 'LOCATION', 'TAXES', 'PEAGE', 'STATIONNEMENT', 'ACHAT_VEHICULE', 'AUTRE'];
    expect(categories).toEqual(order.filter((c) => categories.includes(c)));

    const docs = (await all(admin, '/reports/documents?vue=echeances', 100)).items;
    const urgency: Record<string, number> = { EXPIRE: 0, MANQUANT: 1, A_RENOUVELER: 2, VALIDE: 3 };
    expect([...docs].sort((a, b) => (urgency[a['status'] as string] as number) - (urgency[b['status'] as string] as number) || collator(a['validTo'] ?? '9999-12-31', b['validTo'] ?? '9999-12-31') || collator(a['object'], b['object']) || collator(a['documentType'], b['documentType']))).toEqual(docs);

    const immobilizations = (await all(admin, `/reports/incidents-immobilisations?vue=immobilisations${PERIOD}`, 100)).items;
    const days = immobilizations.map((i) => Number(i['durationDays']));
    expect([...days].sort((a, b) => b - a)).toEqual(days);
    const causes = (await all(admin, `/reports/incidents-immobilisations?vue=causes${PERIOD}`, 100)).items;
    expect([...causes].sort((a, b) => collator(a['vehicle'], b['vehicle']))).toEqual(causes);

    const late = (await all(admin, `/reports/utilisations?vue=utilisations&lateOnly=true${PERIOD}`, 100)).items;
    expect(late.every((u) => u['late'] === true && Number(u['delayMinutes']) > 0)).toBe(true);
    const departures = late.map((u) => Date.parse(u['checkedOutAt'] as string));
    expect([...departures].sort((a, b) => b - a)).toEqual(departures);
  });

  it('mêmes résultats que les règles uniques : statut opérationnel, fraîcheur, conformité documentaire, retard, durées, volumes et coûts', async () => {
    for (const status of ['DISPONIBLE', 'EN_UTILISATION', 'IMMOBILISE']) {
      const report = await admin.get(`/reports/inventaire?vue=vehicules&operationalStatus=${status}&pageSize=1`);
      const list = await admin.get(`/vehicles?operationalStatus=${status}&pageSize=1`);
      expect(report.body.total, status).toBe(list.body.total);
      expect(report.body.total, status).toBeGreaterThan(0);
      // Même partition (operationalStatusWhere) combinée au cycle de vie : un véhicule hors service n'a pas d'état opérationnel.
      const outOfService = await admin.get(`/vehicles?lifecycleStatus=HORS_SERVICE&operationalStatus=${status}&pageSize=1`);
      const reportOutOfService = await admin.get(`/reports/inventaire?vue=vehicules&lifecycleStatus=HORS_SERVICE&operationalStatus=${status}&pageSize=1`);
      expect([outOfService.body.total, reportOutOfService.body.total], status).toEqual([0, 0]);
      const active = await admin.get(`/vehicles?lifecycleStatus=ACTIF&operationalStatus=${status}&pageSize=1`);
      expect(active.body.total, status).toBe(list.body.total);
    }
    expect((await admin.get('/vehicles?lifecycleStatus=HORS_SERVICE&pageSize=1')).body.total).toBeGreaterThan(0);
    for (const freshness of ['INCONNU', 'A_ACTUALISER', 'A_JOUR']) {
      const report = await admin.get(`/reports/releves?vue=qualite&freshness=${freshness}${PERIOD}&pageSize=1`);
      const list = await admin.get(`/vehicles?freshness=${freshness}&pageSize=1`);
      expect(report.body.total, freshness).toBe(list.body.total);
      expect(report.body.total, freshness).toBeGreaterThan(0);
    }

    // Conformité documentaire : l'évaluation SQL de la page coïncide avec computeDocumentStatus (module documents).
    for (const status of ['EXPIRE', 'MANQUANT', 'A_RENOUVELER', 'VALIDE']) {
      const report = await all(admin, `/reports/documents?vue=echeances&status=${status}`, 100);
      const expected: string[] = [];
      for (const companyId of Object.values(companies)) {
        for (let page = 1; ; page += 1) {
          const res = await admin.get(`/documents/compliance?companyId=${companyId}&status=${status}&page=${page}&pageSize=100`);
          expect(res.status).toBe(200);
          expected.push(...(res.body.items as Array<{ ownerType: string; objectId: string; documentTypeId: string }>).map((r) => `${r.ownerType}:${r.objectId}:${r.documentTypeId}`));
          if ((res.body.items as unknown[]).length < 100) break;
        }
      }
      expect(report.items.map((r) => r.id).sort(), status).toEqual(expected.sort());
      expect(report.total, status).toBeGreaterThan(0);
    }
    const restricted = (await all(admin, '/reports/documents?vue=echeances', 100)).items.filter((r) => r['documentType'] === 'Carte de transport');
    expect(new Set(restricted.map((r) => r.companyId))).toEqual(new Set([companies.B]));
    expect(new Set(restricted.map((r) => r['status']))).toEqual(new Set(['MANQUANT', 'EXPIRE', 'A_RENOUVELER']));
    const blocking = (await all(admin, '/reports/documents?vue=echeances&blocking=true', 100)).items;
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.every((r) => r['blocking'] === true && ['EXPIRE', 'MANQUANT'].includes(r['status'] as string))).toBe(true);

    // Retard (returnDelay, tolérance de 30 min de la société B) recalculé sur tout l'historique.
    const usages = await t.prisma.client.vehicleUsage.findMany({ select: { id: true, companyId: true, expectedReturnAt: true, returnedAt: true, checkedOutAt: true } });
    const start = new Date('2024-08-31T23:00:00.000Z');
    const end = new Date('2026-09-24T22:59:59.999Z');
    const expectedLate = usages
      .filter((u) => u.checkedOutAt <= end && (u.returnedAt === null || u.returnedAt >= start))
      .filter((u) => returnDelay({ expectedReturnAt: u.expectedReturnAt, returnedAt: u.returnedAt, now: new Date(NOW), toleranceMinutes: u.companyId === companies.B ? 30 : 0 }).late)
      .map((u) => u.id)
      .sort();
    const late = await all(admin, `/reports/utilisations?vue=utilisations&lateOnly=true${PERIOD}`, 100);
    expect(late.items.map((u) => u.id).sort()).toEqual(expectedLate);
    const lateB = await all(chefB, `/reports/utilisations?vue=utilisations&lateOnly=true${PERIOD}`, 100);
    expect(lateB.items.every((u) => u.companyId === companies.B)).toBe(true);
    expect(lateB.total).toBe(late.items.filter((u) => u.companyId === companies.B).length);

    // Durées d'immobilisation : union des intervalles découpée à la période (unionWithinPeriod).
    const immobilizations = await t.prisma.client.immobilization.findMany({ include: { causes: true, vehicle: true } });
    const perVehicle = new Map<string, { intervals: Array<{ start: Date; end: Date | null }>; code: string }>();
    for (const i of immobilizations.filter((x) => x.startedAt <= end && (x.endedAt === null || x.endedAt >= start))) {
      const g = perVehicle.get(`${i.companyId}:${i.vehicleId}`) ?? { intervals: [], code: i.vehicle.code };
      g.intervals.push(...immobilizationIntervals(i.causes, { start: i.startedAt, end: i.endedAt }));
      perVehicle.set(`${i.companyId}:${i.vehicleId}`, g);
    }
    const expectedDurations = [...perVehicle].map(([key, g]) => ({ key, ms: unionWithinPeriod(g.intervals, { from: start, to: end }, new Date(NOW)).totalMs, code: g.code })).sort((a, b) => b.ms - a.ms || a.code.localeCompare(b.code));
    const reported = (await all(admin, `/reports/incidents-immobilisations?vue=immobilisations${PERIOD}`, 100)).items;
    expect(reported.map((r) => [r.id, r['durationDays']])).toEqual(expectedDurations.map((e) => [e.key, durationDays(e.ms).toFixed(1)]));

    // Carburant par véhicule : sommes exactes des pleins validés de la période.
    const entries = await t.prisma.client.fuelEntry.findMany({ where: { status: 'VALIDE', filledAt: { gte: start, lte: end } } });
    const fuel = (await all(admin, `/reports/carburant?vue=vehicules${PERIOD}`, 100)).items;
    expect(fuel.length).toBe(new Set(entries.map((e) => `${e.companyId}:${e.vehicleId}:${e.energy}`)).size);
    for (const row of fuel.slice(0, 10)) {
      const own = entries.filter((e) => `${e.companyId}:${e.vehicleId}:${e.energy}` === row.id);
      expect(row['entries']).toBe(own.length);
      expect(row['liters']).toBe(own.reduce((s, e) => s.plus(e.liters.toString()), new Decimal(0)).toFixed(3));
      expect(row['totalAmount']).toBe(own.reduce((s, e) => s.plus(e.totalAmount.toString()), new Decimal(0)).toFixed(3));
    }

    // Dépenses : totaux du rapport = synthèse du registre ; somme des lignes par véhicule = coût d'exploitation net.
    const expenses = await admin.get(`/reports/depenses?vue=vehicule${PERIOD}&pageSize=5`);
    const summary = await admin.get(`/expenses/summary?from=${FROM}&to=${TO}`);
    expect(summary.status).toBe(200);
    const meta = expenses.body.meta.summary as Array<{ label: string; value: string }>;
    expect(meta[0]?.value).toBe(summary.body.operating.net);
    expect(meta[1]?.value).toBe(summary.body.unallocated.net);
    expect(meta[2]?.value).toBe(summary.body.excludedFromOperatingCost.net);
    expect(Number(meta[3]?.value)).toBe(summary.body.operating.count + summary.body.excludedFromOperatingCost.count);
    const rows = (await all(admin, `/reports/depenses?vue=vehicule${PERIOD}`, 100)).items;
    expect(rows.reduce((s, r) => s.plus(r['operatingNet'] as string), new Decimal(0)).toFixed(3)).toBe(summary.body.operating.net);
    const byCategory = (await all(admin, `/reports/depenses?vue=categorie${PERIOD}`, 100)).items;
    for (const c of summary.body.byCategory as Array<{ category: string; net: string; count: number }>) {
      const row = byCategory.find((r) => r.id === c.category);
      expect(row?.['operatingNet'], c.category).toBe(c.net);
    }
    // Chaque vue regroupée répartit exactement le registre : sommes des groupes = synthèse (lignes validées comprises).
    const validatedLines = summary.body.operating.count + summary.body.excludedFromOperatingCost.count;
    for (const vue of ['categorie', 'vehicule', 'societe', 'fournisseur']) {
      const groups = (await all(admin, `/reports/depenses?vue=${vue}${PERIOD}`, 100)).items;
      expect(groups.reduce((s, r) => s.plus(r['operatingNet'] as string), new Decimal(0)).toFixed(3), vue).toBe(summary.body.operating.net);
      expect(groups.reduce((s, r) => s.plus(r['excludedNet'] as string), new Decimal(0)).toFixed(3), vue).toBe(summary.body.excludedFromOperatingCost.net);
      expect(groups.reduce((s, r) => s + Number(r['count']), 0), vue).toBe(validatedLines);
    }
  });

  it('une page ne lit que sa part : lignes renvoyées par la base proportionnelles à la page, jamais l’historique que la vue résume (CDC 17.2)', async () => {
    // Contre-épreuve de la sonde : une lecture volontairement complète est bien vue.
    const control = await rowsReadDuring(() => t.prisma.client.odometerReading.findMany({ select: { id: true } }));
    expect(Math.max(...control)).toBe(2_400);
    const sizeOf = async (table: string) => Number((await t.prisma.client.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS "n" FROM "${table}"`))[0]?.n ?? 0);
    const history = new Map<string, number>();
    for (const table of new Set(ALL_VIEWS.map((v) => v.history))) history.set(table, await sizeOf(table));
    expect(history.get('Expense')).toBeGreaterThan(2_000);
    for (const { path, history: table } of ALL_VIEWS) {
      // Première lecture hors mesure : matérialisations du jour (statuts d'entretien) déjà faites.
      const warm = await admin.get(`${path}&page=1&pageSize=5`);
      expect(warm.status, `${path} ${JSON.stringify(warm.body)}`).toBe(200);
      let small: { status: number } = { status: 0 };
      let big: { status: number } = { status: 0 };
      const smallRows = await rowsReadDuring(async () => (small = await admin.get(`${path}&page=1&pageSize=5`)));
      const bigRows = await rowsReadDuring(async () => (big = await admin.get(`${path}&page=1&pageSize=25`)));
      expect([small.status, big.status], path).toEqual([200, 200]);
      const read = smallRows.reduce((a, b) => a + b, 0);
      const size = history.get(table) ?? 0;
      // Historique suffisant pour que la mesure distingue une page de l'historique entier.
      if (size >= 200) expect(read, `${path} : ${read} lignes lues pour 5 lignes affichées, ${table} en compte ${size}`).toBeLessThan(size / 2);
      expect(read, path).toBeLessThanOrEqual(bigRows.reduce((a, b) => a + b, 0));
    }
  });

  it('consommation du rapport carburant : calcul groupé des véhicules identique au calcul unitaire de chacun (règle unique consumption.ts, CDC 8.3)', async () => {
    const fuel = t.app.get(FuelService);
    const contextOf = async (n: number): Promise<RequestContext> => {
      const user = await t.prisma.client.user.findFirstOrThrow({ where: { email: loadUserEmail(n) }, select: { id: true, organizationId: true } });
      return (await t.app.get(ContextBuilderService).forUser(user.id, user.organizationId, `test-consommation-${n}`)) as RequestContext;
    };
    const adminCtx = await contextOf(1);
    const ids = (await t.prisma.client.vehicle.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((v) => v.id);
    // Périodes bornées, bornée par la fin seulement et non bornée : chaque véhicule, retenu ou N/D avec ses motifs.
    for (const period of [{ from: FROM, to: TO }, { from: '2026-06-26', to: TO }, { to: '2025-12-31' }, {}]) {
      const grouped = await fuel.consumptionMany(adminCtx, ids, period);
      expect(grouped.size, JSON.stringify(period)).toBe(ids.length);
      let available = 0;
      for (const id of ids) {
        const unit = await fuel.consumption(adminCtx, id, period);
        expect(grouped.get(id), `${id} ${JSON.stringify(period)}`).toEqual(unit);
        if (unit.available) available += 1;
      }
      if (period.from || period.to) expect(available, JSON.stringify(period)).toBeGreaterThan(0);
    }
    // Périmètre : pour le chef de parc B, seuls les véhicules de B sont calculés ; les autres sont hors périmètre (404 unitaire).
    const chefBCtx = await contextOf(7);
    const vehiclesB = await t.prisma.client.vehicle.findMany({ where: { companyId: companies.B }, select: { id: true } });
    const groupedB = await fuel.consumptionMany(chefBCtx, ids, { from: FROM, to: TO });
    expect([...groupedB.keys()].sort()).toEqual(vehiclesB.map((v) => v.id).sort());
    for (const id of ids) {
      if (groupedB.has(id)) expect(groupedB.get(id)).toEqual(await fuel.consumption(chefBCtx, id, { from: FROM, to: TO }));
      else await expect(fuel.consumption(chefBCtx, id, { from: FROM, to: TO })).rejects.toBeInstanceOf(NotFoundOrOutOfScopeError);
    }

    // Rapport (API) : chaque ligne reprend la consommation unitaire du véhicule (GET /vehicles/:id/consumption).
    const unitViews = new Map<string, { totals: Array<{ energy: string; litersPer100Km: string | null }>; intervals: Array<{ endFuelEntryId: string; retained: boolean; litersPer100Km: string | null }> }>();
    const unitOf = async (vehicleId: string) => {
      const known = unitViews.get(vehicleId);
      if (known) return known;
      const res = await admin.get(`/vehicles/${vehicleId}/consumption?from=${FROM}&to=${TO}`);
      expect(res.status).toBe(200);
      unitViews.set(vehicleId, res.body);
      return res.body as typeof known & object;
    };
    const vehicleIdsByCode = new Map((await t.prisma.client.vehicle.findMany({ select: { id: true, code: true } })).map((v) => [v.code, v.id]));
    const byVehicle = await all(admin, `/reports/carburant?vue=vehicules${PERIOD}`, 100);
    expect(byVehicle.items.length).toBeGreaterThan(25);
    let compared = 0;
    for (const row of byVehicle.items) {
      const unit = await unitOf(vehicleIdsByCode.get(row['vehicle'] as string) as string);
      const total = unit.totals.find((x) => x.energy === row['energy']);
      expect(row['consumption'] ?? null, `${String(row['vehicle'])} ${String(row['energy'])}`).toBe(total?.litersPer100Km ?? null);
      if (row['consumption'] !== null) compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
    const entries = await admin.get(`/reports/carburant?vue=pleins${PERIOD}&page=1&pageSize=50`);
    expect(entries.status).toBe(200);
    for (const row of entries.body.items as Item[]) {
      if (row['fullTank'] !== true) continue;
      const entry = await t.prisma.client.fuelEntry.findUniqueOrThrow({ where: { id: row.id }, select: { vehicleId: true } });
      const interval = (await unitOf(entry.vehicleId)).intervals.find((i) => i.endFuelEntryId === row.id);
      expect(row['consumption'] ?? null, row.id).toBe(interval?.retained ? interval.litersPer100Km : null);
    }
  });

  it('périmètre en SQL : le chef de parc B ne reçoit que les lignes de B, totaux compris (T01)', async () => {
    for (const { path } of VIEWS.filter((v) => !v.path.includes('societe') && !v.path.includes('categorie') && !v.path.includes('fournisseur'))) {
      const own = await all(chefB, path, 100);
      expect(own.items.every((i) => i.companyId === companies.B), path).toBe(true);
      const filtered = await all(admin, `${path}&companyId=${companies.B}`, 100);
      expect(own.total, path).toBe(filtered.total);
    }
    const outside = await chefB.get(`/reports/documents?vue=echeances&companyId=${companies.A}`);
    expect(outside.status).toBe(404);
    expect(localDate(new Date(NOW), 'Africa/Tunis')).toBe('2026-09-24');
  });
});
