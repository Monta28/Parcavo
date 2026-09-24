import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Contrôles de départ, de confirmation et de sortie du parc (CDC 2.4, 3.2, 3.3, 4.2 à 4.4) exercés par l'API
 * réelle : société, conducteur inactif, documents bloquants, relevé non accepté, véhicule non ACTIF,
 * réservations futures, opérations ouvertes, et données de remise/restitution enregistrées.
 */
describe('Remise, réservation et cycle de vie — contrôles serveur (CDC 2.4, 3.2, 3.3, 4.2 à 4.4)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let keySeq = 0;
  const key = () => `cle-ctrl-${Date.now()}-${keySeq++}`;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2, f.drivers.b1].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
  });

  const checkoutBody = (driverId: string, extra: Record<string, unknown> = {}) => ({
    vehicleId,
    driverId,
    checkedOutAt: '2026-09-24T09:00:00Z',
    expectedReturnAt: '2026-09-24T18:00:00Z',
    purpose: 'Mission client',
    reading: { physicalKm: '10100' },
    location: { placeLabel: 'Dépôt central' },
    ...extra,
  });
  const uploadPng = async (agent: Agent, name: string): Promise<string> => {
    const res = await request(t.server).post('/api/v1/attachments').set('Cookie', agent.cookies).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', agent.csrf).field('companyId', f.companies.A).attach('file', PNG_1x1, name);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { id: string }).id;
  };
  const setLifecycle = async (id: string, lifecycleStatus: string, reason: string) => {
    const v = await chefA.get(`/vehicles/${id}`);
    return chefA.post(`/vehicles/${id}/lifecycle`, { lifecycleStatus, reason, expectedVersion: v.body.version });
  };

  it('R-2.4-09 — remise d’un véhicule de la société A à un conducteur de la société B : refusée (SOCIETE_DIFFERENTE), rien n’est créé', async () => {
    // Le chef A ne voit pas le conducteur B : 404 sans révéler son existence.
    expect((await chefA.post('/usages/checkout', checkoutBody(f.drivers.b1)).set('Idempotency-Key', key())).status).toBe(404);
    const res = await admin.post('/usages/checkout', checkoutBody(f.drivers.b1)).set('Idempotency-Key', key());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DEPART_BLOQUE');
    expect(res.body.details.blockers.map((b: { code: string }) => b.code)).toContain('SOCIETE_DIFFERENTE');
    // Même contrôle à la confirmation d'une réservation.
    const reservation = await admin.post('/reservations', { vehicleId, driverId: f.drivers.b1, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission' });
    expect(reservation.status).toBe(422);
    expect(reservation.body.details.blockers.map((b: { code: string }) => b.code)).toContain('SOCIETE_DIFFERENTE');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    expect(await t.prisma.client.odometerReading.count({ where: { context: 'REMISE' } })).toBe(0);
  });

  it('R-3.3-06 / R-4.2-04 — conducteur inactif : remise et confirmation de réservation refusées ; document bloquant : réservation refusée sauf dérogation motivée du chef', async () => {
    await t.prisma.client.driver.update({ where: { id: f.drivers.a2 }, data: { status: 'INACTIF' } });
    const checkout = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a2)).set('Idempotency-Key', key());
    expect(checkout.status).toBe(422);
    expect(checkout.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(['CONDUCTEUR_INACTIF']);
    const booking = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission' });
    expect(booking.status).toBe(422);
    expect(booking.body.code).toBe('RESERVATION_BLOQUEE');
    expect(booking.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(['CONDUCTEUR_INACTIF']);
    // La dérogation ne lève jamais un blocage dur.
    expect((await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission', overrideReason: 'Réactivation prévue demain' })).status).toBe(422);

    // Document bloquant manquant pour le véhicule : confirmation refusée, dérogation motivée réservée au chef.
    await t.prisma.client.documentType.create({ data: { organizationId: f.organizationId, code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true } });
    const blocked = await operateurA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T12:00:00Z', purpose: 'Mission' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.details).toMatchObject({ overridable: true });
    expect(blocked.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(['DOCUMENT_BLOQUANT']);
    expect((await operateurA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T12:00:00Z', purpose: 'Mission', overrideReason: 'Attestation reçue par e-mail' })).status).toBe(403);
    const overridden = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T12:00:00Z', purpose: 'Mission', overrideReason: 'Attestation reçue par e-mail' });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(201);
    expect(await t.prisma.client.reservation.count()).toBe(1);
  });

  it('R-4.3-03 — relevé de départ mis en attente (hausse implausible) : départ refusé RELEVE_NON_ACCEPTE, ni utilisation ni relevé enregistrés', async () => {
    // 40 000 km en 23 jours : au-delà du seuil de 1 500 km par 24 h → le relevé serait mis en attente.
    const res = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a1, { reading: { physicalKm: '50000' } })).set('Idempotency-Key', key());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RELEVE_NON_ACCEPTE');
    expect(res.body.fieldErrors['reading.physicalKm'][0]).toContain('seuil de plausibilité');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, status: 'EN_ATTENTE' } })).toBe(0);
    expect((await chefA.get(`/vehicles/${vehicleId}`)).body.operationalStatus).toBe('DISPONIBLE');
  });

  it('R-4.3-02 / R-4.4-01 — carburant, checklist, observations, confirmation nominative et photos enregistrés à la remise et à la restitution', async () => {
    const outPhoto = await uploadPng(operateurA, 'depart.png');
    const out = await operateurA
      .post('/usages/checkout', checkoutBody(f.drivers.a1, { fuelGauge: 'TROIS_QUARTS', checklist: [{ label: 'Clés', present: true }, { label: 'Gilet', present: false, comment: 'manquant' }], notes: 'Pare-brise impacté', confirmedByName: 'Karim C.', photoAttachmentIds: [outPhoto] }))
      .set('Idempotency-Key', key());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body).toMatchObject({ checkoutFuelGauge: 'TROIS_QUARTS', checkoutNotes: 'Pare-brise impacté', checkoutConfirmedBy: 'Karim C.', photoAttachmentIds: [outPhoto] });
    expect(out.body.checkoutChecklist).toEqual([{ label: 'Clés', present: true }, { label: 'Gilet', present: false, comment: 'manquant' }]);
    t.clock.set('2026-09-24T17:00:00Z');
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    const backPhoto = await uploadPng(operateurA, 'retour.png');
    const back = await operateurA
      .post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T16:00:00Z', reading: { physicalKm: '10300' }, location: { placeLabel: 'Parking siège' }, fuelGauge: 'QUART', checklist: [{ label: 'Clés', present: true }], notes: 'RAS', confirmedByName: 'Karim C.', photoAttachmentIds: [backPhoto], expectedVersion: out.body.version })
      .set('Idempotency-Key', key());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ returnedAt: '2026-09-24T16:00:00.000Z', returnFuelGauge: 'QUART', returnNotes: 'RAS', returnConfirmedBy: 'Karim C.', returnLocation: 'Parking siège', distanceKm: '200.000', distanceStatus: 'VALIDEE' });
    expect(back.body.returnChecklist).toEqual([{ label: 'Clés', present: true }]);
    expect([...back.body.photoAttachmentIds].sort()).toEqual([outPhoto, backPhoto].sort());
    const stored = await t.prisma.client.attachment.findMany({ where: { ownerType: 'UTILISATION', ownerId: out.body.id } });
    expect(stored).toHaveLength(2);
    // Les photos se téléchargent par le propriétaire (utilisation) dans le périmètre.
    expect((await chefA.get(`/attachments/${backPhoto}/download`)).status).toBe(200);
  });

  it('R-3.2-03 — une réservation future apparaît au planning sans rendre le véhicule « en utilisation »', async () => {
    const r = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a1, startAt: '2026-09-25T08:00:00Z', endAt: '2026-09-25T18:00:00Z', purpose: 'Mission demain' });
    expect(r.status).toBe(201);
    const vehicle = await chefA.get(`/vehicles/${vehicleId}`);
    expect(vehicle.body.operationalStatus).toBe('DISPONIBLE');
    expect(vehicle.body.currentUsage).toBeNull();
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.body.currentUsage).toBeNull();
    expect((await chefA.get('/usages?status=EN_COURS')).body.total).toBe(0);
    const planning = await chefA.get('/planning?from=2026-09-25T00:00:00Z&to=2026-09-26T00:00:00Z');
    expect(planning.status, JSON.stringify(planning.body)).toBe(200);
    expect(JSON.stringify(planning.body)).toContain(r.body.id);
  });

  it('R-3.2-X01 — véhicule HORS_SERVICE : réservation et remise refusées en 409 VEHICULE_NON_ACTIF ; la restitution d’une utilisation ouverte reste possible', async () => {
    const out = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a1)).set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    // Le changement de cycle de vie ne masque pas l'utilisation ouverte (3.2).
    expect((await setLifecycle(vehicleId, 'HORS_SERVICE', 'Panne moteur constatée')).status).toBe(200);
    const vehicle = await chefA.get(`/vehicles/${vehicleId}`);
    expect(vehicle.body.lifecycleStatus).toBe('HORS_SERVICE');
    expect(vehicle.body.currentUsage.id).toBe(out.body.id);
    const back = await chefA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T09:30:00Z', reading: { physicalKm: '10120' }, location: { placeLabel: 'Garage' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.status).toBe('TERMINEE');
    const checkout = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a2, { checkedOutAt: '2026-09-24T09:45:00Z', reading: { physicalKm: '10120' } })).set('Idempotency-Key', key());
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe('VEHICULE_NON_ACTIF');
    expect(checkout.body.message).toContain('pas en service');
    const reservation = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission' });
    expect(reservation.status).toBe(409);
    expect(reservation.body.code).toBe('VEHICULE_NON_ACTIF');
    expect(await t.prisma.client.reservation.count()).toBe(0);
    // Remis en service : la réservation est de nouveau acceptée.
    expect((await setLifecycle(vehicleId, 'ACTIF', 'Réparation terminée')).status).toBe(200);
    expect((await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission' })).status).toBe(201);
  });

  it('R-13.3-03 / R-18-05 — remise saisie après coup : refusée (409) si elle précède la dernière restitution du véhicule ou du conducteur, acceptée à l’instant même de la restitution', async () => {
    const out = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a1, { checkedOutAt: '2026-09-24T07:00:00Z' })).set('Idempotency-Key', key());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    // Retour constaté sans relevé à 09:00 (distance non validée, régularisable jusqu'à la remise suivante).
    const back = await chefA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T09:00:00Z', readingException: { reason: 'Compteur illisible au retour' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // Même véhicule, autre conducteur, départ antidaté à 08:30 : le véhicule était encore remis à A1.
    const vehicleOverlap = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a2, { checkedOutAt: '2026-09-24T08:30:00Z', reading: { physicalKm: '10150' } })).set('Idempotency-Key', key());
    expect(vehicleOverlap.status).toBe(409);
    expect(vehicleOverlap.body.code).toBe('VEHICULE_DEJA_EN_UTILISATION');
    expect(vehicleOverlap.body.message).toContain('restitué le 24/09/2026 à 10:00');
    // Même conducteur, autre véhicule, départ antidaté à 08:00 : A1 conduisait encore le premier véhicule.
    const other = await createVehicle(t.prisma, f, 'A', { code: 'VA-2' });
    const driverOverlap = await chefA
      .post('/usages/checkout', { ...checkoutBody(f.drivers.a1), vehicleId: other, checkedOutAt: '2026-09-24T08:00:00Z', reading: undefined, readingException: { reason: 'Compteur absent sur ce véhicule' } })
      .set('Idempotency-Key', key());
    expect(driverOverlap.status).toBe(409);
    expect(driverOverlap.body.code).toBe('CONDUCTEUR_DEJA_EN_UTILISATION');
    // L'aperçu de remise annonce le même blocage avant toute saisie.
    const preview = await chefA.get(`/usages/checkout-preview?vehicleId=${vehicleId}&driverId=${f.drivers.a2}&at=2026-09-24T08:30:00.000Z`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.blockers.map((b: { code: string }) => b.code)).toContain('VEHICULE_DEJA_EN_UTILISATION');
    expect(await t.prisma.client.vehicleUsage.count()).toBe(1);
    // Départ à l'instant même de la restitution ([début, fin[) : accepté.
    const next = await chefA.post('/usages/checkout', checkoutBody(f.drivers.a2, { checkedOutAt: '2026-09-24T09:00:00Z', reading: { physicalKm: '10150' } })).set('Idempotency-Key', key());
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });
});
