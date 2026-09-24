import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Relevés : initialisation (D-167), saisie rapide idempotente (D-265), correction, décisions concurrentes,
 * périmètre du compteur des relevés en attente, tri et « Mes soumissions » (CDC 5.1 à 5.5, 10.2, 13.3, 15.3).
 */
describe('Kilométrage — initialisation, saisie rapide, décisions et périmètre', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
  });

  function reading(agent: Agent, physicalKm: string, observedAt: string, vehicle = vehicleId) {
    return agent.post(`/vehicles/${vehicle}/readings`, { physicalKm, observedAt });
  }

  function uploadPhoto(agent: Agent, companyId: string) {
    return request(t.server).post('/api/v1/attachments').set('Cookie', agent.cookies).set('X-CSRF-Token', agent.csrf).set('Origin', TEST_ORIGIN).field('companyId', companyId).attach('file', PNG_1x1, 'compteur.png');
  }

  /** Relevé EN_ATTENTE (hausse implausible saisie par l'opérateur), version 1. */
  async function pendingReading(): Promise<string> {
    expect((await reading(chefA, '80000', '2026-09-23T08:00:00Z')).body.outcome).toBe('ACCEPTE');
    const jump = await reading(operateurA, '90200', '2026-09-24T08:00:00Z');
    expect(jump.body.outcome).toBe('EN_ATTENTE');
    return jump.body.reading.id as string;
  }

  // ---------------------------------------------------------------------------
  // 1. Initialisation (D-167)
  // ---------------------------------------------------------------------------

  it('D-167 — premier relevé du personnel : segment 1 automatique (physique = cumulé) ; initialisation explicite réservée au chef et à l’administrateur', async () => {
    const first = await reading(operateurA, '45200', '2026-09-20T08:00:00Z');
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe('ACCEPTE');
    const segments = await chefA.get(`/vehicles/${vehicleId}/odometer-segments`);
    expect(segments.body).toHaveLength(1);
    expect(segments.body[0]).toMatchObject({ sequence: 1, startPhysicalKm: '45200.000', startCumulativeKm: '45200.000', cumulativeKnown: true });

    // Premiers relevés simultanés sur un compteur non initialisé : un seul segment 1, aucune erreur interne.
    const fresh = await createVehicle(t.prisma, f, 'A');
    const firsts = await Promise.all([
      reading(operateurA, '30000', '2026-09-20T08:00:00Z', fresh),
      reading(chefA, '30100', '2026-09-21T08:00:00Z', fresh),
      reading(chefA, '30200', '2026-09-22T08:00:00Z', fresh),
    ]);
    for (const r of firsts) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId: fresh } })).toBe(1);
    const firstSegment = await t.prisma.client.odometerSegment.findFirstOrThrow({ where: { vehicleId: fresh } });
    expect(firstSegment.sequence).toBe(1);
    expect(firstSegment).toMatchObject({ startedAt: new Date('2026-09-20T08:00:00Z') });
    expect(firstSegment.startCumulativeKm.toString()).toBe('30000');
    expect(firstSegment.startPhysicalKm.toString()).toBe('30000');

    // Initialisation explicite (base cumulée différente) : refusée à l'opérateur, ouverte au chef et à l'administrateur.
    const other = await createVehicle(t.prisma, f, 'A');
    const byOperator = await operateurA.post(`/vehicles/${other}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '0', cumulativeKm: '150000', reason: 'compteur échangé avant achat' });
    expect(byOperator.status).toBe(403);
    expect(byOperator.body.code).toBe('ACTION_INTERDITE');
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId: other } })).toBe(0);
    const byChef = await chefA.post(`/vehicles/${other}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '0', cumulativeKm: '150000', reason: 'compteur échangé avant achat' });
    expect(byChef.status, JSON.stringify(byChef.body)).toBe(201);
    expect(byChef.body).toMatchObject({ startPhysicalKm: '0.000', startCumulativeKm: '150000.000' });
    const third = await createVehicle(t.prisma, f, 'A');
    const byAdmin = await admin.post(`/vehicles/${third}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '98000', cumulativeKnown: false, reason: 'historique inconnu' });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(201);
    expect(byAdmin.body.cumulativeKnown).toBe(false);
    // Le remplacement reste réservé à readings.correct et exige toujours son justificatif (5.4).
    expect((await operateurA.post(`/vehicles/${other}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-10T08:00:00Z', physicalKm: '0', reason: 'remplacement' })).status).toBe(403);
    const noProof = await chefA.post(`/vehicles/${other}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-10T08:00:00Z', physicalKm: '0', reason: 'remplacement' });
    expect(noProof.status).toBe(422);
    expect(noProof.body.code).toBe('JUSTIFICATIF_REQUIS');
  });

  it('D-167 — un relevé du personnel antérieur au premier relevé avance le début du segment 1 ordinaire ; un segment initialisé explicitement garde sa date', async () => {
    expect((await reading(chefA, '30200', '2026-09-22T08:00:00Z')).body.outcome).toBe('ACCEPTE');
    const earlier = await reading(operateurA, '30000', '2026-09-20T08:00:00Z');
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(201);
    expect(earlier.body.outcome).toBe('ACCEPTE');
    expect(earlier.body.reading.cumulativeKm).toBe('30000.000');
    const segments = await chefA.get(`/vehicles/${vehicleId}/odometer-segments`);
    expect(segments.body).toHaveLength(1);
    expect(segments.body[0]).toMatchObject({ sequence: 1, startedAt: '2026-09-20T08:00:00.000Z', startPhysicalKm: '30000.000', startCumulativeKm: '30000.000' });
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('30200.000');
    // La chronologie reste contrôlée : une valeur antérieure plus élevée est refusée et le segment est inchangé.
    const broken = await reading(chefA, '30500', '2026-09-18T08:00:00Z');
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe('CHRONOLOGIE_SUIVANT');
    expect((await t.prisma.client.odometerSegment.findFirstOrThrow({ where: { vehicleId } })).startedAt.toISOString()).toBe('2026-09-20T08:00:00.000Z');

    const explicit = await createVehicle(t.prisma, f, 'A');
    expect((await chefA.post(`/vehicles/${explicit}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-10T08:00:00Z', physicalKm: '100' })).status).toBe(201);
    const before = await reading(chefA, '90', '2026-09-05T08:00:00Z', explicit);
    expect(before.status).toBe(422);
    expect(before.body.code).toBe('AVANT_DEBUT_SEGMENT');
    expect(Object.keys(before.body.fieldErrors)).toEqual(['observedAt']);
  });

  it('D-167 — le premier relevé d’un segment ordinaire se corrige (faute de frappe) et le début du segment le suit', async () => {
    const typo = await reading(operateurA, '452000', '2026-09-20T08:00:00Z');
    expect(typo.body.outcome).toBe('ACCEPTE');
    const fixed = await chefA.post(`/readings/${typo.body.reading.id}/correct`, { reason: 'faute de frappe', replacementReading: { physicalKm: '45200' }, expectedVersion: 1 }).set('Idempotency-Key', 'premier-releve-0001');
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ physicalKm: '45200.000', cumulativeKm: '45200.000', status: 'ACCEPTE' });
    let segment = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body[0];
    expect(segment).toMatchObject({ sequence: 1, startedAt: '2026-09-20T08:00:00.000Z', startPhysicalKm: '45200.000', startCumulativeKm: '45200.000' });
    expect((await reading(operateurA, '45300', '2026-09-22T08:00:00Z')).body.outcome).toBe('ACCEPTE');

    // La date du premier relevé peut aussi être avancée : le segment ordinaire couvre la nouvelle date.
    const earlier = await chefA.post(`/readings/${fixed.body.id}/correct`, { reason: 'date de lecture erronée', replacementReading: { physicalKm: '45100', observedAt: '2026-09-18T08:00:00Z' }, expectedVersion: 1 }).set('Idempotency-Key', 'premier-releve-0002');
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    segment = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body[0];
    expect(segment).toMatchObject({ startedAt: '2026-09-18T08:00:00.000Z', startPhysicalKm: '45100.000', startCumulativeKm: '45100.000' });
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('45300.000');
    // La chronologie avec les voisins reste contrôlée.
    const broken = await chefA.post(`/readings/${earlier.body.id}/correct`, { reason: 'erreur', replacementReading: { physicalKm: '45400' }, expectedVersion: 1 }).set('Idempotency-Key', 'premier-releve-0003');
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe('CORRECTION_BLOQUEE');
    expect(broken.body.details.anomaly).toBe('CHRONOLOGIE_SUIVANT');
  });

  it('D-167 — une soumission conducteur rejetée sur un véhicule sans compteur ne bloque ni le premier relevé du personnel ni les soumissions suivantes', async () => {
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:30:00Z'), expectedReturnAt: new Date('2026-09-25T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const typo = await conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '500000', observedAt: '2026-09-24T08:40:00Z' });
    expect(typo.body.outcome).toBe('EN_ATTENTE');
    expect((await chefA.post(`/readings/${typo.body.reading.id}/reject`, { expectedVersion: 1, reason: 'faute de frappe' })).status).toBe(200);

    const staff = await reading(operateurA, '50000', '2026-09-24T09:00:00Z');
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    expect(staff.body.outcome).toBe('ACCEPTE');
    expect(staff.body.reading.cumulativeKm).toBe('50000.000');
    const segments = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body;
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ sequence: 1, startPhysicalKm: '50000.000', startCumulativeKm: '50000.000' });

    const next = await conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '50010', observedAt: '2026-09-24T09:30:00Z' });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.outcome).toBe('EN_ATTENTE');
    expect(next.body.anomaly.code).toBe('SOUMISSION_CONDUCTEUR');
  });

  it('D-167 — initialisation explicite après une soumission conducteur en attente : un seul segment, cumul de la soumission recalculé sur la base déclarée', async () => {
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:30:00Z'), expectedReturnAt: new Date('2026-09-25T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const submitted = await conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '50000', observedAt: '2026-09-24T09:00:00Z' });
    expect(submitted.body.outcome).toBe('EN_ATTENTE');

    const init = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '40000', cumulativeKm: '150000', reason: 'compteur échangé avant achat' });
    expect(init.status, JSON.stringify(init.body)).toBe(201);
    const segments = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body;
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ sequence: 1, startedAt: '2026-09-01T08:00:00.000Z', endedAt: null, startPhysicalKm: '40000.000', startCumulativeKm: '150000.000' });
    const pending = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: submitted.body.reading.id } });
    expect(pending.segmentId).toBe(segments[0].id);
    expect(pending.cumulativeKm?.toString()).toBe('160000');
    expect(pending.version).toBe(2);

    const approved = await chefA.post(`/readings/${pending.id}/approve`, { expectedVersion: 2, reason: 'vérifié' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const current = (await chefA.get(`/vehicles/${vehicleId}/odometer`)).body;
    expect(current.reading).toMatchObject({ id: pending.id, physicalKm: '50000.000', cumulativeKm: '160000.000' });
  });

  it('D-167 — un relevé d’exécution d’intervention du personnel initialise aussi le compteur (premier relevé accepté)', async () => {
    const created = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Diagnostic bruit moteur' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const done = await chefA
      .post(`/interventions/${created.body.id}/complete`, { completedTaskIds: created.body.tasks.map((x: { id: string }) => x.id), expectedVersion: created.body.version, performedOn: '2026-09-24', newReading: { physicalKm: '61000', observedAt: '2026-09-24T09:00:00Z' } })
      .set('Idempotency-Key', 'intervention-premier-releve-0001');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const segments = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body;
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ sequence: 1, startPhysicalKm: '61000.000', startCumulativeKm: '61000.000', cumulativeKnown: true });
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading).toMatchObject({ physicalKm: '61000.000', cumulativeKm: '61000.000', context: 'ENTRETIEN' });
  });

  // ---------------------------------------------------------------------------
  // 2. Saisie rapide (D-265)
  // ---------------------------------------------------------------------------

  it('D-265 — la saisie rapide exige une clé d’idempotence', async () => {
    const res = await chefA.post('/readings/batch', { items: [{ vehicleId, physicalKm: '1000', observedAt: '2026-09-20T08:00:00Z' }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');
    expect(await t.prisma.client.odometerReading.count()).toBe(0);
  });

  it('D-265 — même lot envoyé deux fois avec la même clé : aucune ligne dupliquée, mêmes résultats ; photo rattachée', async () => {
    const v2 = await createVehicle(t.prisma, f, 'A');
    const v3 = await createVehicle(t.prisma, f, 'A');
    await reading(chefA, '5000', '2026-09-20T08:00:00Z', v3);
    const photo = await uploadPhoto(chefA, f.companies.A);
    expect(photo.status).toBe(201);
    const body = {
      items: [
        { vehicleId, physicalKm: '12000', observedAt: '2026-09-23T08:00:00Z', attachmentId: photo.body.id as string },
        { vehicleId: v2, physicalKm: '30500', observedAt: '2026-09-23T08:00:00Z', note: 'parking nord' },
        { vehicleId: v3, physicalKm: '4000', observedAt: '2026-09-23T08:00:00Z' },
      ],
    };
    const first = await chefA.post('/readings/batch', body).set('Idempotency-Key', 'lot-kilometrage-0001');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.map((r: { outcome: string }) => r.outcome)).toEqual(['ACCEPTE', 'ACCEPTE', 'REFUSE']);
    expect(first.body[2].code).toBe('DIMINUTION');
    const withPhoto = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: first.body[0].readingId } });
    expect(withPhoto.attachmentId).toBe(photo.body.id);
    const attachment = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: photo.body.id } });
    expect(attachment).toMatchObject({ ownerType: 'RELEVE', ownerId: withPhoto.id });

    const again = await chefA.post('/readings/batch', body).set('Idempotency-Key', 'lot-kilometrage-0001');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: { in: [vehicleId, v2] } } })).toBe(2);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'releve.saisie' } })).toBe(3);

    // Coupure après la première ligne : le renvoi avec la même clé rejoue la ligne déjà traitée, sans doublon.
    const v4 = await createVehicle(t.prisma, f, 'A');
    const partial = await chefA.post('/readings/batch', { items: [{ vehicleId: v4, physicalKm: '777', observedAt: '2026-09-23T09:00:00Z' }] }).set('Idempotency-Key', 'lot-kilometrage-0002');
    expect(partial.body[0].outcome).toBe('ACCEPTE');
    const resent = await chefA.post('/readings/batch', { items: [{ vehicleId: v4, physicalKm: '777', observedAt: '2026-09-23T09:00:00Z' }, { vehicleId: v2, physicalKm: '30600', observedAt: '2026-09-23T09:00:00Z' }] }).set('Idempotency-Key', 'lot-kilometrage-0002');
    expect(resent.body[0]).toEqual(partial.body[0]);
    expect(resent.body[1].outcome).toBe('ACCEPTE');
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: v4 } })).toBe(1);
    // Même clé, autre valeur pour une ligne déjà enregistrée : refus de cette ligne seulement.
    const changed = await chefA.post('/readings/batch', { items: [{ vehicleId: v4, physicalKm: '778', observedAt: '2026-09-23T09:00:00Z' }] }).set('Idempotency-Key', 'lot-kilometrage-0002');
    expect(changed.body[0]).toMatchObject({ outcome: 'REFUSE', code: 'IDEMPOTENCE_CORPS_DIFFERENT' });
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: v4 } })).toBe(1);
  });

  it('D-265 — deux envois simultanés du même lot ne créent aucun doublon ; un véhicule ne figure qu’une fois par lot', async () => {
    const vehicles = [vehicleId, await createVehicle(t.prisma, f, 'A'), await createVehicle(t.prisma, f, 'A')];
    const body = { items: vehicles.map((id, i) => ({ vehicleId: id, physicalKm: String(10000 + i), observedAt: '2026-09-23T08:00:00Z' })) };
    const responses = await Promise.all([0, 1, 2].map(() => chefA.post('/readings/batch', body).set('Idempotency-Key', 'lot-simultane-0001')));
    for (const r of responses) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId: { in: vehicles } } })).toBe(3);
    const replay = await chefA.post('/readings/batch', body).set('Idempotency-Key', 'lot-simultane-0001');
    expect(replay.body.map((r: { outcome: string }) => r.outcome)).toEqual(['ACCEPTE', 'ACCEPTE', 'ACCEPTE']);
    const duplicated = await chefA.post('/readings/batch', { items: [{ vehicleId, physicalKm: '20000', observedAt: '2026-09-24T08:00:00Z' }, { vehicleId, physicalKm: '20010', observedAt: '2026-09-24T09:00:00Z' }] }).set('Idempotency-Key', 'lot-doublon-0001');
    expect(duplicated.status).toBe(422);
    expect(duplicated.body.code).toBe('VEHICULE_EN_DOUBLE');
    expect(duplicated.body.fieldErrors['items.1.vehicleId']).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3. Correction : erreurs sous les clés du DTO
  // ---------------------------------------------------------------------------

  it('correction : les erreurs de valeur portent les clés replacementReading.physicalKm et replacementReading.observedAt', async () => {
    await reading(chefA, '40000', '2026-09-20T08:00:00Z');
    const end = await reading(chefA, '40300', '2026-09-21T08:00:00Z');
    const id = end.body.reading.id as string;
    const correct = (replacementReading: Record<string, string>, key: string) =>
      chefA.post(`/readings/${id}/correct`, { reason: 'erreur de saisie', replacementReading, expectedVersion: 1 }).set('Idempotency-Key', key);

    const dto = await correct({ physicalKm: 'abc' }, 'correction-cles-0001');
    expect(dto.status).toBe(422);
    expect(Object.keys(dto.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);

    const negative = await correct({ physicalKm: '-5' }, 'correction-cles-0002');
    expect(negative.status).toBe(422);
    expect(negative.body.code).toBe('VALEUR_NEGATIVE');
    expect(Object.keys(negative.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);

    const format = await correct({ physicalKm: '40250.1234' }, 'correction-cles-0003');
    expect(format.body.code).toBe('VALEUR_INVALIDE');
    expect(Object.keys(format.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);

    const broken = await correct({ physicalKm: '39000' }, 'correction-cles-0004');
    expect(broken.body.code).toBe('CORRECTION_BLOQUEE');
    expect(Object.keys(broken.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);

    const future = await correct({ physicalKm: '40250', observedAt: '2026-09-25T08:00:00Z' }, 'correction-cles-0005');
    expect(future.status).toBe(422);
    expect(Object.keys(future.body.fieldErrors)).toEqual(['replacementReading.observedAt']);

    // Segment 1 ordinaire : son début suit le premier relevé, une date antérieure est contrôlée par les voisins.
    const beforeFirst = await correct({ physicalKm: '40250', observedAt: '2020-01-01T08:00:00Z' }, 'correction-cles-0006');
    expect(beforeFirst.body.code).toBe('CORRECTION_BLOQUEE');
    expect(Object.keys(beforeFirst.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);

    // Compteur initialisé explicitement : sa date d'installation borne la correction (HORS_SEGMENT).
    const explicit = await createVehicle(t.prisma, f, 'A');
    expect((await chefA.post(`/vehicles/${explicit}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-10T08:00:00Z', physicalKm: '100' })).status).toBe(201);
    const later = await reading(chefA, '300', '2026-09-20T08:00:00Z', explicit);
    const outside = await chefA.post(`/readings/${later.body.reading.id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '250', observedAt: '2026-09-05T08:00:00Z' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-cles-0007');
    expect(outside.status).toBe(422);
    expect(outside.body.code).toBe('HORS_SEGMENT');
    expect(Object.keys(outside.body.fieldErrors)).toEqual(['replacementReading.observedAt']);

    // Rien n'a été modifié.
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTE');
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: later.body.reading.id } })).status).toBe('ACCEPTE');
  });

  it('correction vers la valeur et l’instant d’un autre relevé accepté : 422 sous replacementReading.physicalKm, jamais 500 ni doublon', async () => {
    const first = await reading(chefA, '40000', '2026-09-20T08:00:00Z');
    const end = await reading(chefA, '40300', '2026-09-21T08:00:00Z');
    const id = end.body.reading.id as string;
    for (const [observedAt, key] of [['2026-09-20T08:00:00Z', 'correction-doublon-0001'], ['2026-09-20T08:00:30Z', 'correction-doublon-0002']] as const) {
      const res = await chefA.post(`/readings/${id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '40000', observedAt }, expectedVersion: 1 }).set('Idempotency-Key', key);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('CORRECTION_BLOQUEE');
      expect(res.body.details).toMatchObject({ anomaly: 'CONFLIT_MEME_INSTANT', existingReadingId: first.body.reading.id });
      expect(Object.keys(res.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);
    }
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(2);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTE');
  });

  // ---------------------------------------------------------------------------
  // 4. Décisions concurrentes : 409, jamais 500
  // ---------------------------------------------------------------------------

  it('validation et rejet simultanés du même relevé : un seul gagnant, l’autre reçoit 409 avec la version courante', async () => {
    const id = await pendingReading();
    const [approve, reject] = await Promise.all([
      chefA.post(`/readings/${id}/approve`, { expectedVersion: 1, reason: 'long trajet vérifié' }),
      chefA.post(`/readings/${id}/reject`, { expectedVersion: 1, reason: 'valeur douteuse' }),
    ]);
    const statuses = [approve.status, reject.status].sort();
    expect(statuses, JSON.stringify([approve.body, reject.body])).toEqual([200, 409]);
    const loser = approve.status === 409 ? approve : reject;
    expect(loser.body.code).toBe('VERSION_OBSOLETE');
    expect(loser.body.details).toMatchObject({ currentVersion: 2, expectedVersion: 1 });
    const stored = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id } });
    expect(stored.version).toBe(2);
    expect(stored.status).toBe(approve.status === 200 ? 'ACCEPTE' : 'REJETE');
    expect(await t.prisma.client.auditEvent.count({ where: { objectId: id, action: { in: ['releve.validation', 'releve.rejet'] } } })).toBe(1);
  });

  it('rejets simultanés et validations simultanées : un seul effet, 409 pour les autres', async () => {
    const id = await pendingReading();
    const rejects = await Promise.all([1, 2, 3].map(() => chefA.post(`/readings/${id}/reject`, { expectedVersion: 1, reason: 'valeur douteuse' })));
    expect(rejects.map((r) => r.status).sort(), JSON.stringify(rejects.map((r) => r.body))).toEqual([200, 409, 409]);
    for (const r of rejects.filter((x) => x.status === 409)) expect(r.body.details).toMatchObject({ currentVersion: 2 });
    expect(await t.prisma.client.auditEvent.count({ where: { objectId: id, action: 'releve.rejet' } })).toBe(1);

    const other = await createVehicle(t.prisma, f, 'A');
    await reading(chefA, '1000', '2026-09-22T08:00:00Z', other);
    const jump = await reading(operateurA, '20000', '2026-09-23T08:00:00Z', other);
    const approvals = await Promise.all([1, 2, 3].map(() => chefA.post(`/readings/${jump.body.reading.id}/approve`, { expectedVersion: 1, reason: 'vérifié' })));
    expect(approvals.map((r) => r.status).sort(), JSON.stringify(approvals.map((r) => r.body))).toEqual([200, 409, 409]);
    expect(await t.prisma.client.auditEvent.count({ where: { objectId: jump.body.reading.id, action: 'releve.validation' } })).toBe(1);
  });

  it('corrections simultanées du même relevé (clés différentes) : un seul remplacement, 409 pour l’autre', async () => {
    await reading(chefA, '40000', '2026-09-20T08:00:00Z');
    const end = await reading(chefA, '40300', '2026-09-21T08:00:00Z');
    const id = end.body.reading.id as string;
    const [a, b] = await Promise.all([
      chefA.post(`/readings/${id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '40250' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-course-a'),
      chefA.post(`/readings/${id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '40260' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-course-b'),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('VERSION_OBSOLETE');
    expect(loser.body.details).toMatchObject({ currentVersion: 2 });
    expect(await t.prisma.client.odometerReading.count({ where: { replacesReadingId: id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. et 6. Compteur des relevés en attente et tri de l'historique du véhicule
  // ---------------------------------------------------------------------------

  it('pendingCount suit exactement le filtre de GET /vehicles/:id/readings?status=EN_ATTENTE (périmètre de sociétés)', async () => {
    await pendingReading();
    // Transfert du véhicule vers la société B : le relevé en attente reste rattaché à la société A (société à l'observation).
    await t.prisma.client.vehicle.update({ where: { id: vehicleId }, data: { companyId: f.companies.B } });
    const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    const current = await chefB.get(`/vehicles/${vehicleId}/odometer`);
    expect(current.status).toBe(200);
    const listed = await chefB.get(`/vehicles/${vehicleId}/readings?status=EN_ATTENTE`);
    expect(listed.body.total).toBe(0);
    expect(current.body.pendingCount).toBe(listed.body.total);
    const byAdmin = await admin.get(`/vehicles/${vehicleId}/odometer`);
    expect(byAdmin.body.pendingCount).toBe(1);
    expect((await admin.get(`/vehicles/${vehicleId}/readings?status=EN_ATTENTE`)).body.total).toBe(1);
  });

  it('pendingCount d’un conducteur : ses seules soumissions, comme la liste du véhicule', async () => {
    await pendingReading();
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:30:00Z'), expectedReturnAt: new Date('2026-09-25T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '90300', observedAt: '2026-09-24T09:30:00Z' })).body.outcome).toBe('EN_ATTENTE');
    const current = await conducteur.get(`/vehicles/${vehicleId}/odometer`);
    const listed = await conducteur.get(`/vehicles/${vehicleId}/readings?status=EN_ATTENTE`);
    expect(listed.body.total).toBe(1);
    expect(current.body.pendingCount).toBe(1);
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.pendingCount).toBe(2);
  });

  it('GET /vehicles/:id/readings applique le paramètre order (récent d’abord par défaut)', async () => {
    await reading(chefA, '1000', '2026-09-10T08:00:00Z');
    await reading(chefA, '1500', '2026-09-15T08:00:00Z');
    await reading(chefA, '1200', '2026-09-12T08:00:00Z');
    const km = (res: { body: { items: Array<{ physicalKm: string }> } }) => res.body.items.map((r) => r.physicalKm);
    expect(km(await chefA.get(`/vehicles/${vehicleId}/readings?order=asc`))).toEqual(['1000.000', '1200.000', '1500.000']);
    expect(km(await chefA.get(`/vehicles/${vehicleId}/readings?order=desc`))).toEqual(['1500.000', '1200.000', '1000.000']);
    expect(km(await chefA.get(`/vehicles/${vehicleId}/readings`))).toEqual(['1500.000', '1200.000', '1000.000']);
    expect(km(await chefA.get(`/readings?vehicleId=${vehicleId}&order=asc`))).toEqual(['1000.000', '1200.000', '1500.000']);
    expect((await chefA.get(`/vehicles/${vehicleId}/readings?order=haut`)).status).toBe(422);
  });

  // ---------------------------------------------------------------------------
  // 7. Soumissions du conducteur (D-268) et « Mes soumissions » du personnel ayant un profil conducteur
  // ---------------------------------------------------------------------------

  it('D-268 — conducteur : relevé sur son utilisation EN_COURS ; sur son véhicule habituel seulement si drivers.allowHabitualVehicleSubmissions', async () => {
    await reading(chefA, '50000', '2026-09-20T08:00:00Z');
    await t.prisma.client.vehicleResponsibleAssignment.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, startsAt: new Date('2026-09-01T00:00:00Z') } });
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const submit = (vehicle: string, physicalKm: string) => conducteur.post(`/vehicles/${vehicle}/readings`, { physicalKm, observedAt: '2026-09-24T09:00:00Z' });

    // Paramètre inactif (défaut) : le véhicule habituel est visible mais la soumission est refusée (403, D-118).
    const refused = await submit(vehicleId, '50100');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACTION_INTERDITE');
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, status: 'EN_ATTENTE' } })).toBe(0);

    const enabled = await admin.put('/settings/drivers.allowHabitualVehicleSubmissions', { value: true, reason: 'responsables habituels autorisés' });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const allowed = await submit(vehicleId, '50100');
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.outcome).toBe('EN_ATTENTE');
    expect(allowed.body.anomaly.code).toBe('SOUMISSION_CONDUCTEUR');

    // Un véhicule sans utilisation ni affectation reste hors périmètre (404).
    const stranger = await createVehicle(t.prisma, f, 'A');
    expect((await submit(stranger, '1000')).status).toBe(404);

    // Utilisation EN_COURS sur un autre véhicule : c'est ce véhicule qui ouvre les soumissions.
    const used = await createVehicle(t.prisma, f, 'A');
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: used, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:30:00Z'), expectedReturnAt: new Date('2026-09-25T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const onUsage = await submit(used, '12000');
    expect(onUsage.status, JSON.stringify(onUsage.body)).toBe(201);
    expect(onUsage.body.outcome).toBe('EN_ATTENTE');
    expect((await submit(vehicleId, '50200')).status).toBe(403);
    const mine = await conducteur.get('/readings');
    expect(mine.body.total).toBe(2);
  });

  it('GET /readings?mine=true : relevés dont l’utilisateur courant est l’auteur', async () => {
    await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, code: 'D-CHEF', firstName: 'Chaima', lastName: 'Chef-A', userId: f.users.chefA } });
    const chefWithDriver = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const other = await createVehicle(t.prisma, f, 'A');
    const own = await reading(chefWithDriver, '1000', '2026-09-20T08:00:00Z');
    await reading(operateurA, '5000', '2026-09-20T08:00:00Z', other);
    const mine = await chefWithDriver.get('/readings?mine=true');
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].id).toBe(own.body.reading.id);
    expect((await chefWithDriver.get('/readings?mine=false')).body.total).toBe(2);
    expect((await chefWithDriver.get('/readings')).body.total).toBe(2);
    expect((await chefWithDriver.get('/readings?mine=oui')).status).toBe(422);
  });
});
