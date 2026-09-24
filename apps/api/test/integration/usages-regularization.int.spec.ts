import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * Restitution sans relevé et régularisation de la distance (CDC 4.4, 15.3) : constat motivé du chef, alerte
 * « distance non validée », puis rattachement d'un relevé accepté (nouveau ou existant) par une opération
 * transactionnelle, idempotente, versionnée et auditée.
 */
describe('Retour sans relevé et régularisation de la distance (CDC 4.4 ; R-4.4-05, R-4.4-06, R-15.3-02)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let keySeq = 0;
  const key = () => `cle-regul-${Date.now()}-${keySeq++}`;

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
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
  });

  const checkout = async (driverId = f.drivers.a1, extra: Record<string, unknown> = {}) => {
    const res = await operateurA
      .post('/usages/checkout', { vehicleId, driverId, checkedOutAt: '2026-09-24T07:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission client', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt central' }, ...extra })
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  };
  /** Retour constaté sans relevé par le chef (exception motivée), avec checklist, carburant et observations. */
  const returnWithoutReading = async (usage: { id: string; version: number }, returnedAt = '2026-09-24T09:00:00Z') => {
    const res = await chefA
      .post(`/usages/${usage.id}/return`, {
        returnedAt,
        readingException: { reason: 'Écran du compteur illisible au retour' },
        location: { placeLabel: 'Parking siège' },
        fuelGauge: 'DEMI',
        checklist: [
          { label: 'Clés', present: true },
          { label: 'Carte grise', present: false, comment: 'restée au bureau' },
        ],
        notes: 'Rayure légère portière arrière',
        confirmedByName: 'Karim Conducteur',
        expectedVersion: usage.version,
      })
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; version: number; distanceStatus: string; returnReadingRegularizable: boolean };
  };

  it('R-4.4-05 / R-15.3-02 — constat de retour sans relevé : réservé au chef, motif ≥ 5 caractères, checklist et observations conservées, distance non validée avec alerte', async () => {
    const usage = await checkout();
    const base = { returnedAt: '2026-09-24T09:00:00Z', location: { placeLabel: 'Parking siège' }, expectedVersion: usage.version };
    const missing = await operateurA.post(`/usages/${usage.id}/return`, base).set('Idempotency-Key', key());
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('RELEVE_REQUIS');
    const byOperator = await operateurA.post(`/usages/${usage.id}/return`, { ...base, readingException: { reason: 'compteur illisible' } }).set('Idempotency-Key', key());
    expect(byOperator.status).toBe(403);
    const shortReason = await chefA.post(`/usages/${usage.id}/return`, { ...base, readingException: { reason: 'hs' } }).set('Idempotency-Key', key());
    expect(shortReason.status).toBe(422);
    const both = await chefA.post(`/usages/${usage.id}/return`, { ...base, reading: { physicalKm: '10200' }, readingException: { reason: 'compteur illisible' } }).set('Idempotency-Key', key());
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('RELEVE_OU_EXCEPTION');
    expect((await t.prisma.client.vehicleUsage.findUniqueOrThrow({ where: { id: usage.id } })).status).toBe('EN_COURS');

    const back = await returnWithoutReading(usage);
    const view = (await chefA.get(`/usages/${back.id}`)).body;
    expect(view).toMatchObject({
      status: 'TERMINEE',
      returnWithoutReading: true,
      returnExceptionReason: 'Écran du compteur illisible au retour',
      returnReading: null,
      distanceStatus: 'NON_VALIDEE',
      distanceKm: null,
      returnFuelGauge: 'DEMI',
      returnNotes: 'Rayure légère portière arrière',
      returnConfirmedBy: 'Karim Conducteur',
      returnLocation: 'Parking siège',
      returnReadingRegularizable: true,
    });
    expect(view.returnChecklist).toEqual([
      { label: 'Clés', present: true },
      { label: 'Carte grise', present: false, comment: 'restée au bureau' },
    ]);
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DISTANCE_NON_VALIDEE', objectId: usage.id } });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.message).toContain('Retour constaté sans relevé');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'utilisation.restitution', objectId: usage.id } });
    expect(audit.reason).toBe('Écran du compteur illisible au retour');
  });

  it('R-4.4-06 — régularisation par un nouveau relevé : distance validée, alerte résolue, audit ; idempotente et versionnée', async () => {
    const usage = await checkout();
    const back = await returnWithoutReading(usage);
    const url = `/usages/${usage.id}/return-reading`;
    const body = { reading: { physicalKm: '10350' }, reason: 'Photo du compteur retrouvée', expectedVersion: back.version };
    // Droits, clé d'idempotence et exclusivité des modes.
    expect((await operateurA.post(url, body).set('Idempotency-Key', key())).status).toBe(403);
    const noKey = await chefA.post(url, body);
    expect(noKey.status).toBe(422);
    expect(noKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');
    const both = await chefA.post(url, { ...body, readingId: usage.id }).set('Idempotency-Key', key());
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('RELEVE_OU_EXISTANT');
    // Valeur inférieure au départ : diminution refusée par le contrôle unique, rien n'est enregistré.
    const lower = await chefA.post(url, { ...body, reading: { physicalKm: '10050' } }).set('Idempotency-Key', key());
    expect(lower.status).toBe(422);
    expect(lower.body.code).toBe('DIMINUTION');
    // Hausse implausible (anomalie à valider) : refusée, aucun relevé en attente créé.
    const implausible = await chefA.post(url, { ...body, reading: { physicalKm: '19000' } }).set('Idempotency-Key', key());
    expect(implausible.status).toBe(422);
    expect(implausible.body.code).toBe('RELEVE_NON_ACCEPTE');
    // Instant hors de la période [retour, remise suivante] : refusé.
    const before = await chefA.post(url, { ...body, reading: { physicalKm: '10350', observedAt: '2026-09-24T08:00:00Z' } }).set('Idempotency-Key', key());
    expect(before.status).toBe(422);
    expect(before.body.code).toBe('RELEVE_HORS_PERIODE');
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(2);
    // Version périmée : 409.
    const stale = await chefA.post(url, { ...body, expectedVersion: usage.version }).set('Idempotency-Key', key());
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');

    const k = key();
    const ok = await chefA.post(url, body).set('Idempotency-Key', k);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ distanceStatus: 'VALIDEE', distanceKm: '250.000', returnWithoutReading: true, returnReadingRegularizable: false, version: back.version + 1 });
    expect(ok.body.returnReading).toMatchObject({ physicalKm: '10350.000', status: 'ACCEPTE', observedAt: '2026-09-24T09:00:00.000Z' });
    const reading = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: ok.body.returnReading.id } });
    expect(reading).toMatchObject({ context: 'RESTITUTION', source: 'MANUAL', createdById: f.users.chefA });
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DISTANCE_NON_VALIDEE', objectId: usage.id } });
    expect(alert.status).toBe('RESOLUE');
    expect(alert.resolutionReason).toBe('relevé de retour régularisé');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'utilisation.regularisation_releve_retour', objectId: usage.id } });
    expect(audit.reason).toBe('Photo du compteur retrouvée');
    expect(audit.before).toMatchObject({ returnReadingId: null, distanceStatus: 'NON_VALIDEE', returnWithoutReading: true });
    expect(audit.after).toMatchObject({ returnReadingId: reading.id, mode: 'NOUVEAU_RELEVE', physicalKm: '10350', distanceStatus: 'VALIDEE', distanceKm: '250' });
    // Même clé, même corps : réponse initiale rejouée, aucun second relevé ; corps différent : 409.
    const replay = await chefA.post(url, body).set('Idempotency-Key', k);
    expect(replay.status).toBe(200);
    expect(replay.body.returnReading.id).toBe(reading.id);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(3);
    const different = await chefA.post(url, { ...body, reading: { physicalKm: '10360' } }).set('Idempotency-Key', k);
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    // Déjà validée : une nouvelle régularisation est un conflit d'état.
    const again = await chefA.post(url, { ...body, expectedVersion: ok.body.version }).set('Idempotency-Key', key());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ETAT_INVALIDE');
    // Le compteur courant reflète le relevé régularisé (dernier accepté selon l'observation).
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('10350.000');
  });

  it('R-4.4-06 — régularisation par un relevé accepté existant, observé avant la remise suivante et non rattaché à une autre utilisation', async () => {
    const usage = await checkout();
    const back = await returnWithoutReading(usage);
    // Relevé libre saisi au parking après le retour (le véhicule n'a pas roulé).
    const free = await operateurA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '10340', observedAt: '2026-09-24T09:30:00Z', note: 'relevé au parking' });
    expect(free.body.outcome).toBe('ACCEPTE');
    // Remise suivante à 09:45 : un relevé observé après elle n'est plus admis.
    const next = await operateurA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a2, checkedOutAt: '2026-09-24T09:45:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Livraison', reading: { physicalKm: '10345' }, location: { placeLabel: 'Parking siège' } })
      .set('Idempotency-Key', key());
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const url = `/usages/${usage.id}/return-reading`;
    // Candidats proposés par l'écran : relevés acceptés observés depuis le retour (filtre observedFrom du serveur).
    const candidates = await chefA.get(`/vehicles/${vehicleId}/readings?status=ACCEPTE&observedFrom=2026-09-24T09:00:00.000Z&order=asc`);
    expect(candidates.body.items.map((r: { id: string }) => r.id)).toEqual([free.body.reading.id, next.body.checkoutReading.id]);
    // Relevé déjà rattaché à la remise suivante : 409.
    const linked = await chefA.post(url, { readingId: next.body.checkoutReading.id, reason: 'Relevé de la remise suivante', expectedVersion: back.version }).set('Idempotency-Key', key());
    expect(linked.status).toBe(409);
    expect(linked.body.code).toBe('RELEVE_DEJA_UTILISE');
    // Relevé d'un autre véhicule ou inexistant : 404.
    expect((await chefA.post(url, { readingId: '00000000-0000-4000-8000-000000000000', reason: 'Relevé inconnu', expectedVersion: back.version }).set('Idempotency-Key', key())).status).toBe(404);
    const ok = await chefA.post(url, { readingId: free.body.reading.id, reason: 'Relevé du parking après le retour', expectedVersion: back.version }).set('Idempotency-Key', key());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ distanceStatus: 'VALIDEE', distanceKm: '240.000' });
    expect(ok.body.returnReading.id).toBe(free.body.reading.id);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'utilisation.regularisation_releve_retour', objectId: usage.id } });
    expect(audit.after).toMatchObject({ mode: 'RELEVE_EXISTANT', returnReadingId: free.body.reading.id });
  });

  it('R-4.4-06 — relevé de retour contesté : en attente → régularisation refusée (409) ; validé → alerte résolue ; rejeté → régularisation possible', async () => {
    const first = await checkout();
    const contested = await operateurA.post(`/usages/${first.id}/return`, { returnedAt: '2026-09-24T07:50:00Z', reading: { physicalKm: '11000' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: first.version }).set('Idempotency-Key', key());
    expect(contested.body.returnReading.status).toBe('EN_ATTENTE');
    expect(contested.body.returnReadingRegularizable).toBe(false);
    const pending = await chefA.post(`/usages/${first.id}/return-reading`, { reading: { physicalKm: '10150' }, reason: 'Valeur corrigée', expectedVersion: contested.body.version }).set('Idempotency-Key', key());
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('RELEVE_EN_ATTENTE');
    // Rejet du relevé contesté : la distance reste non validée, la régularisation devient possible.
    const rejected = await chefA.post(`/readings/${contested.body.returnReading.id}/reject`, { expectedVersion: 1, reason: 'Valeur incohérente avec la mission' });
    expect(rejected.status).toBe(200);
    const afterReject = (await chefA.get(`/usages/${first.id}`)).body;
    expect(afterReject).toMatchObject({ distanceStatus: 'NON_VALIDEE', returnReadingRegularizable: true });
    const ok = await chefA.post(`/usages/${first.id}/return-reading`, { reading: { physicalKm: '10180' }, reason: 'Relevé confirmé par le conducteur', expectedVersion: afterReject.version }).set('Idempotency-Key', key());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ distanceStatus: 'VALIDEE', distanceKm: '80.000' });
    expect(ok.body.returnReading.id).not.toBe(contested.body.returnReading.id);
    // Le relevé rejeté reste dans l'historique ; l'audit garde le lien remplacé.
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: contested.body.returnReading.id } })).status).toBe('REJETE');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'utilisation.regularisation_releve_retour', objectId: first.id } });
    expect(audit.before).toMatchObject({ returnReadingId: contested.body.returnReading.id, returnReadingStatus: 'REJETE' });

    // Validation d'un relevé de retour en attente : la distance devient validée et l'alerte est résolue.
    t.clock.set('2026-09-24T11:00:00Z');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    const second = await operateurA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a2, checkedOutAt: '2026-09-24T10:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Livraison', reading: { physicalKm: '10200' }, location: { placeLabel: 'Dépôt central' } })
      .set('Idempotency-Key', key());
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const back2 = await operateurA.post(`/usages/${second.body.id}/return`, { returnedAt: '2026-09-24T10:30:00Z', reading: { physicalKm: '11100' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: second.body.version }).set('Idempotency-Key', key());
    expect(back2.body.distanceStatus).toBe('NON_VALIDEE');
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DISTANCE_NON_VALIDEE', objectId: second.body.id } })).status).toBe('ACTIVE');
    const approved = await chefA.post(`/readings/${back2.body.returnReading.id}/approve`, { expectedVersion: 1, reason: 'Trajet long confirmé' });
    expect(approved.status).toBe(200);
    expect((await chefA.get(`/usages/${second.body.id}`)).body).toMatchObject({ distanceStatus: 'VALIDEE', distanceKm: '900.000' });
    const resolved = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DISTANCE_NON_VALIDEE', objectId: second.body.id } });
    expect(resolved.status).toBe('RESOLUE');
  });

  it('régularisation impossible avant la restitution (409) ou après un départ sans relevé (422 : distance indéterminée)', async () => {
    const open = await checkout();
    const early = await chefA.post(`/usages/${open.id}/return-reading`, { reading: { physicalKm: '10200' }, reason: 'Trop tôt pour régulariser', expectedVersion: open.version }).set('Idempotency-Key', key());
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('ETAT_INVALIDE');
    await chefA.post(`/usages/${open.id}/return`, { returnedAt: '2026-09-24T08:00:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt central' }, expectedVersion: open.version }).set('Idempotency-Key', key());
    const noReading = await chefA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a2, checkedOutAt: '2026-09-24T08:30:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Urgence', readingException: { reason: 'Compteur illisible au départ' }, location: { placeLabel: 'Dépôt central' } })
      .set('Idempotency-Key', key());
    expect(noReading.status).toBe(201);
    const back = await returnWithoutReading(noReading.body, '2026-09-24T09:30:00Z');
    expect(back.distanceStatus).toBe('INDETERMINEE');
    expect(back.returnReadingRegularizable).toBe(false);
    const refused = await chefA.post(`/usages/${noReading.body.id}/return-reading`, { reading: { physicalKm: '10300' }, reason: 'Compteur relu au retour', expectedVersion: back.version }).set('Idempotency-Key', key());
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DEPART_SANS_RELEVE');
  });

  it('régularisations concurrentes (clés différentes, même version) : une seule réussit, l’autre 409, un seul relevé rattaché', async () => {
    const usage = await checkout();
    const back = await returnWithoutReading(usage);
    const results = await Promise.all([
      chefA.post(`/usages/${usage.id}/return-reading`, { reading: { physicalKm: '10350' }, reason: 'Régularisation A', expectedVersion: back.version }).set('Idempotency-Key', key()),
      chefA.post(`/usages/${usage.id}/return-reading`, { reading: { physicalKm: '10350', observedAt: '2026-09-24T09:05:00Z' }, reason: 'Régularisation B', expectedVersion: back.version }).set('Idempotency-Key', key()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'utilisation.regularisation_releve_retour', objectId: usage.id } })).toBe(1);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, context: 'RESTITUTION' } })).toBe(1);
  });
});
