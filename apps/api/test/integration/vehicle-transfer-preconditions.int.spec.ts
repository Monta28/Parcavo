import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * Préconditions du transfert (CDC 2.4 — T26) : une utilisation en cours et une immobilisation active
 * bloquent le transfert (aperçu et opération), qui redevient possible après résolution ; responsables de
 * plan proposés pour la société cible selon la règle unique du contrôle (administrateurs groupe compris).
 */
describe('Transfert : blocage par utilisation en cours et immobilisation active, responsables éligibles (CDC 2.4)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
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
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'TR-01' });
    const segment = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    expect(segment.status, JSON.stringify(segment.body)).toBe(201);
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-TR-01', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
  });

  async function version(): Promise<number> {
    return (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).version;
  }

  async function body(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return { targetCompanyId: f.companies.B, expectedVersion: await version(), reason: 'Réaffectation au dépôt de B', plans: [], siteId: null, departmentId: null, sharedDocumentVersionIds: [], noReadingReason: 'Compteur relevé à la restitution', ...extra };
  }

  async function transfer(extra: Record<string, unknown> = {}) {
    return admin.post(`/vehicles/${vehicleId}/transfer`, await body(extra)).set('Idempotency-Key', randomUUID());
  }

  async function user(email: string, memberships: Array<{ companyId: string | null; role: 'ADMIN' | 'CHEF_PARC' | 'OPERATEUR' | 'LECTEUR' | 'CONDUCTEUR' }>, status: 'ACTIF' | 'DESACTIVE' = 'ACTIF'): Promise<string> {
    const hash = (await t.prisma.client.user.findUniqueOrThrow({ where: { id: f.users.chefA }, select: { passwordHash: true } })).passwordHash;
    const [firstName, lastName] = email.split('@')[0]?.split('.') ?? ['x', 'y'];
    const created = await t.prisma.client.user.create({ data: { organizationId: f.organizationId, email, firstName: firstName ?? 'x', lastName: lastName ?? 'y', status, passwordHash: hash, memberships: { create: memberships } } });
    return created.id;
  }

  it('R-2.4-02 — utilisation EN_COURS : aperçu bloqué et 409 TRANSFERT_BLOQUE ; transfert possible après la restitution, utilisation restée à A', async () => {
    const out = await chefA.post('/usages/checkout', {
      vehicleId,
      driverId: f.drivers.a1,
      checkedOutAt: '2026-09-24T09:00:00Z',
      expectedReturnAt: '2026-09-24T18:00:00Z',
      purpose: 'Livraison client',
      reading: { physicalKm: '10100' },
      location: { placeLabel: 'Dépôt central' },
      fuelGauge: 'TROIS_QUARTS',
      checklist: [{ label: 'Clés', present: true }],
    }).set('Idempotency-Key', randomUUID());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const usageId = out.body.id as string;

    const preview = await admin.get(`/vehicles/${vehicleId}/transfer-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.canTransfer).toBe(false);
    // Libellé daté dans le fuseau du groupe (Africa/Tunis, UTC+1), jamais en UTC brut.
    expect(preview.body.blockers).toEqual([
      { type: 'UTILISATION_EN_COURS', id: usageId, status: 'EN_COURS', label: 'Utilisation en cours depuis le 24/09/2026 à 10:00, retour prévu le 24/09/2026 à 19:00', action: expect.any(String), link: `/utilisations/${usageId}` },
    ]);
    expect(JSON.stringify(preview.body.blockers)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const refused = await transfer();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('TRANSFERT_BLOQUE');
    expect(refused.body.details.blockers.map((b: { type: string; id: string }) => [b.type, b.id])).toEqual([['UTILISATION_EN_COURS', usageId]]);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.A);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId } })).toBe(0);

    // Résolution : restitution enregistrée.
    const back = await chefA.post(`/usages/${usageId}/return`, { returnedAt: '2026-09-24T09:45:00Z', reading: { physicalKm: '10180' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: out.body.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const after = await admin.get(`/vehicles/${vehicleId}/transfer-preview`);
    expect(after.body.blockers).toEqual([]);
    expect(after.body.canTransfer).toBe(true);

    const done = await transfer();
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.vehicle).toMatchObject({ id: vehicleId, companyId: f.companies.B });
    // L'utilisation reste un événement historique de la société A.
    expect((await t.prisma.client.vehicleUsage.findUniqueOrThrow({ where: { id: usageId } })).companyId).toBe(f.companies.A);
  });

  it('R-2.4-02 — immobilisation ACTIVE : aperçu bloqué et 409 TRANSFERT_BLOQUE ; transfert possible après la fin de l’immobilisation', async () => {
    const immo = await chefA.post('/immobilizations', { vehicleId, reason: 'Boîte de vitesses', startedAt: '2026-09-24T08:00:00Z' });
    expect(immo.status, JSON.stringify(immo.body)).toBe(201);
    const immoId = immo.body.id as string;

    const preview = (await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body;
    expect(preview.canTransfer).toBe(false);
    expect(preview.blockers).toEqual([{ type: 'IMMOBILISATION_ACTIVE', id: immoId, status: 'ACTIVE', label: 'Immobilisation depuis le 24/09/2026 à 09:00', action: expect.any(String), link: `/immobilisations/${immoId}` }]);

    const refused = await transfer();
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TRANSFERT_BLOQUE');
    expect(refused.body.details.blockers).toEqual([expect.objectContaining({ type: 'IMMOBILISATION_ACTIVE', id: immoId })]);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.A);

    // Résolution : fin de l'immobilisation.
    const current = (await chefA.get(`/immobilizations/${immoId}`)).body as { version: number };
    const ended = await chefA.post(`/immobilizations/${immoId}/end`, { reason: 'Boîte remplacée', expectedVersion: current.version });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect((await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body.canTransfer).toBe(true);

    const done = await transfer();
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.vehicle.companyId).toBe(f.companies.B);
    expect((await t.prisma.client.immobilization.findUniqueOrThrow({ where: { id: immoId } })).companyId).toBe(f.companies.A);
  });

  it('les quatre causes réunies sont toutes listées ; chacune doit être traitée avant le transfert', async () => {
    const out = await chefA.post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T09:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'PLEIN', checklist: [] }).set('Idempotency-Key', randomUUID());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const immo = await chefA.post('/immobilizations', { vehicleId, reason: 'Pneu crevé', startedAt: '2026-09-24T09:30:00Z' });
    expect(immo.status, JSON.stringify(immo.body)).toBe(201);
    const intervention = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Réparation pneu' }] });
    expect(intervention.status, JSON.stringify(intervention.body)).toBe(201);
    const reservation = await t.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a2, startAt: new Date('2026-10-02T08:00:00Z'), endAt: new Date('2026-10-02T17:00:00Z'), purpose: 'Salon' } });

    const preview = (await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body;
    expect(preview.blockers.map((b: { type: string; id: string }) => [b.type, b.id])).toEqual([
      ['UTILISATION_EN_COURS', out.body.id],
      ['IMMOBILISATION_ACTIVE', immo.body.id],
      ['INTERVENTION_OUVERTE', intervention.body.id],
      ['RESERVATION_A_TRAITER', reservation.id],
    ]);
    const refused = await transfer({ acknowledgeWarnings: true });
    expect(refused.status).toBe(409);
    expect(refused.body.details.blockers).toHaveLength(4);
  });

  it('responsables de plan éligibles dans la société cible : administrateurs groupe compris, même règle que le contrôle du transfert', async () => {
    const typeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalMonths: 6, responsibleUserId: f.users.chefA, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-06-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const admin2 = await user('samia.admin2@test.local', [{ companyId: null, role: 'ADMIN' }]);
    const adminOff = await user('ancien.admin@test.local', [{ companyId: null, role: 'ADMIN' }], 'DESACTIVE');
    const operateurB = await user('olfa.operateurb@test.local', [{ companyId: f.companies.B, role: 'OPERATEUR' }]);
    const lecteurB = await user('lotfi.lecteurb@test.local', [{ companyId: f.companies.B, role: 'LECTEUR' }]);
    const conducteurB = await user('walid.conducteurb@test.local', [{ companyId: f.companies.B, role: 'CONDUCTEUR' }]);

    const res = await admin.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${f.companies.B}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.companyId).toBe(f.companies.B);
    const ids = res.body.items.map((u: { id: string }) => u.id);
    expect(ids.sort()).toEqual([f.users.admin, admin2, f.users.chefB, operateurB].sort());
    for (const excluded of [adminOff, lecteurB, conducteurB, f.users.chefA, f.users.operateurA]) expect(ids).not.toContain(excluded);
    expect(res.body.items.find((u: { id: string }) => u.id === admin2)).toEqual({ id: admin2, firstName: 'samia', lastName: 'admin2', email: 'samia.admin2@test.local', roles: ['ADMIN'] });
    expect(res.body.items.find((u: { id: string }) => u.id === f.users.chefB).roles).toEqual(['CHEF_PARC']);
    // Aucune donnée d'authentification exposée.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon/);

    // Un compte hors liste est refusé par le transfert ; un compte de la liste (administrateur groupe) est accepté.
    const refused = await transfer({ plans: [{ planId: plan.body.id, decision: 'KEEP', responsibleUserId: lecteurB }] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.fieldErrors['plans.0.responsibleUserId']).toBeDefined();
    const done = await transfer({ plans: [{ planId: plan.body.id, decision: 'KEEP', responsibleUserId: admin2 }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: plan.body.id } })).responsibleUserId).toBe(admin2);
  });

  it('transfer-responsibles : réservé à l’administrateur, véhicule hors périmètre → 404, société cible identique, inconnue ou archivée → 422', async () => {
    expect((await chefA.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${f.companies.B}`)).status).toBe(403);
    expect((await chefB.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${f.companies.B}`)).status).toBe(404);
    const same = await admin.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${f.companies.A}`);
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('SOCIETE_IDENTIQUE');
    const unknown = await admin.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${randomUUID()}`);
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('REFERENCE_INVALIDE');
    await t.prisma.client.company.update({ where: { id: f.companies.C }, data: { status: 'ARCHIVE' } });
    const archived = await admin.get(`/vehicles/${vehicleId}/transfer-responsibles?companyId=${f.companies.C}`);
    expect(archived.status).toBe(422);
    expect(archived.body.code).toBe('SOCIETE_ARCHIVEE');
    expect((await admin.get(`/vehicles/${vehicleId}/transfer-responsibles`)).status).toBe(422);
  });
});
