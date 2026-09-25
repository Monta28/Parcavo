import pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';

const NOW = '2026-09-24T10:00:00.000Z';
const databaseUrl = (): string => process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';

/**
 * Transaction de test tenant un verrou de ligne (SELECT … FOR UPDATE) sur sa propre connexion jusqu'à release() :
 * la requête HTTP qui a besoin de cette ligne attend, avec les verrous qu'elle a déjà pris.
 */
async function holdRowLock(table: 'Attachment' | 'Vehicle' | 'Driver', id: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, [id]);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    },
  };
}

/** Attend que `count` sessions de la base de test soient bloquées sur un verrou (entrelacement forcé, sans délai arbitraire). */
async function waitForLockWaiters(count: number, label: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS "n" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
      if (Number(rows[0]?.n ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`${label} : ${count} session(s) en attente de verrou attendue(s), ${rows[0]?.n ?? 0} observée(s).`);
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await client.end();
  }
}

/** Envoie la requête sans l'attendre (supertest ne l'émet qu'au premier then). */
function send(test: request.Test): Promise<request.Response> {
  return test.then((r) => r);
}

/**
 * D-016 : remise et restitution en READ COMMITTED sous verrous véhicule → conducteur → utilisation. Chaque test force
 * un entrelacement précis (une transaction de test tient un verrou, l'état d'attente des sessions est observé dans
 * pg_stat_activity) où une écriture concurrente décide pendant qu'une remise ou une restitution tient ses verrous,
 * ou l'inverse, et vérifie que l'invariant tient : exactement le résultat d'une exécution en série.
 */
