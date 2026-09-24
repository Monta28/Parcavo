import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OdometerFreshnessService } from '../../src/modules/odometer/odometer-freshness.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

describe('Kilométrage manuel (CDC 5.1 à 5.5 — T09 à T14)', () => {
  let t: TestApp;
  let f: Fixture;
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
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
  });

  async function reading(agent: Agent, physicalKm: string, observedAt: string) {
    return agent.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
  }

  it('initialise le compteur au premier relevé du personnel et expose le compteur courant', async () => {
    const first = await reading(operateurA, '89500', '2026-09-20T08:00:00Z');
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe('ACCEPTE');
    expect(first.body.reading.cumulativeKm).toBe('89500.000');
    const current = await chefA.get(`/vehicles/${vehicleId}/odometer`);
    expect(current.body.reading.physicalKm).toBe('89500.000');
    expect(current.body.freshness).toBe('A_JOUR');
    expect(current.body.cumulativeKnown).toBe(true);
  });

  it('T09 — refuse 89 000 après 89 500 dans le même segment', async () => {
    await reading(chefA, '89500', '2026-09-20T08:00:00Z');
    const res = await reading(chefA, '89000', '2026-09-22T08:00:00Z');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DIMINUTION');
    expect(res.body.fieldErrors.physicalKm[0]).toMatch(/Diminution inexpliquée/);
    const current = await chefA.get(`/vehicles/${vehicleId}/odometer`);
    expect(current.body.reading.physicalKm).toBe('89500.000');
  });

  it('T10 — un relevé rétroactif entre deux voisins est contrôlé et ne fait pas reculer le compteur courant', async () => {
    await reading(chefA, '10000', '2026-09-01T08:00:00Z');
    await reading(chefA, '10500', '2026-09-15T08:00:00Z');
    const inserted = await reading(chefA, '10200', '2026-09-08T08:00:00Z');
    expect(inserted.body.outcome).toBe('ACCEPTE');
    const current = await chefA.get(`/vehicles/${vehicleId}/odometer`);
    expect(current.body.reading.physicalKm).toBe('10500.000');
    const broken = await reading(chefA, '10700', '2026-09-10T08:00:00Z');
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe('CHRONOLOGIE_SUIVANT');
  });

  it('T11 — la soumission d’un conducteur reste en attente et ne modifie pas le compteur officiel', async () => {
    await reading(chefA, '89500', '2026-09-20T08:00:00Z');
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-23T08:00:00Z'), expectedReturnAt: new Date('2026-09-25T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const submitted = await conducteur.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '90200', observedAt: '2026-09-24T09:00:00Z' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.outcome).toBe('EN_ATTENTE');
    const mine = await conducteur.get('/readings');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].status).toBe('EN_ATTENTE');
    const current = await chefA.get(`/vehicles/${vehicleId}/odometer`);
    expect(current.body.reading.physicalKm).toBe('89500.000');
    expect(current.body.pendingCount).toBe(1);
    const alert = await t.prisma.client.alert.findFirst({ where: { type: 'RELEVE_A_VALIDER', objectId: submitted.body.reading.id } });
    expect(alert?.status).toBe('ACTIVE');
    // l'opérateur ne peut pas valider ; le chef valide
    expect((await operateurA.post(`/readings/${submitted.body.reading.id}/approve`, { expectedVersion: 1 })).status).toBe(403);
    const approved = await chefA.post(`/readings/${submitted.body.reading.id}/approve`, { expectedVersion: 1 });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('ACCEPTE');
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('90200.000');
    const resolved = await t.prisma.client.alert.findFirst({ where: { type: 'RELEVE_A_VALIDER', objectId: submitted.body.reading.id } });
    expect(resolved?.status).toBe('RESOLUE');
    // le conducteur ne peut pas saisir sur un autre véhicule
    const other = await createVehicle(t.prisma, f, 'A');
    expect((await conducteur.post(`/vehicles/${other}/readings`, { physicalKm: '1000', observedAt: '2026-09-24T09:00:00Z' })).status).toBe(404);
  });

  it('met en attente une hausse implausible, même saisie par un opérateur, puis la valide explicitement', async () => {
    await reading(operateurA, '80000', '2026-09-23T08:00:00Z');
    const jump = await reading(operateurA, '90200', '2026-09-24T08:00:00Z');
    expect(jump.body.outcome).toBe('EN_ATTENTE');
    expect(jump.body.anomaly.code).toBe('HAUSSE_IMPLAUSIBLE');
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('80000.000');
    const approved = await chefA.post(`/readings/${jump.body.reading.id}/approve`, { expectedVersion: 1, reason: 'long trajet vérifié' });
    expect(approved.body.status).toBe('ACCEPTE');
  });

  it('traite deux valeurs identiques au même instant comme une seule opération et deux valeurs différentes comme un conflit', async () => {
    const a = await reading(chefA, '5000', '2026-09-20T08:00:00Z');
    const b = await reading(chefA, '5000', '2026-09-20T08:00:00Z');
    expect(b.body.outcome).toBe('IDEMPOTENT');
    expect(b.body.reading.id).toBe(a.body.reading.id);
    const c = await reading(chefA, '5010', '2026-09-20T08:00:00Z');
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('CONFLIT_MEME_INSTANT');
    // D-149 : même instant = même minute pour une saisie manuelle.
    const sameMinute = await reading(chefA, '5000', '2026-09-20T08:00:40Z');
    expect(sameMinute.body.outcome).toBe('IDEMPOTENT');
    expect(sameMinute.body.reading.id).toBe(a.body.reading.id);
    const conflictSameMinute = await reading(chefA, '5010', '2026-09-20T08:00:59Z');
    expect(conflictSameMinute.status).toBe(409);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(1);
  });

  it('un relevé identique à un relevé encore en attente renvoie ce relevé, sans doublon (D-149)', async () => {
    await reading(chefA, '5000', '2026-09-20T08:00:00Z');
    const pending = await reading(chefA, '50000', '2026-09-21T08:00:00Z');
    expect(pending.body.outcome).toBe('EN_ATTENTE');
    const again = await reading(chefA, '50000', '2026-09-21T08:00:30Z');
    expect(again.body.outcome).toBe('IDEMPOTENT');
    expect(again.body.reading.id).toBe(pending.body.reading.id);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, status: 'EN_ATTENTE' } })).toBe(1);
  });

  it('T12 — fraîcheur INCONNU sans relevé puis A_ACTUALISER au-delà de sept jours', async () => {
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.freshness).toBe('INCONNU');
    await reading(chefA, '15000', '2026-09-16T08:00:00Z');
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.freshness).toBe('A_ACTUALISER');
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.freshness).toBe('A_ACTUALISER');
  });

  it('T13 — correction motivée : original conservé, remplacement créé, audit et utilisations recalculées', async () => {
    const start = await reading(chefA, '40000', '2026-09-20T08:00:00Z');
    const end = await reading(chefA, '40300', '2026-09-21T08:00:00Z');
    const usage = await t.prisma.client.vehicleUsage.create({
      data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a2, purpose: 'mission', status: 'TERMINEE', checkedOutAt: new Date('2026-09-20T08:00:00Z'), expectedReturnAt: new Date('2026-09-21T18:00:00Z'), returnedAt: new Date('2026-09-21T08:00:00Z'), checkoutReadingId: start.body.reading.id, returnReadingId: end.body.reading.id, distanceStatus: 'VALIDEE', distanceKm: '300' },
    });
    const noKey = await chefA.post(`/readings/${end.body.reading.id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '40250' }, expectedVersion: 1 });
    expect(noKey.status).toBe(422);
    expect(noKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');
    const corrected = await chefA.post(`/readings/${end.body.reading.id}/correct`, { reason: 'erreur de saisie', replacementReading: { physicalKm: '40250' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-0001');
    expect(corrected.status).toBe(200);
    expect(corrected.body.physicalKm).toBe('40250.000');
    expect(corrected.body.replacesReadingId).toBe(end.body.reading.id);
    const original = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: end.body.reading.id } });
    expect(original.status).toBe('REMPLACE');
    expect(original.physicalKm?.toString()).toBe('40300');
    const u = await t.prisma.client.vehicleUsage.findUniqueOrThrow({ where: { id: usage.id } });
    expect(u.returnReadingId).toBe(corrected.body.id);
    expect(u.distanceKm?.toString()).toBe('250');
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'releve.correction' } });
    expect(audit?.reason).toBe('erreur de saisie');
    expect(JSON.stringify(audit?.before)).toContain('40300');
    expect(JSON.stringify(audit?.after)).toContain('40250');
    // une correction qui rompt la chronologie est bloquée
    const blocked = await chefA.post(`/readings/${start.body.reading.id}/correct`, { reason: 'test', replacementReading: { physicalKm: '40400' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-0002');
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('CORRECTION_BLOQUEE');
    // l'opérateur ne corrige pas
    expect((await operateurA.post(`/readings/${corrected.body.id}/correct`, { reason: 'correction opérateur', replacementReading: { physicalKm: '40260' }, expectedVersion: 1 }).set('Idempotency-Key', 'correction-0003')).status).toBe(403);
  });

  it('T14 — remplacement à 120 000 par un compteur à 0 puis lecture 500 : physique 500, cumul 120 500', async () => {
    const init = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-01-01T08:00:00Z', physicalKm: '100000' });
    expect(init.status).toBe(201);
    expect((await reading(chefA, '120000', '2026-09-20T08:00:00Z')).body.outcome).toBe('ACCEPTE');
    const noProof = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-21T08:00:00Z', physicalKm: '0', reason: 'remplacement du bloc compteur' });
    expect(noProof.body.code).toBe('JUSTIFICATIF_REQUIS');
    const proof = await uploadPdf(chefA, t.server, f.companies.A, 'facture-compteur.pdf');
    const replaced = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-21T08:00:00Z', physicalKm: '0', reason: 'remplacement du bloc compteur', justificationAttachmentId: proof });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'compteur.remplacement' } });
    expect(audit.before).toMatchObject({ endedAt: '2026-09-21T08:00:00.000Z', lastValidatedCumulativeKm: '120000' });
    expect(audit.after).toMatchObject({ newPhysicalKm: '0', justificationAttachmentId: proof });
    expect(replaced.body.startCumulativeKm).toBe('120000.000');
    expect(replaced.body.startPhysicalKm).toBe('0.000');
    const after = await reading(chefA, '500', '2026-09-22T08:00:00Z');
    expect(after.body.outcome).toBe('ACCEPTE');
    expect(after.body.reading.physicalKm).toBe('500.000');
    expect(after.body.reading.cumulativeKm).toBe('120500.000');
    const segments = await chefA.get(`/vehicles/${vehicleId}/odometer-segments`);
    expect(segments.body).toHaveLength(2);
    expect(segments.body[0].endedAt).toBe('2026-09-21T08:00:00.000Z');
    // un 0 sans remplacement déclaré est une diminution refusée (aucun remplacement implicite)
    expect((await reading(chefA, '100', '2026-09-23T08:00:00Z')).status).toBe(422);
    // l'opérateur n'enregistre pas un remplacement
    expect((await operateurA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-23T09:00:00Z', physicalKm: '0', reason: 'remplacement opérateur' })).status).toBe(403);
  });

  it('T12 — alertes de fraîcheur : kilométrage inconnu, puis ancien au-delà du seuil, résolues par un relevé ; aucune alerte hors service', async () => {
    const fresh = t.app.get(OdometerFreshnessService);
    await fresh.evaluateAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { type: 'KILOMETRAGE_ABSENT', objectId: vehicleId, status: 'ACTIVE' } })).toBe(1);
    await reading(chefA, '1000', '2026-09-10T08:00:00Z');
    expect(await t.prisma.client.alert.count({ where: { type: 'KILOMETRAGE_ABSENT', objectId: vehicleId, status: 'ACTIVE' } })).toBe(0);
    const stale = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'KILOMETRAGE_ANCIEN', objectId: vehicleId, status: 'ACTIVE' } });
    expect(stale.occurrenceKey).toBe('depuis:2026-09-10');
    await fresh.evaluateAll(f.organizationId);
    await fresh.evaluateAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { type: 'KILOMETRAGE_ANCIEN', objectId: vehicleId } })).toBe(1);
    await reading(chefA, '1200', '2026-09-23T08:00:00Z');
    expect(await t.prisma.client.alert.count({ where: { type: 'KILOMETRAGE_ANCIEN', objectId: vehicleId, status: 'ACTIVE' } })).toBe(0);
    // Véhicule hors service : aucune alerte (D-171).
    await t.prisma.client.vehicle.update({ where: { id: vehicleId }, data: { lifecycleStatus: 'HORS_SERVICE' } });
    t.clock.set('2026-10-20T10:00:00.000Z');
    await fresh.evaluateAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { objectId: vehicleId, status: 'ACTIVE', type: { in: ['KILOMETRAGE_ANCIEN', 'KILOMETRAGE_ABSENT'] } } })).toBe(0);
  });

  it('T01 — relevés et file de validation cloisonnés par société', async () => {
    await reading(chefA, '1000', '2026-09-20T08:00:00Z');
    const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    expect((await chefB.get(`/vehicles/${vehicleId}/readings`)).status).toBe(404);
    expect((await chefB.get(`/vehicles/${vehicleId}/odometer`)).status).toBe(404);
    expect((await chefB.get('/readings')).body.total).toBe(0);
    expect((await chefB.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '2000', observedAt: '2026-09-21T08:00:00Z' })).status).toBe(404);
  });
});
