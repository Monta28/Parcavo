import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

type Company = 'A' | 'B' | 'C';
type Lifecycle = 'ACTIF' | 'HORS_SERVICE' | 'CEDE' | 'ARCHIVE';

interface Indicator {
  key: string;
  label: string;
  definition: string;
  kind: 'ETAT' | 'FLUX';
  value: number | string;
  unit: string;
  denominator: { key: string; value: number } | null;
  parentKey: string | null;
  asOf: string | null;
  period: { from: string; to: string } | null;
  justification: { path: string; query: Record<string, string>; field: string; screen: { path: string; query: Record<string, string> } | null };
}

interface Dashboard {
  asOf: string;
  timezone: string;
  today: string;
  period: { from: string; to: string };
  periodIsDefault: boolean;
  companyId: string | null;
  indicators: Indicator[];
  omitted: Array<{ key: string; reason: string }>;
}

const NOW = '2026-09-24T10:00:00.000Z'; // 11:00 à Tunis

/** Valeurs attendues par société (scénario ci-dessous). */
const EXPECTED: Record<Company, Record<string, number | string>> = {
  A: {
    'vehicles.active': 5,
    'vehicles.active.nonCompliant': 2,
    'vehicles.available': 2,
    'vehicles.available.nonCompliant': 1,
    'vehicles.inUse': 2,
    'vehicles.inUse.nonCompliant': 0,
    'vehicles.immobilized': 1,
    'vehicles.immobilized.nonCompliant': 1,
    'vehicles.outOfService': 1,
    'maintenance.urgent': 2,
    'maintenance.urgent.due': 1,
    'maintenance.urgent.overdue': 1,
    'documents.expired': 2,
    'documents.missing': 1,
    'odometer.stale': 1,
    'odometer.unknown': 1,
    'usages.returnDue': 2,
    'usages.returnDue.late': 1,
    'interventions.completed': 1,
    'costs.operating': '80.250',
    'alerts.critical': 1,
    'alerts.urgent': 1,
    'alerts.attention': 1,
    'alerts.info': 0,
  },
  B: {
    'vehicles.active': 3,
    'vehicles.active.nonCompliant': 2,
    'vehicles.available': 1,
    'vehicles.available.nonCompliant': 1,
    'vehicles.inUse': 1,
    'vehicles.inUse.nonCompliant': 0,
    'vehicles.immobilized': 1,
    'vehicles.immobilized.nonCompliant': 1,
    'vehicles.outOfService': 0,
    'maintenance.urgent': 1,
    'maintenance.urgent.due': 0,
    'maintenance.urgent.overdue': 1,
    'documents.expired': 1,
    'documents.missing': 1,
    'odometer.stale': 1,
    'odometer.unknown': 1,
    'usages.returnDue': 1,
    'usages.returnDue.late': 1,
    'interventions.completed': 1,
    'costs.operating': '40.000',
    'alerts.critical': 1,
    'alerts.urgent': 0,
    'alerts.attention': 0,
    'alerts.info': 0,
  },
  C: {
    'vehicles.active': 1,
    'vehicles.active.nonCompliant': 0,
    'vehicles.available': 1,
    'vehicles.available.nonCompliant': 0,
    'vehicles.inUse': 0,
    'vehicles.inUse.nonCompliant': 0,
    'vehicles.immobilized': 0,
    'vehicles.immobilized.nonCompliant': 0,
    'vehicles.outOfService': 1,
    'maintenance.urgent': 1,
    'maintenance.urgent.due': 1,
    'maintenance.urgent.overdue': 0,
    'documents.expired': 0,
    'documents.missing': 1,
    'odometer.stale': 0,
    'odometer.unknown': 0,
    'usages.returnDue': 0,
    'usages.returnDue.late': 0,
    'interventions.completed': 0,
    'costs.operating': '7.125',
    'alerts.critical': 0,
    'alerts.urgent': 1,
    'alerts.attention': 0,
    'alerts.info': 1,
  },
};

function qs(query: Record<string, string>): string {
  const s = new URLSearchParams(query).toString();
  return s ? `?${s}` : '';
}

function byKey(d: Dashboard): Record<string, Indicator> {
  return Object.fromEntries(d.indicators.map((i) => [i.key, i]));
}

function values(d: Dashboard): Record<string, number | string> {
  return Object.fromEntries(d.indicators.map((i) => [i.key, i.value]));
}