describe('Remise et restitution en READ COMMITTED sous verrous : entrelacements forcés (D-016, CDC 13.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let vehicle2: string;
  let keySeq = 0;
  const key = () => `cle-isolation-${Date.now()}-${keySeq++}`;

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
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'VI-1' });
    vehicle2 = await createVehicle(t.prisma, f, 'A', { code: 'VI-2' });
    for (const v of [vehicleId, vehicle2]) {
      expect((await chefA.post(`/vehicles/${v}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' })).status).toBe(201);
    }
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
  });

  const checkoutBody = (vId: string, driverId: string, extra: Record<string, unknown> = {}) => ({
    vehicleId: vId,
    driverId,
    checkedOutAt: '2026-09-24T09:00:00Z',
    expectedReturnAt: '2026-09-24T18:00:00Z',
    purpose: 'Mission client',
    reading: { physicalKm: '10100' },
    location: { placeLabel: 'Dépôt central' },
    fuelGauge: 'TROIS_QUARTS',
    checklist: [{ label: 'Clés', present: true }],
    ...extra,
  });

  /**
   * Remise de (vehicleId, a1) arrêtée juste avant sa validation : elle a pris les verrous du véhicule et du conducteur
   * (nouvelle version des lignes), créé l'utilisation et son relevé, puis attend la photo verrouillée par le test.
   */
  async function checkoutHeldBeforeCommit(): Promise<{ checkout: Promise<request.Response>; release: () => Promise<void> }> {
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'photo-remise.pdf');
    const lock = await holdRowLock('Attachment', photo);
    const checkout = send(chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, { photoAttachmentIds: [photo] })).set('Idempotency-Key', key()));
    await waitForLockWaiters(1, 'remise en attente de la photo');
    return { checkout, release: lock.release };
  }

  it('archivage décidé pendant une remise non validée : repris après la remise, il voit l’utilisation ouverte et est refusé (422 OPERATIONS_OUVERTES, D-129)', async () => {
    const version = (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).version;
    const held = await checkoutHeldBeforeCommit();
    try {
      // Transaction sérialisable : instantané pris avant la validation de la remise, puis attente du verrou du véhicule.
      const archive = send(chefA.post(`/vehicles/${vehicleId}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de contrat', expectedVersion: version }));
      await waitForLockWaiters(2, 'archivage en attente du véhicule');
      await held.release();
      const [out, archived] = await Promise.all([held.checkout, archive]);
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(archived.status, JSON.stringify(archived.body)).toBe(422);
      expect(archived.body).toMatchObject({ code: 'OPERATIONS_OUVERTES', details: { usages: 1 } });
    } finally {
      await held.release();
    }
    const v = await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(v.lifecycleStatus).toBe('ACTIF');
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId, status: 'EN_COURS' } })).toBe(1);
  });

  it('désactivation du conducteur décidée pendant sa remise non validée : reprise, elle voit l’utilisation ouverte (409 UTILISATION_OUVERTE)', async () => {
    const version = (await t.prisma.client.driver.findUniqueOrThrow({ where: { id: f.drivers.a1 } })).version;
    const held = await checkoutHeldBeforeCommit();
    try {
      const deactivate = send(chefA.post(`/drivers/${f.drivers.a1}/deactivate`, { reason: 'départ de l’entreprise', expectedVersion: version, cancelFutureReservations: true }));
      await waitForLockWaiters(2, 'désactivation en attente du conducteur');
      await held.release();
      const [out, deactivated] = await Promise.all([held.checkout, deactivate]);
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(409);
      expect(deactivated.body.code).toBe('UTILISATION_OUVERTE');
    } finally {
      await held.release();
    }
    expect((await t.prisma.client.driver.findUniqueOrThrow({ where: { id: f.drivers.a1 } })).status).toBe('ACTIF');
    expect(await t.prisma.client.vehicleUsage.count({ where: { driverId: f.drivers.a1, status: 'EN_COURS' } })).toBe(1);
  });

  it('réservation d’un autre véhicule pour le même conducteur pendant sa remise non validée : refusée, aucun chevauchement avec l’occupation réelle (T05, D-140)', async () => {
    const held = await checkoutHeldBeforeCommit();
    try {
      const reservation = send(operateurA.post('/reservations', { vehicleId: vehicle2, driverId: f.drivers.a1, startAt: '2026-09-24T12:00:00Z', endAt: '2026-09-24T14:00:00Z', purpose: 'Deuxième mission' }));
      await waitForLockWaiters(2, 'réservation en attente du conducteur');
      await held.release();
      const [out, reserved] = await Promise.all([held.checkout, reservation]);
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(reserved.status, JSON.stringify(reserved.body)).toBeGreaterThanOrEqual(409);
      expect(reserved.status).toBeLessThan(500);
    } finally {
      await held.release();
    }
    expect(await t.prisma.client.reservation.count({ where: { driverId: f.drivers.a1 } })).toBe(0);
  });

  it('relevé libre saisi pendant la remise non validée : évalué après le relevé de départ, jamais accepté en baisse (relevé de départ cohérent, 5.2)', async () => {
    const held = await checkoutHeldBeforeCommit();
    try {
      const reading = send(operateurA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '10050', observedAt: '2026-09-24T09:30:00Z' }));
      await waitForLockWaiters(2, 'relevé en attente du véhicule');
      await held.release();
      const [out, saved] = await Promise.all([held.checkout, reading]);
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(saved.status).toBeLessThan(500);
    } finally {
      await held.release();
    }
    // Relevés acceptés du compteur : chronologie et valeurs croissantes (le relevé de 10 050 km après 10 100 km n'est pas accepté).
    const accepted = await t.prisma.client.odometerReading.findMany({ where: { vehicleId, status: 'ACCEPTE', isEstimate: false }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }], select: { physicalKm: true } });
    const values = accepted.map((r) => Number(r.physicalKm));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values).not.toContain(10050);
  });

  it('immobilisation validée pendant que la remise attend le verrou du véhicule : la remise relit l’état et est refusée (départ bloqué : VEHICULE_IMMOBILISE, T23)', async () => {
    const lock = await holdRowLock('Vehicle', vehicleId);
    let immobilization: Promise<request.Response> | null = null;
    let checkout: Promise<request.Response> | null = null;
    try {
      immobilization = send(chefA.post('/immobilizations', { vehicleId, reason: 'Freins à contrôler', locationLabel: 'Atelier' }));
      await waitForLockWaiters(1, 'immobilisation en attente du véhicule');
      checkout = send(operateurA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1)).set('Idempotency-Key', key()));
      await waitForLockWaiters(2, 'remise en attente du véhicule');
    } finally {
      await lock.release();
    }
    const [immobilized, out] = await Promise.all([immobilization, checkout]);
    expect(immobilized?.status, JSON.stringify(immobilized?.body)).toBe(201);
    expect(out?.status, JSON.stringify(out?.body)).toBe(422);
    expect(out?.body).toMatchObject({ code: 'DEPART_BLOQUE', details: { blockers: [{ code: 'VEHICULE_IMMOBILISE' }] } });
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId } })).toBe(0);
  });

  it('restitution validée pendant que la remise du même conducteur attend son verrou : la remise antérieure au retour est refusée (T05, aucune possession qui chevauche)', async () => {
    const first = await chefA.post('/usages/checkout', { ...checkoutBody(vehicleId, f.drivers.a1), checkedOutAt: '2026-09-24T08:00:00Z' }).set('Idempotency-Key', key());
    expect(first.status).toBe(201);
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'photo-retour.pdf');
    const lock = await holdRowLock('Attachment', photo);
    let back: Promise<request.Response> | null = null;
    let second: Promise<request.Response> | null = null;
    try {
      // Restitution à 09:45 arrêtée après ses verrous (véhicule, conducteur, utilisation) ; remise d'un autre véhicule
      // au même conducteur à 09:30, donc avant ce retour : elle attend le verrou du conducteur.
      back = send(chefA.post(`/usages/${first.body.id}/return`, { returnedAt: '2026-09-24T09:45:00Z', reading: { physicalKm: '10200' }, location: { placeLabel: 'Parking' }, photoAttachmentIds: [photo], expectedVersion: first.body.version }).set('Idempotency-Key', key()));
      await waitForLockWaiters(1, 'restitution en attente de la photo');
      second = send(operateurA.post('/usages/checkout', { ...checkoutBody(vehicle2, f.drivers.a1), checkedOutAt: '2026-09-24T09:30:00Z' }).set('Idempotency-Key', key()));
      await waitForLockWaiters(2, 'remise en attente du conducteur');
    } finally {
      await lock.release();
    }
    const [returned, out] = await Promise.all([back, second]);
    expect(returned?.status, JSON.stringify(returned?.body)).toBe(200);
    expect(out?.status, JSON.stringify(out?.body)).toBe(409);
    expect(out?.body.code).toBe('CONDUCTEUR_DEJA_EN_UTILISATION');
    expect(await t.prisma.client.vehicleUsage.count({ where: { vehicleId: vehicle2 } })).toBe(0);
  });

  it('même photo jointe à deux remises simultanées de couples distincts : rattachement conditionnel, une seule remise la reçoit, l’autre est annulée entière', async () => {
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'photo-commune.pdf');
    const lock = await holdRowLock('Attachment', photo);
    let a: Promise<request.Response> | null = null;
    let b: Promise<request.Response> | null = null;
    try {
      a = send(chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, { photoAttachmentIds: [photo] })).set('Idempotency-Key', key()));
      await waitForLockWaiters(1, 'première remise en attente de la photo');
      b = send(chefA.post('/usages/checkout', checkoutBody(vehicle2, f.drivers.a2, { photoAttachmentIds: [photo] })).set('Idempotency-Key', key()));
      await waitForLockWaiters(2, 'seconde remise en attente de la photo');
    } finally {
      await lock.release();
    }
    const results = await Promise.all([a, b]);
    const statuses = results.map((r) => r?.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r?.body))).toEqual([201, 422]);
    const winner = results.find((r) => r?.status === 201);
    const loser = results.find((r) => r?.status === 422);
    expect(loser?.body.code).toBe('PIECE_JOINTE_DEJA_RATTACHEE');
    const attachment = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: photo } });
    expect(attachment).toMatchObject({ ownerType: 'UTILISATION', ownerId: winner?.body.id });
    expect(await t.prisma.client.vehicleUsage.count()).toBe(1);
  });

  it('mémoïsation par requête HTTP : paramètres propres à chaque organisation et à chaque requête, relus après modification, jamais retenus hors requête', async () => {
    // Seconde organisation : même paramètre, valeur différente. Relevé de remise à 33 000 km, 23 jours après 10 000 km
    // (1 000 km par jour) : plausible au seuil par défaut (1 500 km), en attente au seuil de 100 km.
    const f2 = await seedFixture(t.prisma);
    const admin2 = await login(t.server, f2.emails.admin, DEFAULT_PASSWORD);
    const chef2 = await login(t.server, f2.emails.chefA, DEFAULT_PASSWORD);
    const v2 = await createVehicle(t.prisma, f2, 'A', { code: 'VO-2' });
    expect((await chef2.post(`/vehicles/${v2}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' })).status).toBe(201);
    await t.prisma.client.driverPermit.create({ data: { organizationId: f2.organizationId, driverId: f2.drivers.a1, number: 'P-ORG2', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const settings = t.app.get(SettingsService);
    const strict = await admin2.put('/settings/odometer.plausibilityMaxKmPerDay', { value: 100, reason: 'contrôle renforcé' });
    expect(strict.status, JSON.stringify(strict.body)).toBe(200);
    // Hors requête HTTP (worker, tâches) : lecture directe, la valeur modifiée est vue aussitôt.
    expect(await settings.get(f2.organizationId, 'odometer.plausibilityMaxKmPerDay', f2.companies.A)).toBe(100);
    expect(await settings.get(f.organizationId, 'odometer.plausibilityMaxKmPerDay', f.companies.A)).toBe(1500);

    const far = { reading: { physicalKm: '33000' } };
    const [out1, out2] = await Promise.all([
      chefA.post('/usages/checkout', checkoutBody(vehicleId, f.drivers.a1, far)).set('Idempotency-Key', key()),
      chef2.post('/usages/checkout', checkoutBody(v2, f2.drivers.a1, far)).set('Idempotency-Key', key()),
    ]);
    expect(out1.status, JSON.stringify(out1.body)).toBe(201);
    expect(out2.status, JSON.stringify(out2.body)).toBe(422);
    expect(out2.body.code).toBe('RELEVE_NON_ACCEPTE');

    // Requête suivante après retour au seuil par défaut : aucune valeur retenue d'une requête à l'autre.
    const relaxed = await admin2.put('/settings/odometer.plausibilityMaxKmPerDay', { value: 1500, reason: 'retour au seuil', expectedVersion: strict.body.version });
    expect(relaxed.status, JSON.stringify(relaxed.body)).toBe(200);
    expect(relaxed.body.value).toBe(1500);
    expect(await settings.get(f2.organizationId, 'odometer.plausibilityMaxKmPerDay', f2.companies.A)).toBe(1500);
    const again = await chef2.post('/usages/checkout', checkoutBody(v2, f2.drivers.a1, far)).set('Idempotency-Key', key());
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});
