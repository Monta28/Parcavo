import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UsagesService } from '../../src/modules/usages/usages.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * Règles des utilisations (CDC 4.3 à 4.5 ; D-134, D-135, D-138, D-140) : lieu obligatoire et contrôlé,
 * incident de dommage au retour, règle unique de retard, prolongation et retour sous verrous, conversion
 * de réservation et conflit avec la réservation d'autrui. Requêtes HTTP réelles sur une vraie base.
 */
describe('Utilisations — lieu, dommage, retard, prolongation, conversion (CDC 4.3 à 4.5)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let conducteurA: Agent;
  let vehicleId: string;
  let vehicle2: string;
  let siteA: string;
  let siteArchivedA: string;
  let siteB: string;
  let keySeq = 0;
  const key = () => `cle-regles-${Date.now()}-${keySeq++}`;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    vehicle2 = await createVehicle(t.prisma, f, 'A', { code: 'VA-2' });
    for (const v of [vehicleId, vehicle2]) {
      await chefA.post(`/vehicles/${v}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    }
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2, f.drivers.b1].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
    siteA = (await t.prisma.client.site.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, name: 'Site Nord A' } })).id;
    siteArchivedA = (await t.prisma.client.site.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, name: 'Ancien dépôt A', status: 'ARCHIVE' } })).id;
    siteB = (await t.prisma.client.site.create({ data: { organizationId: f.organizationId, companyId: f.companies.B, name: 'Site Sud B' } })).id;
  });

  const checkoutBody = (vId: string, driverId: string, extra: Record<string, unknown> = {}) => ({
    vehicleId: vId,
    driverId,
    checkedOutAt: '2026-09-24T09:00:00Z',
    expectedReturnAt: '2026-09-24T18:00:00Z',
    purpose: 'Mission client',
    reading: { physicalKm: '10100' },
    location: { placeLabel: 'Dépôt central' },
    ...extra,
  });
  const checkout = (agent: Agent, body: Record<string, unknown>) => agent.post('/usages/checkout', body).set('Idempotency-Key', key());
  const giveBack = (agent: Agent, usageId: string, body: Record<string, unknown>) => agent.post(`/usages/${usageId}/return`, body).set('Idempotency-Key', key());
  const reserve = async (vId: string, driverId: string, startAt: string, endAt: string) => {
    const r = await chefA.post('/reservations', { vehicleId: vId, driverId, startAt, endAt, purpose: 'Réservation test' });
    expect(r.status).toBe(201);
    return r.body as { id: string; version: number };
  };

  // ---------------------------------------------------------------------------
  // 1. Lieu obligatoire (D-134)
  // ---------------------------------------------------------------------------

  it('D-134 — remise : lieu absent, double, vide, trop long ou site invalide refusé (422) sans rien créer ; site actif accepté', async () => {
    const { location: _omitted, ...withoutLocation } = checkoutBody(vehicleId, f.drivers.a1);
    void _omitted;
    const missing = await checkout(chefA, withoutLocation);
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('VALIDATION');
    expect(missing.body.fieldErrors.location).toContain('Le lieu de remise est obligatoire.');

    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'location.siteId'],
      [{ siteId: siteA, placeLabel: 'Dépôt' }, 'location.siteId'],
      [{ placeLabel: '   ' }, 'location.placeLabel'],
      [{ placeLabel: 'x'.repeat(201) }, 'location.placeLabel'],
      [{ siteId: 'pas-un-uuid' }, 'location.siteId'],
    ];
    for (const [location, field] of cases) {
      const res = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { location }));
      expect(res.status, JSON.stringify(location)).toBe(422);
      expect(res.body.fieldErrors[field], JSON.stringify(res.body)).toBeDefined();
    }
    for (const siteId of [siteB, siteArchivedA, randomUUID()]) {
      const res = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { location: { siteId } }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SITE_INVALIDE');
      expect(res.body.fieldErrors['location.siteId']).toBeDefined();
    }
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    expect(await t.prisma.client.vehicleLocationReport.count()).toBe(0);

    const longest = await checkout(chefA, checkoutBody(vehicle2, f.drivers.a2, { location: { placeLabel: `  ${'y'.repeat(200)}  ` } }));
    expect(longest.status).toBe(201);
    expect(longest.body.checkoutLocation).toBe('y'.repeat(200));

    const ok = await checkout(operateurA, checkoutBody(vehicleId, f.drivers.a1, { location: { siteId: siteA } }));
    expect(ok.status).toBe(201);
    expect(ok.body.checkoutLocation).toBe('Site Nord A');
    const report = await t.prisma.client.vehicleLocationReport.findFirstOrThrow({ where: { usageId: ok.body.id } });
    expect(report).toMatchObject({ context: 'REMISE', siteId: siteA, placeLabel: null, vehicleId });
    expect(report.observedAt.toISOString()).toBe('2026-09-24T09:00:00.000Z');
  });

  it('D-134 — restitution : lieu obligatoire, site d’une autre société refusé sans clore l’utilisation', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1));
    expect(out.status).toBe(201);
    const back = { returnedAt: '2026-09-24T09:40:00Z', reading: { physicalKm: '10150' }, expectedVersion: out.body.version };
    const missing = await giveBack(chefA, out.body.id, back);
    expect(missing.status).toBe(422);
    expect(missing.body.fieldErrors.location).toContain('Le lieu de restitution est obligatoire.');
    const foreign = await giveBack(chefA, out.body.id, { ...back, location: { siteId: siteB } });
    expect(foreign.status).toBe(422);
    expect(foreign.body.code).toBe('SITE_INVALIDE');
    const still = await chefA.get(`/usages/${out.body.id}`);
    expect(still.body).toMatchObject({ status: 'EN_COURS', version: out.body.version, returnLocation: null });
    expect(await t.prisma.client.vehicleLocationReport.count({ where: { context: 'RESTITUTION' } })).toBe(0);
    expect(await t.prisma.client.odometerReading.count({ where: { context: 'RESTITUTION' } })).toBe(0);
    const ok = await giveBack(chefA, out.body.id, { ...back, location: { siteId: siteA } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'TERMINEE', returnLocation: 'Site Nord A', damageIncident: null });
    expect(await t.prisma.client.vehicleLocationReport.count({ where: { context: 'RESTITUTION', usageId: out.body.id, siteId: siteA } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. Dommage constaté au retour (4.4)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 3. Retard : règle unique (tolérance)
  // ---------------------------------------------------------------------------

  it('retard : isLate, filtre late=true et alerte RETOUR_DEPASSE appliquent la même tolérance, par société', async () => {
    const tolerance = await admin.put('/settings/usage.lateReturnToleranceMinutes', { value: 30, companyId: f.companies.A, reason: 'tolérance du parc A' });
    expect(tolerance.status).toBe(200);
    const vehicleB = await createVehicle(t.prisma, f, 'B', { code: 'VB-1' });
    await chefB.post(`/vehicles/${vehicleB}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '500' });
    const usageA = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    const usageB = await checkout(chefB, checkoutBody(vehicleB, f.drivers.b1, { reading: { physicalKm: '600' }, expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect([usageA.status, usageB.status]).toEqual([201, 201]);
    const lateIds = async () => ((await admin.get('/usages?late=true')).body.items as Array<{ id: string }>).map((u) => u.id).sort();
    const usages = t.app.get(UsagesService);

    // 12 h 20 : B (tolérance 0) est en retard ; A (tolérance 30 min) ne l'est pas encore.
    t.clock.set('2026-09-24T12:20:00Z');
    expect((await chefA.get(`/usages/${usageA.body.id}`)).body.isLate).toBe(false);
    expect((await chefB.get(`/usages/${usageB.body.id}`)).body.isLate).toBe(true);
    expect(await lateIds()).toEqual([usageB.body.id]);
    expect((await usages.evaluateLateReturns(f.organizationId)).late).toBe(1);
    expect(await t.prisma.client.alert.count({ where: { type: 'RETOUR_DEPASSE', status: 'ACTIVE', objectId: usageA.body.id } })).toBe(0);

    // 12 h 30 : borne exacte, toujours dans la tolérance.
    t.clock.set('2026-09-24T12:30:00Z');
    expect((await chefA.get(`/usages/${usageA.body.id}`)).body.isLate).toBe(false);
    expect(await lateIds()).toEqual([usageB.body.id]);

    // 12 h 30 min 01 s : la tolérance est dépassée partout à la fois.
    t.clock.set('2026-09-24T12:30:01Z');
    expect((await chefA.get(`/usages/${usageA.body.id}`)).body.isLate).toBe(true);
    expect((await chefA.get(`/usages?late=true`)).body.items.map((u: { id: string }) => u.id)).toEqual([usageA.body.id]);
    expect(await lateIds()).toEqual([usageA.body.id, usageB.body.id].sort());
    expect((await usages.evaluateLateReturns(f.organizationId)).late).toBe(2);
    expect(await t.prisma.client.alert.count({ where: { type: 'RETOUR_DEPASSE', status: 'ACTIVE', objectId: usageA.body.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Prolongation et retour sous verrous
  // ---------------------------------------------------------------------------

  it('D-135 / D-140 — prolongation chevauchant la réservation confirmée d’autrui : 409 RESERVATION_CONFLIT ; échéance consécutive acceptée', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(out.status).toBe(201);
    const next = await reserve(vehicleId, f.drivers.a2, '2026-09-24T16:00:00Z', '2026-09-24T18:00:00Z');
    const conflict = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T17:00:00Z', reason: 'Client en retard', expectedVersion: out.body.version });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('RESERVATION_CONFLIT');
    expect(conflict.body.details.reservations.map((r: { id: string }) => r.id)).toEqual([next.id]);
    expect((await chefA.get(`/usages/${out.body.id}`)).body).toMatchObject({ expectedReturnAt: '2026-09-24T12:00:00.000Z', version: out.body.version });
    const consecutive = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T16:00:00Z', reason: 'Jusqu’à la réservation suivante', expectedVersion: out.body.version });
    expect(consecutive.status).toBe(200);
    expect(consecutive.body.expectedReturnAt).toBe('2026-09-24T16:00:00.000Z');
  });

  it('D-135 — prolongation vers une échéance future : alerte de retard résolue immédiatement, version et état contrôlés sous verrou', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(out.status).toBe(201);
    t.clock.set('2026-09-24T13:00:00Z');
    await t.app.get(UsagesService).evaluateLateReturns(f.organizationId);
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'RETOUR_DEPASSE', objectId: out.body.id } })).status).toBe('ACTIVE');

    expect((await conducteurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T15:00:00Z', reason: 'Je prolonge', expectedVersion: out.body.version })).status).toBe(403);
    expect((await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T08:00:00Z', reason: 'Avant la remise', expectedVersion: out.body.version })).status).toBe(422);

    const ok = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T16:00:00Z', reason: 'Mission prolongée', expectedVersion: out.body.version });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ expectedReturnAt: '2026-09-24T16:00:00.000Z', isLate: false, version: out.body.version + 1 });
    // D-135 : l'alerte de retard est résolue dans la transaction de prolongation, sans attendre le rattrapage.
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'RETOUR_DEPASSE', objectId: out.body.id } });
    expect(alert.status).toBe('RESOLUE');
    expect(alert.resolutionReason).toBe('retour prévu prolongé');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'utilisation.prolongation', objectId: out.body.id } });
    expect(audit.reason).toBe('Mission prolongée');

    const stale = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T15:30:00Z', reason: 'Version périmée', expectedVersion: out.body.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');

    const back = await giveBack(chefA, out.body.id, { returnedAt: '2026-09-24T13:00:00Z', reading: { physicalKm: '10200' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: ok.body.version });
    expect(back.status).toBe(200);
    const finished = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T15:00:00Z', reason: 'Trop tard', expectedVersion: back.body.version });
    expect(finished.status).toBe(409);
    expect(finished.body.code).toBe('ETAT_INVALIDE');
  });

  it('D-135 / 4.5 — prolongation qui efface le retard : les alertes « réservation compromise » dues à ce retard sont résolues avec lui', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(out.status).toBe(201);
    const following = await reserve(vehicleId, f.drivers.a2, '2026-09-24T16:00:00Z', '2026-09-24T18:00:00Z');
    t.clock.set('2026-09-24T13:00:00Z');
    expect(await t.app.get(UsagesService).evaluateLateReturns(f.organizationId)).toEqual({ late: 1, compromised: 1 });
    const compromised = () => t.prisma.client.alert.findFirstOrThrow({ where: { type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: following.id } });
    expect((await compromised()).status).toBe('ACTIVE');

    // Échéance encore dépassée : le retard et ses conséquences restent signalés.
    const stillLate = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T12:30:00Z', reason: 'Correction de l’échéance', expectedVersion: out.body.version });
    expect(stillLate.status).toBe(200);
    expect(stillLate.body.isLate).toBe(true);
    expect((await compromised()).status).toBe('ACTIVE');
    expect(await t.prisma.client.alert.count({ where: { type: 'RETOUR_DEPASSE', objectId: out.body.id, status: 'ACTIVE' } })).toBe(1);

    // Échéance future, avant la réservation suivante : plus de retard, la réservation n'est plus compromise.
    const ok = await operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T15:00:00Z', reason: 'Retour décalé', expectedVersion: stillLate.body.version });
    expect(ok.status).toBe(200);
    const resolved = await compromised();
    expect(resolved.status).toBe('RESOLUE');
    expect(resolved.resolutionReason).toBe('retour prévu prolongé avant la réservation');
    expect(await t.prisma.client.alert.count({ where: { type: { in: ['RETOUR_DEPASSE', 'RESERVATION_COMPROMISE'] }, status: 'ACTIVE' } })).toBe(0);
  });

  it('13.3 — prolongations concurrentes avec la même version : une seule réussit, les autres 409 VERSION_OBSOLETE (jamais 500)', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(out.status).toBe(201);
    const targets = ['2026-09-24T13:00:00Z', '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z', '2026-09-24T16:00:00Z', '2026-09-24T17:00:00Z'];
    const results = await Promise.all(targets.map((expectedReturnAt, i) => (i % 2 ? chefA : operateurA).post(`/usages/${out.body.id}/extend`, { expectedReturnAt, reason: `Prolongation ${i}`, expectedVersion: out.body.version })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('VERSION_OBSOLETE');
    const winner = results.find((r) => r.status === 200);
    const final = await chefA.get(`/usages/${out.body.id}`);
    expect(final.body.version).toBe(out.body.version + 1);
    expect(final.body.expectedReturnAt).toBe(winner?.body.expectedReturnAt);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'utilisation.prolongation', objectId: out.body.id } })).toBe(1);
  });

  it('13.3 — retours concurrents de la même utilisation : une seule restitution, un seul relevé et un seul lieu', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1));
    expect(out.status).toBe(201);
    const results = await Promise.all(
      ['10150', '10160', '10170', '10180'].map((km, i) =>
        giveBack(i % 2 ? chefA : operateurA, out.body.id, { returnedAt: '2026-09-24T09:45:00Z', reading: { physicalKm: km }, location: { placeLabel: `Quai ${i}` }, expectedVersion: out.body.version }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(['ETAT_INVALIDE', 'VERSION_OBSOLETE']).toContain(r.body.code);
    const final = await chefA.get(`/usages/${out.body.id}`);
    expect(final.body).toMatchObject({ status: 'TERMINEE', version: out.body.version + 1 });
    expect(await t.prisma.client.vehicleLocationReport.count({ where: { usageId: out.body.id, context: 'RESTITUTION' } })).toBe(1);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, context: 'RESTITUTION' } })).toBe(1);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'utilisation.restitution', objectId: out.body.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. Conversion de réservation et conflit (D-140)
  // ---------------------------------------------------------------------------

  it('D-140 — réservation explicite : hors fenêtre [début − avance, fin[ ou autre couple → 422 ; avance paramétrée par société', async () => {
    const r = await reserve(vehicleId, f.drivers.a1, '2026-09-24T11:30:00Z', '2026-09-24T13:00:00Z');
    const early = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { reservationId: r.id, expectedReturnAt: '2026-09-24T13:00:00Z' }));
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('RESERVATION_HORS_FENETRE');
    expect(early.body.fieldErrors.reservationId).toBeDefined();
    expect(early.body.details).toMatchObject({ reservationId: r.id, windowStart: '2026-09-24T09:30:00.000Z', windowEnd: '2026-09-24T13:00:00.000Z', conversionEarlyMinutes: 120 });
    expect(early.body.message).toContain('120 min avant le début prévu');
    const otherCouple = await checkout(chefA, checkoutBody(vehicle2, f.drivers.a1, { reservationId: r.id, checkedOutAt: '2026-09-24T09:45:00Z', expectedReturnAt: '2026-09-24T11:30:00Z' }));
    expect(otherCouple.status).toBe(422);
    expect(otherCouple.body.code).toBe('RESERVATION_DIFFERENTE');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    expect((await chefA.get(`/reservations/${r.id}`)).body.status).toBe('CONFIRMEE');

    // Avance portée à 150 min pour la société A : le départ de 9 h entre dans la fenêtre.
    expect((await admin.put('/settings/reservations.conversionEarlyMinutes', { value: 150, companyId: f.companies.A, reason: 'départs matinaux' })).status).toBe(200);
    const converted = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { reservationId: r.id, expectedReturnAt: '2026-09-24T13:00:00Z' }));
    expect(converted.status).toBe(201);
    expect(converted.body.reservationId).toBe(r.id);
    const reservation = await chefA.get(`/reservations/${r.id}`);
    expect(reservation.body).toMatchObject({ status: 'CONVERTIE', convertedUsageId: converted.body.id, version: r.version + 1 });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'reservation.conversion', objectId: r.id } })).toBe(1);
  });

  it('D-140 — sans identifiant : la réservation du même couple est convertie si le départ est dans sa fenêtre, sinon elle reste confirmée', async () => {
    const r1 = await reserve(vehicleId, f.drivers.a1, '2026-09-24T11:30:00Z', '2026-09-24T13:00:00Z');
    const r2 = await reserve(vehicle2, f.drivers.a2, '2026-09-24T12:30:00Z', '2026-09-24T14:00:00Z');
    const inWindow = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { checkedOutAt: '2026-09-24T09:45:00Z', expectedReturnAt: '2026-09-24T13:00:00Z' }));
    expect(inWindow.status).toBe(201);
    expect(inWindow.body.reservationId).toBe(r1.id);
    expect((await chefA.get(`/reservations/${r1.id}`)).body).toMatchObject({ status: 'CONVERTIE', convertedUsageId: inWindow.body.id });
    // 9 h 50 est avant l'ouverture de la fenêtre de r2 (10 h 30) : pas de conversion, et pas de conflit (même couple).
    const outOfWindow = await checkout(chefA, checkoutBody(vehicle2, f.drivers.a2, { checkedOutAt: '2026-09-24T09:50:00Z', expectedReturnAt: '2026-09-24T12:30:00Z' }));
    expect(outOfWindow.status).toBe(201);
    expect(outOfWindow.body.reservationId).toBeNull();
    expect((await chefA.get(`/reservations/${r2.id}`)).body.status).toBe('CONFIRMEE');
  });

  it('D-140 — départ chevauchant la réservation confirmée d’un autre conducteur ou véhicule : 409 RESERVATION_CONFLIT ; créneau consécutif accepté', async () => {
    const r = await reserve(vehicleId, f.drivers.a2, '2026-09-24T11:30:00Z', '2026-09-24T13:00:00Z');
    const otherDriver = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(otherDriver.status).toBe(409);
    expect(otherDriver.body.code).toBe('RESERVATION_CONFLIT');
    expect(otherDriver.body.details.reservations).toEqual([{ id: r.id, startAt: '2026-09-24T11:30:00.000Z', endAt: '2026-09-24T13:00:00.000Z', driverName: 'Sami Deux' }]);
    const otherVehicle = await checkout(chefA, checkoutBody(vehicle2, f.drivers.a2, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(otherVehicle.status).toBe(409);
    expect(otherVehicle.body.code).toBe('RESERVATION_CONFLIT');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    // [09:00, 11:30[ puis [11:30, 13:00[ : créneaux consécutifs autorisés (4.5).
    const consecutive = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T11:30:00Z' }));
    expect(consecutive.status).toBe(201);
    expect((await chefA.get(`/reservations/${r.id}`)).body.status).toBe('CONFIRMEE');
  });

  it('D-140 — remise saisie après coup avec un retour prévu déjà passé : l’occupation réelle [départ, max(retour prévu, maintenant)[ est contrôlée', async () => {
    const r = await reserve(vehicleId, f.drivers.a2, '2026-09-24T10:30:00Z', '2026-09-24T12:00:00Z');
    // Départ à 9 h, retour prévu à 9 h 30, saisi à 10 h 40 : le véhicule est toujours dehors pendant la réservation d'autrui.
    t.clock.set('2026-09-24T10:40:00Z');
    const late = { checkedOutAt: '2026-09-24T09:00:00Z', expectedReturnAt: '2026-09-24T09:30:00Z' };
    const preview = await chefA.get(`/usages/checkout-preview?vehicleId=${vehicleId}&driverId=${f.drivers.a1}&at=${late.checkedOutAt}&expectedReturnAt=${late.expectedReturnAt}`);
    expect(preview.status).toBe(200);
    expect(preview.body.conflictingReservations.map((c: { id: string }) => c.id)).toEqual([r.id]);
    const refused = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, late));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RESERVATION_CONFLIT');
    expect(refused.body.details.reservations.map((c: { id: string }) => c.id)).toEqual([r.id]);
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    // Saisie à 10 h 20 : l'occupation réelle [9 h, 10 h 20[ précède la réservation, la remise est acceptée.
    t.clock.set('2026-09-24T10:20:00Z');
    const accepted = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, late));
    expect(accepted.status).toBe(201);
    expect(accepted.body.isLate).toBe(true);
  });

  it('13.3 — prolongation et retour concurrents avec la même version : une seule opération aboutit, l’autre reçoit 409 (jamais 500)', async () => {
    const out = await checkout(chefA, checkoutBody(vehicleId, f.drivers.a1, { expectedReturnAt: '2026-09-24T12:00:00Z' }));
    expect(out.status).toBe(201);
    const [extended, returned] = await Promise.all([
      operateurA.post(`/usages/${out.body.id}/extend`, { expectedReturnAt: '2026-09-24T15:00:00Z', reason: 'Mission prolongée', expectedVersion: out.body.version }),
      giveBack(chefA, out.body.id, { returnedAt: '2026-09-24T09:50:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: out.body.version }),
    ]);
    expect([extended.status, returned.status].sort()).toEqual([200, 409]);
    const loser = extended.status === 409 ? extended : returned;
    expect(['ETAT_INVALIDE', 'VERSION_OBSOLETE']).toContain(loser.body.code);
    const final = await chefA.get(`/usages/${out.body.id}`);
    expect(final.body.version).toBe(out.body.version + 1);
    if (returned.status === 200) {
      expect(final.body).toMatchObject({ status: 'TERMINEE', expectedReturnAt: '2026-09-24T12:00:00.000Z' });
      expect(await t.prisma.client.auditEvent.count({ where: { action: 'utilisation.prolongation', objectId: out.body.id } })).toBe(0);
    } else {
      expect(final.body).toMatchObject({ status: 'EN_COURS', expectedReturnAt: '2026-09-24T15:00:00.000Z', returnLocation: null });
      expect(await t.prisma.client.vehicleLocationReport.count({ where: { usageId: out.body.id, context: 'RESTITUTION' } })).toBe(0);
    }
  });
});
