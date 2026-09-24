import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

describe('Remises, restitutions et réservations (CDC 4 — T04 à T08, T22, T23, T33)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let vehicle2: string;
  let keySeq = 0;
  const key = () => `cle-test-${Date.now()}-${keySeq++}`;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    vehicle2 = await createVehicle(t.prisma, f, 'A', { code: 'VA-2' });
    for (const v of [vehicleId, vehicle2]) {
      await chefA.post(`/vehicles/${v}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    }
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
  });

  const checkoutBody = (vId: string, driverId: string, km = '10100', extra: Record<string, unknown> = {}) => ({
    vehicleId: vId,
    driverId,
    checkedOutAt: '2026-09-24T09:00:00Z',
    expectedReturnAt: '2026-09-24T18:00:00Z',
    purpose: 'Mission client',
    reading: { physicalKm: km },
    location: { placeLabel: 'Dépôt central' },
    fuelGauge: 'TROIS_QUARTS',
    checklist: [{ label: 'Clés', present: true }],
    ...extra,
  });

  it('remise puis restitution : utilisation EN_COURS, distance validée, localisations déclarées', async () => {
    const out = await operateurA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    expect(out.body.status).toBe('EN_COURS');
    expect(out.body.checkoutReading.physicalKm).toBe('10100.000');
    expect(out.body.checkoutLocation).toBe('Dépôt central');
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('EN_UTILISATION');
    t.clock.set('2026-09-24T17:00:00Z');
    const back = await operateurA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T16:30:00Z', reading: { physicalKm: '10350' }, location: { placeLabel: 'Parking siège' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('TERMINEE');
    expect(back.body.distanceStatus).toBe('VALIDEE');
    expect(back.body.distanceKm).toBe('250.000');
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('DISPONIBLE');
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.body.lastLocation.placeLabel).toBe('Parking siège');
    expect(synthesis.body.odometer.physicalKm).toBe('10350.000');
  });

  it('T04 — deux remises simultanées du même véhicule à deux conducteurs : une seule réussite', async () => {
    const [a, b] = await Promise.all([
      operateurA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key()),
      chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a2)).set('Idempotency-Key', key()),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = a.status === 409 ? a : b;
    expect(['VEHICULE_DEJA_EN_UTILISATION', 'CONCURRENCE']).toContain(failed.body.code);
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId, status: 'EN_COURS' } })).toBe(1);
  });

  it('T04 — dix remises concurrentes du même véhicule ne créent qu’une utilisation ouverte', async () => {
    const drivers = [f.drivers.a1, f.drivers.a2];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => chefA.post('/usages/checkout', checkoutBody(vehicleId, drivers[i % 2] as string)).set('Idempotency-Key', key())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).length).toBe(9);
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId } })).toBe(1);
  });

  it('T05 — même conducteur, deux véhicules au même instant : une seule utilisation en cours', async () => {
    const [a, b] = await Promise.all([
      chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key()),
      chefA.post('/usages/checkout', checkoutBody(vehicle2, f.drivers.a1)).set('Idempotency-Key', key()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const failed = a.status === 409 ? a : b;
    expect(['CONDUCTEUR_DEJA_EN_UTILISATION', 'CONCURRENCE']).toContain(failed.body.code);
    expect(await t.prisma.client.vehicleUsage.count({ where: { driverId: f.drivers.a1, status: 'EN_COURS' } })).toBe(1);
  });

  it('T33 — même clé et même corps : réponse initiale rejouée ; même clé et corps différent : 409', async () => {
    const k = key();
    const first = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', k);
    expect(first.status).toBe(201);
    const replay = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', k);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const different = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, '10200')).set('Idempotency-Key', k);
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(1);
    // la clé est liée à l'utilisateur : un autre utilisateur avec la même clé est une autre opération
    const other = await operateurA.post('/usages/checkout', checkoutBody(vehicle2, f.drivers.a2)).set('Idempotency-Key', k);
    expect(other.status).toBe(201);
    // requêtes parallèles avec la même clé : un seul résultat
    const k2 = key();
    const t2 = await createVehicle(t.prisma, f, 'A', { code: 'VA-3' });
    await chefA.post(`/vehicles/${t2}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '500' });
    const d3 = await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, code: 'D-A3', firstName: 'Trois', lastName: 'Troisième' } });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: d3.id, number: 'P-3', categories: ['B'] } });
    const parallel = await Promise.all(Array.from({ length: 5 }, () => chefA.post('/usages/checkout', checkoutBody(t2, d3.id, '600')).set('Idempotency-Key', k2)));
    const created = parallel.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    parallel.filter((r) => r.status !== 201).forEach((r) => expect(r.status).toBe(409));
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId: t2 } })).toBe(1);
  });

  it('refuse un départ sans relevé pour l’opérateur ; exception motivée du chef avec alerte persistante et distance indéterminée', async () => {
    const body = { ...checkoutBody(vehicleId, f.drivers.a1), reading: undefined };
    const missing = await operateurA.post('/usages/checkout', body).set('Idempotency-Key', key());
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('RELEVE_REQUIS');
    const opException = await operateurA.post('/usages/checkout', { ...body, readingException: { reason: 'compteur illisible' } }).set('Idempotency-Key', key());
    expect(opException.status).toBe(403);
    const chefException = await chefA.post('/usages/checkout', { ...body, readingException: { reason: 'compteur illisible, écran HS' } }).set('Idempotency-Key', key());
    expect(chefException.status).toBe(201);
    expect(chefException.body.checkoutWithoutReading).toBe(true);
    expect(chefException.body.distanceStatus).toBe('INDETERMINEE');
    const alert = await t.prisma.client.alert.findFirst({ where: { type: 'DEPART_SANS_RELEVE', objectId: chefException.body.id } });
    expect(alert?.status).toBe('ACTIVE');
  });

  it('refuse un relevé de remise incohérent sans inventer de compteur', async () => {
    const res = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, '9000')).set('Idempotency-Key', key());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DIMINUTION');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
  });

  it('T06 — réservations : chevauchement refusé, succession [début, fin[ acceptée', async () => {
    const r1 = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Réunion' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('CONFIRMEE');
    const overlapVehicle = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T11:00:00Z', endAt: '2026-10-01T14:00:00Z', purpose: 'Livraison' });
    expect(overlapVehicle.status).toBe(409);
    expect(overlapVehicle.body.code).toBe('RESERVATION_CHEVAUCHEMENT');
    const overlapDriver = await chefA.post('/reservations', { vehicleId: vehicle2, driverId: f.drivers.a1, startAt: '2026-10-01T10:00:00Z', endAt: '2026-10-01T11:00:00Z', purpose: 'Autre' });
    expect(overlapDriver.status).toBe(409);
    const consecutive = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T12:00:00Z', endAt: '2026-10-01T14:00:00Z', purpose: 'Livraison' });
    expect(consecutive.status).toBe(201);
    // annulation motivée puis créneau libéré
    const cancel = await chefA.post(`/reservations/${r1.body.id}/cancel`, { reason: 'réunion reportée', expectedVersion: r1.body.version });
    expect(cancel.body.status).toBe('ANNULEE');
    expect((await chefA.post('/reservations', { vehicleId: vehicle2, driverId: f.drivers.a1, startAt: '2026-10-01T10:00:00Z', endAt: '2026-10-01T11:00:00Z', purpose: 'Autre' })).status).toBe(201);
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'reservation.annulation' } });
    expect(audit?.reason).toBe('réunion reportée');
    // concurrence : deux réservations chevauchantes envoyées en parallèle
    const [p1, p2] = await Promise.all([
      chefA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T12:00:00Z', purpose: 'Mission A' }),
      operateurA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-02T09:00:00Z', endAt: '2026-10-02T13:00:00Z', purpose: 'Mission B' }),
    ]);
    expect([p1.status, p2.status].sort()).toEqual([201, 409]);
  });

  it('convertit une réservation lors de la remise', async () => {
    // Réservation confirmée avant son début (D-137 : début au plus 15 min dans le passé), remise ensuite.
    t.clock.set('2026-09-24T08:50:00Z');
    const r = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-09-24T09:00:00Z', endAt: '2026-09-24T18:00:00Z', purpose: 'Mission' });
    expect(r.status).toBe(201);
    t.clock.set(NOW);
    const out = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, '10100', { reservationId: r.body.id })).set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    expect(out.body.reservationId).toBe(r.body.id);
    const reservation = await chefA.get(`/reservations/${r.body.id}`);
    expect(reservation.body.status).toBe('CONVERTIE');
    expect(reservation.body.convertedUsageId).toBe(out.body.id);
  });

  it('T07 — retour dépassé avec réservation suivante : alerte, utilisation ouverte, départ suivant bloqué', async () => {
    const out = await chefA.post('/usages/checkout', { ...checkoutBody(vehicleId, f.drivers.a1), expectedReturnAt: '2026-09-24T12:00:00Z' }).set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    const next = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-09-24T14:00:00Z', endAt: '2026-09-24T18:00:00Z', purpose: 'Suivante' });
    expect(next.status).toBe(201);
    t.clock.set('2026-09-24T14:30:00Z');
    const { UsagesService } = await import('../../src/modules/usages/usages.service.js');
    const evaluation = await t.app.get(UsagesService).evaluateLateReturns();
    expect(evaluation.late).toBe(1);
    const late = await t.prisma.client.alert.findFirst({ where: { type: 'RETOUR_DEPASSE', objectId: out.body.id } });
    expect(late?.status).toBe('ACTIVE');
    const compromised = await t.prisma.client.alert.findFirst({ where: { type: 'RESERVATION_COMPROMISE', objectId: next.body.id } });
    expect(compromised?.status).toBe('ACTIVE');
    expect(compromised?.severity).toBe('CRITIQUE');
    // rejouer l'évaluation ne duplique pas les alertes
    await t.app.get(UsagesService).evaluateLateReturns();
    expect(await t.prisma.client.alert.count({ where: { type: 'RETOUR_DEPASSE' } })).toBe(1);
    const usage = await chefA.get(`/usages/${out.body.id}`);
    expect(usage.body.status).toBe('EN_COURS');
    expect(usage.body.isLate).toBe(true);
    const blocked = await chefA.post('/usages/checkout', { ...checkoutBody(vehicleId, f.drivers.a2, '10300', { reservationId: next.body.id }), checkedOutAt: '2026-09-24T14:30:00Z', expectedReturnAt: '2026-09-24T18:00:00Z' }).set('Idempotency-Key', key());
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('VEHICULE_DEJA_EN_UTILISATION');
    // le retour tardif reste possible et résout les alertes
    const back = await chefA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T14:25:00Z', reading: { physicalKm: '10200' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: usage.body.version }).set('Idempotency-Key', key());
    expect(back.status).toBe(200);
    expect((await t.prisma.client.alert.findFirst({ where: { type: 'RETOUR_DEPASSE' } }))?.status).toBe('RESOLUE');
    expect((await t.prisma.client.alert.findFirst({ where: { type: 'RESERVATION_COMPROMISE' } }))?.status).toBe('RESOLUE');
  });

  it('T08 — responsable habituel A et utilisation ponctuelle B restent distincts, historique conservé', async () => {
    const assign = await chefA.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z' });
    expect(assign.status).toBe(201);
    const out = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a2)).set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.body.responsible.driverId).toBe(f.drivers.a1);
    expect(synthesis.body.currentUsage.driverId).toBe(f.drivers.a2);
    const overlap = await chefA.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z' });
    expect(overlap.status).toBe(409);
    const replaced = await chefA.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z', replaceCurrent: true });
    expect(replaced.status).toBe(201);
    const history = await chefA.get(`/responsible-assignments?vehicleId=${vehicleId}`);
    expect(history.body).toHaveLength(2);
    expect(history.body.find((h: { driverId: string }) => h.driverId === f.drivers.a1).endsAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('T22 — document bloquant expiré : départ refusé sauf dérogation autorisée, retour toujours possible', async () => {
    const type = await t.prisma.client.documentType.create({ data: { organizationId: f.organizationId, code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true } });
    await t.prisma.client.documentVersion.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, documentTypeId: type.id, ownerType: 'VEHICULE', vehicleId, validFrom: new Date('2025-09-01T00:00:00Z'), validTo: new Date('2026-09-23T00:00:00Z') } });
    const refused = await operateurA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key());
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DEPART_BLOQUE');
    expect(refused.body.details.blockers[0].code).toBe('DOCUMENT_BLOQUANT');
    const opOverride = await operateurA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, '10100', { overrideReason: 'attestation provisoire reçue' })).set('Idempotency-Key', key());
    expect(opOverride.status).toBe(403);
    const chefOverride = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, '10100', { overrideReason: 'attestation provisoire reçue par e-mail' })).set('Idempotency-Key', key());
    expect(chefOverride.status).toBe(201);
    expect(chefOverride.body.documentOverrideReason).toBe('attestation provisoire reçue par e-mail');
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'utilisation.remise', objectId: chefOverride.body.id } });
    expect(JSON.stringify(audit?.after)).toContain('DOCUMENT_BLOQUANT');
    // la dérogation ne modifie ni l'expiration ni la règle
    const version = await t.prisma.client.documentVersion.findFirstOrThrow({ where: { vehicleId } });
    expect(version.validTo?.toISOString().slice(0, 10)).toBe('2026-09-23');
    const back = await operateurA.post(`/usages/${chefOverride.body.id}/return`, { returnedAt: '2026-09-24T09:30:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: chefOverride.body.version }).set('Idempotency-Key', key());
    expect(back.status).toBe(200);
  });

  it('T23 — immobilisation pendant une utilisation : utilisation conservée, retour possible, véhicule toujours immobilisé', async () => {
    const out = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key());
    const immo = await t.prisma.client.immobilization.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, startedAt: new Date('2026-09-24T09:30:00Z'), status: 'ACTIVE' } });
    await t.prisma.client.immobilizationCause.create({ data: { organizationId: f.organizationId, immobilizationId: immo.id, kind: 'AUTRE', reason: 'Voyant moteur', startedAt: new Date('2026-09-24T09:30:00Z') } });
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('IMMOBILISE');
    expect((await chefA.get(`/usages/${out.body.id}`)).body.status).toBe('EN_COURS');
    const back = await chefA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T09:45:00Z', reading: { physicalKm: '10120' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('TERMINEE');
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('IMMOBILISE');
    const next = await chefA.post('/usages/checkout', { ...checkoutBody(vehicleId, f.drivers.a2, '10130'), checkedOutAt: '2026-09-24T09:50:00Z' }).set('Idempotency-Key', key());
    expect(next.status).toBe(422);
    expect(next.body.details.blockers[0].code).toBe('VEHICULE_IMMOBILISE');
  });

  it('retour contesté : relevé en attente, distance non validée jusqu’à la validation, puis régularisée', async () => {
    const out = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key());
    const back = await operateurA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T09:50:00Z', reading: { physicalKm: '11000' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.status).toBe(200);
    expect(back.body.returnReading.status).toBe('EN_ATTENTE');
    expect(back.body.distanceStatus).toBe('NON_VALIDEE');
    await chefA.post(`/readings/${back.body.returnReading.id}/approve`, { expectedVersion: 1, reason: 'contrôlé' });
    const regularized = await chefA.get(`/usages/${out.body.id}`);
    expect(regularized.body.distanceStatus).toBe('VALIDEE');
    expect(regularized.body.distanceKm).toBe('900.000');
  });

  it('T03 — un conducteur voit ses utilisations et pas celles des autres', async () => {
    const mine = await chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key());
    const theirs = await chefA.post('/usages/checkout', checkoutBody(vehicle2, f.drivers.a2)).set('Idempotency-Key', key());
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const list = await conducteur.get('/usages');
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual([mine.body.id]);
    expect((await conducteur.get(`/usages/${theirs.body.id}`)).status).toBe(404);
    // Un filtre explicite sur un autre conducteur ne remplace jamais le périmètre imposé.
    const forced = await conducteur.get(`/usages?driverId=${theirs.body.driverId}`);
    expect(forced.status).toBe(200);
    expect(forced.body.total).toBe(0);
    expect((await conducteur.get(`/usages?vehicleId=${vehicle2}`)).body.total).toBe(0);
    expect((await conducteur.get(`/vehicles/${vehicle2}`)).status).toBe(404);
    expect((await conducteur.get(`/vehicles/${vehicleId}`)).status).toBe(200);
    expect((await conducteur.post('/usages/checkout', checkoutBody(vehicle2, f.drivers.a1)).set('Idempotency-Key', key())).status).toBe(404);
  });
});