describe('Tableau de bord (CDC 11.1, 10.2 — D-269 ; T01, T02)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;
  const v: Record<string, string> = {};
  const usages: Record<string, string> = {};

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
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    await seedScenario();
  });

  // ---------------------------------------------------------------------------
  // Scénario : trois sociétés, états du parc, échéances, documents, relevés, utilisations, coûts.
  // ---------------------------------------------------------------------------

  async function vehicle(name: string, company: Company, lifecycle: Lifecycle = 'ACTIF'): Promise<string> {
    const id = await createVehicle(t.prisma, f, company, { code: name });
    if (lifecycle !== 'ACTIF') await t.prisma.client.vehicle.update({ where: { id }, data: { lifecycleStatus: lifecycle } });
    v[name] = id;
    return id;
  }

  async function driver(company: Company): Promise<string> {
    const d = await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies[company], code: `D-${randomUUID().slice(0, 8)}`, firstName: 'Test', lastName: 'Conducteur' } });
    return d.id;
  }

  async function usage(name: string, company: Company, driverId: string, expectedReturnAt: string): Promise<void> {
    const u = await t.prisma.client.vehicleUsage.create({
      data: { organizationId: f.organizationId, companyId: f.companies[company], vehicleId: v[name] as string, driverId, purpose: 'mission', checkedOutAt: new Date('2026-09-22T08:00:00Z'), expectedReturnAt: new Date(expectedReturnAt), checkoutWithoutReading: true, checkoutExceptionReason: 'test' },
    });
    usages[name] = u.id;
  }

  async function immobilize(name: string, company: Company): Promise<void> {
    await t.prisma.client.immobilization.create({ data: { organizationId: f.organizationId, companyId: f.companies[company], vehicleId: v[name] as string, startedAt: new Date('2026-09-23T09:00:00Z'), status: 'ACTIVE' } });
  }

  async function reading(name: string, company: Company, observedAt: string): Promise<void> {
    const segment = await t.prisma.client.odometerSegment.create({ data: { organizationId: f.organizationId, vehicleId: v[name] as string, sequence: 1, startedAt: new Date('2026-01-01T00:00:00Z'), startPhysicalKm: '0', startCumulativeKm: '0' } });
    await t.prisma.client.odometerReading.create({
      data: { organizationId: f.organizationId, companyId: f.companies[company], vehicleId: v[name] as string, segmentId: segment.id, source: 'MANUAL', context: 'RELEVE_LIBRE', status: 'ACCEPTE', physicalKm: '1000', cumulativeKm: '1000', observedAt: new Date(observedAt) },
    });
  }

  async function assurance(typeId: string, name: string, company: Company, validTo: string): Promise<void> {
    await t.prisma.client.documentVersion.create({ data: { organizationId: f.organizationId, companyId: f.companies[company], documentTypeId: typeId, ownerType: 'VEHICULE', vehicleId: v[name] as string, validFrom: new Date('2025-09-01T00:00:00Z'), validTo: new Date(`${validTo}T00:00:00Z`) } });
  }

  async function plan(agent: Agent, typeId: string, name: string, baseDate: string, expected: string): Promise<void> {
    const res = await agent.post('/maintenance-plans', { vehicleId: v[name], maintenanceTypeId: typeId, intervalMonths: 6, base: { baseMode: 'DERNIERE_OPERATION', baseDate } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe(expected);
  }

  async function intervention(name: string, company: Company, performedOn: string): Promise<void> {
    await t.prisma.client.intervention.create({
      data: { organizationId: f.organizationId, companyId: f.companies[company], vehicleId: v[name] as string, reference: `INT-${randomUUID().slice(0, 8)}`, kind: 'PREVENTIF', status: 'TERMINEE', performedOn: new Date(`${performedOn}T00:00:00Z`), completedAt: new Date(`${performedOn}T12:00:00Z`) },
    });
  }

  async function expense(agent: Agent, body: Record<string, unknown>): Promise<void> {
    const res = await agent.post('/expenses', body).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function seedScenario(): Promise<void> {
    // Société A : 5 actifs (vA3 immobilisé ET en utilisation), 1 hors service, 1 cédé, 1 archivé.
    await vehicle('vA1', 'A');
    await vehicle('vA2', 'A');
    await vehicle('vA3', 'A');
    await vehicle('vA4', 'A', 'HORS_SERVICE');
    await vehicle('vA5', 'A', 'CEDE');
    await vehicle('vA6', 'A', 'ARCHIVE');
    await vehicle('vA7', 'A');
    await vehicle('vA8', 'A');
    // Société B : disponible, immobilisé, en utilisation (retour dépassé).
    await vehicle('vB1', 'B');
    await vehicle('vB2', 'B');
    await vehicle('vB3', 'B');
    // Société C : un disponible, un hors service.
    await vehicle('vC1', 'C');
    await vehicle('vC2', 'C', 'HORS_SERVICE');

    const a3 = await driver('A');
    await usage('vA2', 'A', f.drivers.a1, '2026-09-24T22:30:00Z'); // 23:30 à Tunis : retour prévu aujourd'hui
    await usage('vA3', 'A', f.drivers.a2, '2026-09-23T18:00:00Z'); // dépassé
    await usage('vA8', 'A', a3, '2026-09-24T23:30:00Z'); // 00:30 le 25 à Tunis : demain
    await usage('vB3', 'B', f.drivers.b1, '2026-09-20T18:00:00Z'); // dépassé
    await immobilize('vA3', 'A');
    await immobilize('vB2', 'B');

    // Relevés acceptés : seuil de fraîcheur de 7 jours par défaut.
    await reading('vA1', 'A', '2026-09-01T08:00:00Z'); // ancien
    await reading('vA2', 'A', '2026-09-23T08:00:00Z');
    await reading('vA7', 'A', '2026-09-22T08:00:00Z');
    await reading('vA8', 'A', '2026-09-24T08:00:00Z');
    await reading('vB1', 'B', '2026-09-01T08:00:00Z'); // ancien
    await reading('vB3', 'B', '2026-09-23T08:00:00Z');
    await reading('vC1', 'C', '2026-09-23T08:00:00Z');
    // vA3 et vB2 : aucun relevé (INCONNU).

    // Document bloquant (assurance) : manquant, expiré ou valide.
    const type = await t.prisma.client.documentType.create({ data: { organizationId: f.organizationId, code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true } });
    await assurance(type.id, 'vA2', 'A', '2027-01-01');
    await assurance(type.id, 'vA3', 'A', '2026-09-20'); // expiré
    await assurance(type.id, 'vA4', 'A', '2026-09-01'); // expiré, véhicule hors service
    await assurance(type.id, 'vA7', 'A', '2027-01-01');
    await assurance(type.id, 'vA8', 'A', '2026-09-24'); // valable jusqu'à ce soir
    await assurance(type.id, 'vB2', 'B', '2026-09-10'); // expiré
    await assurance(type.id, 'vB3', 'B', '2027-01-01');
    await assurance(type.id, 'vC1', 'C', '2027-01-01');
    // Manquants : vA1, vB1 (actifs), vC2 (hors service) ; vA5, vA6 cédé/archivé hors conformité.

    // Plans d'entretien (intervalle 6 mois) : à faire aujourd'hui, en retard, à jour.
    const vidange = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    expect(vidange.status, JSON.stringify(vidange.body)).toBe(201);
    const typeId = vidange.body.id as string;
    await plan(chefA, typeId, 'vA1', '2026-03-24', 'A_FAIRE');
    await plan(chefA, typeId, 'vA2', '2026-03-01', 'EN_RETARD');
    await plan(chefA, typeId, 'vA7', '2026-09-01', 'A_JOUR');
    await plan(chefB, typeId, 'vB1', '2026-02-15', 'EN_RETARD');
    await plan(admin, typeId, 'vC1', '2026-03-24', 'A_FAIRE');

    // Interventions terminées : septembre (période par défaut) et août.
    await intervention('vA2', 'A', '2026-09-10');
    await intervention('vA7', 'A', '2026-08-20');
    await intervention('vB1', 'B', '2026-09-20');

    // Registre des dépenses : dépense, avoir, achat de véhicule exclu, hors période.
    await expense(chefA, { vehicleId: v['vA1'], occurredOn: '2026-09-10', category: 'PEAGE', amount: '100.500' });
    await expense(chefA, { vehicleId: v['vA1'], occurredOn: '2026-09-12', category: 'PEAGE', kind: 'AVOIR', amount: '20.250' });
    await expense(chefA, { vehicleId: v['vA1'], occurredOn: '2026-09-05', category: 'ACHAT_VEHICULE', amount: '50000' });
    await expense(chefA, { vehicleId: v['vA7'], occurredOn: '2026-08-31', category: 'PEAGE', amount: '999' });
    await expense(chefB, { vehicleId: v['vB1'], occurredOn: '2026-09-15', category: 'STATIONNEMENT', amount: '40' });
    await expense(admin, { vehicleId: v['vC1'], occurredOn: '2026-09-01', category: 'PEAGE', amount: '7.125' });

    // Alertes : celles des plans (A_FAIRE → URGENT, EN_RETARD → CRITIQUE) plus une ATTENTION en A,
    // une INFO en C et une alerte résolue (non comptée).
    await alert('A', 'vA1', 'KILOMETRAGE_ANCIEN', 'ATTENTION');
    await alert('C', 'vC1', 'RELEVE_A_VALIDER', 'INFO');
    await alert('A', 'vA7', 'KILOMETRAGE_ABSENT', 'CRITIQUE', 'RESOLUE');
  }

  async function alert(company: Company, name: string, type: 'KILOMETRAGE_ANCIEN' | 'RELEVE_A_VALIDER' | 'KILOMETRAGE_ABSENT', severity: 'INFO' | 'ATTENTION' | 'CRITIQUE', status: 'ACTIVE' | 'RESOLUE' = 'ACTIVE'): Promise<void> {
    await t.prisma.client.alert.create({
      data: {
        organizationId: f.organizationId,
        companyId: f.companies[company],
        type,
        severity,
        status,
        objectType: 'Vehicle',
        objectId: v[name] as string,
        vehicleId: v[name] as string,
        occurrenceKey: 'test',
        title: `Alerte de test — ${name}`,
        message: 'Alerte de test.',
        condition: {},
        actionPath: `/vehicules/${v[name]}`,
        triggeredAt: new Date('2026-09-23T08:00:00Z'),
        lastEvaluatedAt: new Date('2026-09-23T08:00:00Z'),
        ...(status === 'RESOLUE' ? { resolvedAt: new Date('2026-09-23T09:00:00Z'), resolutionReason: 'test' } : {}),
      },
    });
  }

  async function dashboard(agent: Agent, query: Record<string, string> = {}): Promise<Dashboard> {
    const res = await agent.get(`/dashboard${qs(query)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Dashboard;
  }

  /** Valeur de la liste justificative appelée avec la même requête (total, ou champ désigné). */
  async function justified(agent: Agent, indicator: Indicator): Promise<unknown> {
    const res = await agent.get(`${indicator.justification.path}${qs(indicator.justification.query)}`);
    expect(res.status, `${indicator.key} : ${JSON.stringify(res.body)}`).toBe(200);
    return indicator.justification.field.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], res.body);
  }

  async function expectJustified(agent: Agent, d: Dashboard): Promise<void> {
    for (const indicator of d.indicators) {
      expect(await justified(agent, indicator), indicator.key).toEqual(indicator.value);
    }
  }

  async function listIds(agent: Agent, path: string, query: Record<string, string>): Promise<string[]> {
    const res = await agent.get(`${path}${qs({ ...query, pageSize: '100' })}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as Array<{ id: string }>).map((i) => i.id).sort();
  }

  it('T02 — administrateur : totaux consolidés A+B+C, puis filtre A ; chaque total égale sa liste justificative', async () => {
    const all = await dashboard(admin);
    expect(all).toMatchObject({ asOf: NOW, timezone: 'Africa/Tunis', today: '2026-09-24', period: { from: '2026-09-01', to: '2026-09-30' }, periodIsDefault: true, companyId: null, omitted: [] });

    const perCompany = {} as Record<Company, Dashboard>;
    for (const c of ['A', 'B', 'C'] as const) {
      perCompany[c] = await dashboard(admin, { companyId: f.companies[c] });
      expect(perCompany[c].companyId).toBe(f.companies[c]);
      expect(values(perCompany[c])).toEqual(EXPECTED[c]);
    }
    // Consolidation : chaque total = somme des trois sociétés (montants en décimal exact).
    const consolidated = values(all);
    expect(Object.keys(consolidated).sort()).toEqual(Object.keys(EXPECTED.A).sort());
    for (const [key, value] of Object.entries(consolidated)) {
      if (typeof value === 'string') {
        const sum = (['A', 'B', 'C'] as const).reduce((s, c) => s.plus(EXPECTED[c][key] as string), new Decimal(0));
        expect(value, key).toBe(sum.toFixed(3));
      } else {
        expect(value, key).toBe((['A', 'B', 'C'] as const).reduce((s, c) => s + (EXPECTED[c][key] as number), 0));
      }
    }
    expect(consolidated['costs.operating']).toBe('127.375');

    // Justification : la liste appelée avec la même requête donne le même total (consolidé puis A).
    await expectJustified(admin, all);
    await expectJustified(admin, perCompany.A);
    for (const indicator of perCompany.A.indicators) expect(indicator.justification.query['companyId'], indicator.key).toBe(f.companies.A);
    for (const indicator of all.indicators) expect(indicator.justification.query['companyId'], indicator.key).toBeUndefined();

    // Forme des indicateurs : état horodaté ou flux sur la période, dénominateur explicite.
    const ind = byKey(perCompany.A);
    expect(ind['vehicles.available']).toMatchObject({ kind: 'ETAT', asOf: NOW, period: null, unit: 'vehicules', denominator: { key: 'vehicles.active', value: 5 } });
    expect(ind['vehicles.available.nonCompliant']).toMatchObject({ parentKey: 'vehicles.available', denominator: { key: 'vehicles.available', value: 2 } });
    expect(ind['odometer.stale']?.denominator).toMatchObject({ key: 'vehicles.active', value: 5 });
    expect(ind['costs.operating']).toMatchObject({ kind: 'FLUX', asOf: null, period: { from: '2026-09-01', to: '2026-09-30' }, unit: 'TND', justification: { path: '/expenses/summary', field: 'operating.net' } });
    expect(ind['interventions.completed']).toMatchObject({ kind: 'FLUX', justification: { path: '/interventions', query: { companyId: f.companies.A, status: 'TERMINEE', from: '2026-09-01', to: '2026-09-30' }, screen: { path: '/interventions', query: { statut: 'TERMINEE', du: '2026-09-01', au: '2026-09-30' } } } });
    expect(ind['vehicles.immobilized']?.justification).toMatchObject({ path: '/vehicles', query: { companyId: f.companies.A, operationalStatus: 'IMMOBILISE' }, field: 'total', screen: { path: '/vehicules', query: { statut: 'IMMOBILISE' } } });
    expect(ind['maintenance.urgent']?.justification).toMatchObject({ path: '/maintenance-plans', query: { urgent: 'true' }, screen: { path: '/entretiens', query: { urgent: '1' } } });
    expect(ind['documents.expired']?.justification).toMatchObject({ path: '/documents/compliance', query: { status: 'EXPIRE' }, screen: { path: '/documents', query: { statut: 'EXPIRE' } } });
  });

  it('T01 — chef A : aucune donnée ni compteur de B ; société B demandée → 404 ; conducteur → 403', async () => {
    const mine = await dashboard(chefA);
    expect(values(mine)).toEqual(EXPECTED.A);
    expect(values(await dashboard(chefA, { companyId: f.companies.A }))).toEqual(EXPECTED.A);
    await expectJustified(chefA, mine);

    const other = await chefA.get(`/dashboard${qs({ companyId: f.companies.B })}`);
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('INTROUVABLE');
    expect(JSON.stringify(other.body)).not.toMatch(/vehicles|indicators|total/);
    // Société inexistante : même réponse que hors périmètre, y compris pour l'administrateur.
    expect((await admin.get(`/dashboard${qs({ companyId: randomUUID() })}`)).status).toBe(404);

    expect(values(await dashboard(chefB))).toEqual(EXPECTED.B);
    const driver = await conducteurA.get('/dashboard');
    expect(driver.status).toBe(403);
    expect(driver.body.code).toBe('ACTION_INTERDITE');
  });

  it('partition exclusive : un véhicule immobilisé en utilisation compte une seule fois ; hors service, cédé et archivé exclus du disponible', async () => {
    const ind = byKey(await dashboard(admin, { companyId: f.companies.A }));
    const available = await listIds(admin, '/vehicles', { companyId: f.companies.A, operationalStatus: 'DISPONIBLE' });
    const inUse = await listIds(admin, '/vehicles', { companyId: f.companies.A, operationalStatus: 'EN_UTILISATION' });
    const immobilized = await listIds(admin, '/vehicles', { companyId: f.companies.A, operationalStatus: 'IMMOBILISE' });
    expect(immobilized).toEqual([v['vA3']]);
    expect(inUse).toEqual([v['vA2'], v['vA8']].sort());
    expect(available).toEqual([v['vA1'], v['vA7']].sort());
    for (const excluded of ['vA4', 'vA5', 'vA6']) expect([...available, ...inUse, ...immobilized]).not.toContain(v[excluded]);
    // Groupes disjoints dont la somme est le parc actif.
    expect(new Set([...available, ...inUse, ...immobilized]).size).toBe(5);
    expect((ind['vehicles.available']?.value as number) + (ind['vehicles.inUse']?.value as number) + (ind['vehicles.immobilized']?.value as number)).toBe(ind['vehicles.active']?.value);
    expect(ind['vehicles.outOfService']?.value).toBe(1);

    // « Dont non conformes » : même règle que la synthèse du véhicule (documents bloquants manquants ou expirés).
    const nonCompliant = await listIds(admin, '/vehicles', { companyId: f.companies.A, lifecycleStatus: 'ACTIF', blockingDocuments: 'true' });
    expect(nonCompliant).toEqual([v['vA1'], v['vA3']].sort());
    for (const name of ['vA1', 'vA2', 'vA3', 'vA7', 'vA8']) {
      const synthesis = await admin.get(`/vehicles/${v[name]}/synthesis`);
      expect(synthesis.status).toBe(200);
      expect(synthesis.body.documentCompliance.blocking > 0, name).toBe(nonCompliant.includes(v[name] as string));
    }
    expect(await listIds(admin, '/vehicles', { companyId: f.companies.A, lifecycleStatus: 'ACTIF', blockingDocuments: 'false' })).toEqual([v['vA2'], v['vA7'], v['vA8']].sort());

    // La levée d'une immobilisation déplace le véhicule vers « en utilisation », sans double compte.
    await t.prisma.client.immobilization.updateMany({ where: { vehicleId: v['vA3'] }, data: { status: 'TERMINEE', endedAt: new Date(NOW) } });
    const after = byKey(await dashboard(admin, { companyId: f.companies.A }));
    expect([after['vehicles.available']?.value, after['vehicles.inUse']?.value, after['vehicles.immobilized']?.value, after['vehicles.active']?.value]).toEqual([2, 3, 0, 5]);
    expect(after['vehicles.inUse.nonCompliant']?.value).toBe(1);
  });

  it('coûts : absents sans costs.read (jamais 0) ; période explicite en dates civiles inclusives', async () => {
    const reader = await dashboard(lecteurA);
    expect(byKey(reader)['costs.operating']).toBeUndefined();
    expect(reader.omitted).toEqual([expect.objectContaining({ key: 'costs.operating', reason: expect.stringContaining('costs.read') })]);
    expect(values(reader)['vehicles.active']).toBe(5);
    await expectJustified(lecteurA, reader);
    expect((await lecteurA.get('/expenses/summary')).status).toBe(403);

    const august = await dashboard(admin, { companyId: f.companies.A, from: '2026-08-01', to: '2026-08-31' });
    expect(august).toMatchObject({ period: { from: '2026-08-01', to: '2026-08-31' }, periodIsDefault: false });
    const ind = byKey(august);
    expect(ind['costs.operating']?.value).toBe('999.000');
    expect(ind['interventions.completed']?.value).toBe(1);
    // Les états restent instantanés : la période ne les modifie pas.
    expect(ind['vehicles.available']?.value).toBe(2);
    await expectJustified(admin, august);
    // Borne incluse : un seul jour.
    expect(byKey(await dashboard(admin, { companyId: f.companies.A, from: '2026-09-12', to: '2026-09-12' }))['costs.operating']?.value).toBe('-20.250');

    const partial = await admin.get(`/dashboard${qs({ from: '2026-09-01' })}`);
    expect(partial.status).toBe(422);
    expect(partial.body).toMatchObject({ code: 'PERIODE_INCOMPLETE', fieldErrors: { to: [expect.any(String)] } });
    const reversed = await admin.get(`/dashboard${qs({ from: '2026-09-30', to: '2026-09-01' })}`);
    expect(reversed.status).toBe(422);
    expect(reversed.body.code).toBe('PERIODE_INVALIDE');
    expect((await admin.get(`/dashboard${qs({ from: '2026-02-30', to: '2026-03-31' })}`)).status).toBe(422);
    expect((await admin.get(`/dashboard${qs({ from: '01/09/2026', to: '2026-09-30' })}`)).status).toBe(422);
  });

  it('coûts en vue consolidée (D-111) : seulement les sociétés avec costs.read, périmètre affiché ; société sans costs.read → absent', async () => {
    // Chef en A (costs.read), lecteur en B (sans costs.read).
    await t.prisma.client.membership.create({ data: { organizationId: f.organizationId, userId: f.users.chefA, companyId: f.companies.B, role: 'LECTEUR' } });
    const all = await dashboard(chefA);
    const costs = byKey(all)['costs.operating'];
    expect(costs).toMatchObject({ value: EXPECTED.A['costs.operating'], label: 'Coûts d’exploitation (A)', justification: { path: '/expenses/summary', query: { from: '2026-09-01', to: '2026-09-30' }, field: 'operating.net' } });
    expect(costs?.justification.query['companyId']).toBeUndefined();
    expect(costs?.definition).toContain('non comprises : B');
    expect(all.omitted).toEqual([]);
    // Les autres indicateurs couvrent A et B ; chaque total égale sa liste justificative (coûts : A seul).
    expect(values(all)['vehicles.active']).toBe((EXPECTED.A['vehicles.active'] as number) + (EXPECTED.B['vehicles.active'] as number));
    await expectJustified(chefA, all);

    const onlyB = await dashboard(chefA, { companyId: f.companies.B });
    expect(byKey(onlyB)['costs.operating']).toBeUndefined();
    expect(onlyB.omitted).toEqual([{ key: 'costs.operating', label: 'Coûts d’exploitation', reason: expect.stringContaining('société affichée') }]);
    expect(values(onlyB)['vehicles.active']).toBe(EXPECTED.B['vehicles.active']);
    // Société A seule : coûts complets, libellé sans restriction.
    expect(byKey(await dashboard(chefA, { companyId: f.companies.A }))['costs.operating']).toMatchObject({ label: 'Coûts d’exploitation', value: EXPECTED.A['costs.operating'] });

    // Filtre sur un véhicule (11.1) : seule compte la société qui le gère. Véhicule de B (sans costs.read) :
    // indicateur absent, jamais un 0 calculé sur A ; véhicule de A : coûts du véhicule, sans restriction affichée.
    const vehicleB = await dashboard(chefA, { vehicleId: v['vB1'] as string });
    expect(byKey(vehicleB)['costs.operating']).toBeUndefined();
    expect(vehicleB.omitted).toEqual([{ key: 'costs.operating', label: 'Coûts d’exploitation', reason: 'La consultation des coûts requiert la permission costs.read sur la société du véhicule.' }]);
    await expectJustified(chefA, vehicleB);
    const vehicleA = await dashboard(chefA, { vehicleId: v['vA1'] as string });
    expect(byKey(vehicleA)['costs.operating']).toMatchObject({ label: 'Coûts d’exploitation', value: '80.250' });
    expect(byKey(vehicleA)['costs.operating']?.definition).not.toContain('non comprises');
    expect(vehicleA.omitted).toEqual([]);
    await expectJustified(chefA, vehicleA);
  });

  it('retours attendus : retour prévu dans la journée locale ou dépassé, recalculés en direct', async () => {
    expect(await listIds(admin, '/usages', { companyId: f.companies.A, returnDue: 'true' })).toEqual([usages['vA2'], usages['vA3']].sort());
    expect(await listIds(admin, '/usages', { companyId: f.companies.A, late: 'true' })).toEqual([usages['vA3']]);

    // 00:10 à Tunis le 25 : vA8 (retour prévu 00:30) devient attendu, vA2 est en retard.
    t.clock.set('2026-09-24T23:10:00.000Z');
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD); // la session précédente a expiré (inactivité)
    const next = byKey(await dashboard(admin, { companyId: f.companies.A }));
    expect(next['usages.returnDue']?.value).toBe(3);
    expect(next['usages.returnDue.late']?.value).toBe(2);
    expect(await listIds(admin, '/usages', { companyId: f.companies.A, returnDue: 'true' })).toEqual([usages['vA2'], usages['vA3'], usages['vA8']].sort());
    // Un retour enregistré sort de la liste.
    await t.prisma.client.vehicleUsage.update({ where: { id: usages['vA3'] }, data: { status: 'TERMINEE', returnedAt: new Date('2026-09-24T23:05:00Z'), returnWithoutReading: true, returnExceptionReason: 'test' } });
    expect(byKey(await dashboard(admin, { companyId: f.companies.A }))['usages.returnDue']?.value).toBe(2);
  });

  it('alertes prioritaires : compteurs par gravité dans le périmètre, hors reports de l’utilisateur (D-252)', async () => {
    const critical = await t.prisma.client.alert.findFirstOrThrow({ where: { companyId: f.companies.A, severity: 'CRITIQUE', status: 'ACTIVE' } });
    const snooze = await chefA.post(`/alerts/${critical.id}/snooze`, { until: '2026-10-01', reason: 'garage réservé' });
    expect(snooze.status, JSON.stringify(snooze.body)).toBe(200);
    const chef = byKey(await dashboard(chefA));
    expect(['alerts.critical', 'alerts.urgent', 'alerts.attention', 'alerts.info'].map((k) => chef[k]?.label)).toEqual(['Alertes critiques', 'Alertes urgentes', 'Alertes « Attention »', 'Alertes d’information']);
    expect(chef['alerts.critical']?.value).toBe(0);
    expect(chef['alerts.critical']?.justification).toMatchObject({ path: '/alerts', query: { status: 'ACTIVE', severity: 'CRITIQUE', snoozed: 'exclude' } });
    await expectJustified(chefA, await dashboard(chefA));
    // Le report est propre au chef : l'administrateur voit toujours l'alerte.
    expect(byKey(await dashboard(admin, { companyId: f.companies.A }))['alerts.critical']?.value).toBe(1);
    // Chef B : uniquement les alertes de B.
    expect(byKey(await dashboard(chefB))['alerts.critical']?.value).toBe(1);
    expect(byKey(await dashboard(chefB))['alerts.attention']?.value).toBe(0);
  });

  it('relevés anciens : seuil de la société, mêmes règles que la synthèse du véhicule', async () => {
    const stale = await listIds(admin, '/vehicles', { lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' });
    const unknown = await listIds(admin, '/vehicles', { lifecycleStatus: 'ACTIF', freshness: 'INCONNU' });
    const fresh = await listIds(admin, '/vehicles', { lifecycleStatus: 'ACTIF', freshness: 'A_JOUR' });
    expect(stale).toEqual([v['vA1'], v['vB1']].sort());
    expect(unknown).toEqual([v['vA3'], v['vB2']].sort());
    expect(stale.length + unknown.length + fresh.length).toBe(9);
    for (const [ids, status] of [[stale, 'A_ACTUALISER'], [unknown, 'INCONNU'], [fresh, 'A_JOUR']] as const) {
      for (const id of ids) {
        const synthesis = await admin.get(`/vehicles/${id}/synthesis`);
        expect(synthesis.body.freshness, id).toBe(status);
      }
    }

    // Seuil surchargé pour B (30 jours) : vB1 redevient à jour, dans l'indicateur comme dans la liste.
    const override = await admin.put('/settings/odometer.staleAfterDays', { value: 30, companyId: f.companies.B, reason: 'relevés mensuels' });
    expect(override.status, JSON.stringify(override.body)).toBe(200);
    const b = byKey(await dashboard(admin, { companyId: f.companies.B }));
    expect(b['odometer.stale']?.value).toBe(0);
    expect(byKey(await dashboard(admin))['odometer.stale']?.value).toBe(1);
    expect(await listIds(admin, '/vehicles', { lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' })).toEqual([v['vA1']]);
    expect((await admin.get(`/vehicles/${v['vB1']}/synthesis`)).body.freshness).toBe('A_JOUR');

    // Limite : exactement 7 jours reste à jour ; 1 ms de plus → A_ACTUALISER (vA2 observé le 23 à 08:00 UTC).
    t.clock.set('2026-09-30T08:00:00.000Z');
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD); // la session précédente a expiré (inactivité)
    expect(await listIds(admin, '/vehicles', { companyId: f.companies.A, lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' })).toEqual([v['vA1'], v['vA7']].sort());
    expect(byKey(await dashboard(admin, { companyId: f.companies.A }))['odometer.stale']?.value).toBe(2);
    t.clock.set('2026-09-30T08:00:00.001Z');
    expect(await listIds(admin, '/vehicles', { companyId: f.companies.A, lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' })).toEqual([v['vA1'], v['vA2'], v['vA7']].sort());
    expect(byKey(await dashboard(admin, { companyId: f.companies.A }))['odometer.stale']?.value).toBe(3);
  });

  it('11.1 — filtre par véhicule : indicateurs du seul véhicule, listes justificatives et écrans filtrés ; hors périmètre ou autre société → 404', async () => {
    // vA1 : actif et disponible, assurance manquante, relevé ancien, plan À faire, dépenses de septembre, alerte « Attention ».
    const one = await dashboard(admin, { vehicleId: v['vA1'] as string });
    expect(one).toMatchObject({ companyId: null, vehicleId: v['vA1'], period: { from: '2026-09-01', to: '2026-09-30' } });
    expect(values(one)).toEqual({
      'vehicles.active': 1,
      'vehicles.active.nonCompliant': 1,
      'vehicles.available': 1,
      'vehicles.available.nonCompliant': 1,
      'vehicles.inUse': 0,
      'vehicles.inUse.nonCompliant': 0,
      'vehicles.immobilized': 0,
      'vehicles.immobilized.nonCompliant': 0,
      'vehicles.outOfService': 0,
      'maintenance.urgent': 1,
      'maintenance.urgent.due': 1,
      'maintenance.urgent.overdue': 0,
      'documents.expired': 0,
      'documents.missing': 1,
      'odometer.stale': 1,
      'odometer.unknown': 0,
      'usages.returnDue': 0,
      'usages.returnDue.late': 0,
      'interventions.completed': 0,
      'costs.operating': '80.250',
      'alerts.critical': 0,
      'alerts.urgent': 1,
      'alerts.attention': 1,
      'alerts.info': 0,
    });
    // Chaque liste justificative reçoit le même filtre et redonne la valeur ; les écrans de liste reçoivent
    // « vehicule », la liste des véhicules (sans ce filtre à l'écran) passe par la route de l'API.
    await expectJustified(admin, one);
    const ind = byKey(one);
    for (const indicator of one.indicators) expect(indicator.justification.query['vehicleId'], indicator.key).toBe(v['vA1']);
    expect(ind['vehicles.available']?.justification.screen).toBeNull();
    expect(ind['maintenance.urgent']?.justification.screen).toEqual({ path: '/entretiens', query: { urgent: '1', vehicule: v['vA1'] } });
    expect(ind['documents.missing']?.justification.screen).toEqual({ path: '/documents', query: { statut: 'MANQUANT', vehicule: v['vA1'] } });
    expect(ind['interventions.completed']?.justification.screen).toEqual({ path: '/interventions', query: { statut: 'TERMINEE', du: '2026-09-01', au: '2026-09-30', vehicule: v['vA1'] } });
    expect(await listIds(admin, '/vehicles', { vehicleId: v['vA1'] as string, lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' })).toEqual([v['vA1']]);

    // vA3 : immobilisé et en utilisation (compté une fois, immobilisé), assurance expirée, kilométrage inconnu, retour dépassé.
    const three = byKey(await dashboard(chefA, { companyId: f.companies.A, vehicleId: v['vA3'] as string }));
    expect([three['vehicles.active']?.value, three['vehicles.available']?.value, three['vehicles.inUse']?.value, three['vehicles.immobilized']?.value]).toEqual([1, 0, 0, 1]);
    expect([three['documents.expired']?.value, three['odometer.unknown']?.value, three['usages.returnDue']?.value, three['usages.returnDue.late']?.value]).toEqual([1, 1, 1, 1]);
    expect(three['costs.operating']?.value).toBe('0.000');
    await expectJustified(chefA, await dashboard(chefA, { vehicleId: v['vA3'] as string }));
    // Véhicule hors service : exclu du parc actif, compté hors service.
    expect(byKey(await dashboard(admin, { vehicleId: v['vA4'] as string }))['vehicles.outOfService']?.value).toBe(1);
    expect(byKey(await dashboard(admin, { vehicleId: v['vA4'] as string }))['vehicles.active']?.value).toBe(0);

    // Autorisation côté serveur : véhicule d'une autre société que celle demandée, hors périmètre ou inexistant → 404.
    for (const [agent, query] of [
      [admin, { companyId: f.companies.B, vehicleId: v['vA1'] as string }],
      [chefB, { vehicleId: v['vA1'] as string }],
      [chefA, { vehicleId: v['vB1'] as string }],
      [admin, { vehicleId: randomUUID() }],
    ] as const) {
      const res = await agent.get(`/dashboard${qs(query)}`);
      expect(res.status, JSON.stringify(query)).toBe(404);
      expect(res.body.code).toBe('INTROUVABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/indicators|total/);
    }
    const invalid = await admin.get(`/dashboard${qs({ vehicleId: 'pas-un-identifiant' })}`);
    expect(invalid.status).toBe(422);
    expect(invalid.body.fieldErrors?.vehicleId).toEqual(['Identifiant de véhicule invalide.']);
  });
});
