import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertsService } from '../../src/modules/alerts/alerts.service.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

interface PlanningBody {
  items: Array<{ kind: string; id: string; companyId: string; vehicleId: string; startAt: string; endAt: string | null; status: string; isLate: boolean; label: string }>;
  warnings: Array<{ code: string; interventionId: string; reservationId: string; vehicleId: string; companyId: string; message: string }>;
}

describe('Réservations et planning (CDC 4.2, 4.5, 10.2 — D-137, D-140, D-141, D-205)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let vA1: string;
  let vA2: string;
  let vB1: string;
  let keySeq = 0;
  const key = () => `cle-resa-${Date.now()}-${keySeq++}`;

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
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    vA1 = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    vA2 = await createVehicle(t.prisma, f, 'A', { code: 'VA-2' });
    vB1 = await createVehicle(t.prisma, f, 'B', { code: 'VB-1' });
    await chefA.post(`/vehicles/${vA1}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.createMany({
      data: [f.drivers.a1, f.drivers.a2, f.drivers.b1].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })),
    });
  });

  const body = (over: Record<string, unknown> = {}) => ({ vehicleId: vA1, driverId: f.drivers.a1, startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z', purpose: 'Mission', ...over });

  const raiseCompromise = (reservationId: string, vehicleId: string) =>
    t.app.get(AlertsService).raise({
      organizationId: f.organizationId,
      companyId: f.companies.A,
      type: 'RESERVATION_COMPROMISE',
      severity: 'URGENT',
      objectType: 'Reservation',
      objectId: reservationId,
      vehicleId,
      occurrenceKey: 'retard-test',
      title: 'Réservation compromise',
      message: 'Le véhicule n’est pas encore restitué.',
      condition: { reservationId },
      actionPath: `/planning?reservation=${reservationId}`,
    });

  it('création (D-137) : début au plus 15 min dans le passé, fin après le début, bornes tronquées à la minute, société déduite du véhicule', async () => {
    const tooOld = await chefA.post('/reservations', body({ startAt: '2026-09-24T09:44:00Z', endAt: '2026-09-24T12:00:00Z' }));
    expect(tooOld.status).toBe(422);
    expect(tooOld.body.code).toBe('DEBUT_TROP_ANCIEN');
    expect(tooOld.body.fieldErrors.startAt).toHaveLength(1);
    // Même minute une fois tronquées : fin = début, refusée.
    const sameMinute = await chefA.post('/reservations', body({ startAt: '2026-10-01T08:00:10Z', endAt: '2026-10-01T08:00:50Z' }));
    expect(sameMinute.status).toBe(422);
    expect(sameMinute.body.code).toBe('INTERVALLE_INVALIDE');
    const recent = await chefA.post('/reservations', body({ startAt: '2026-09-24T09:50:31.456Z', endAt: '2026-09-24T12:30:59.999Z' }));
    expect(recent.status).toBe(201);
    expect(recent.body).toMatchObject({ startAt: '2026-09-24T09:50:00.000Z', endAt: '2026-09-24T12:30:00.000Z', companyId: f.companies.A, status: 'CONFIRMEE', editScope: 'FIN_SEULEMENT', noShowAllowedFrom: '2026-09-24T10:50:00.000Z' });
    const stored = await t.prisma.client.reservation.findUniqueOrThrow({ where: { id: recent.body.id } });
    expect(stored.startAt.toISOString()).toBe('2026-09-24T09:50:00.000Z');
    // Aucun companyId fourni par le client : champ refusé ; la société vient du véhicule.
    const forged = await admin.post('/reservations', { ...body({ vehicleId: vB1, driverId: f.drivers.b1 }), companyId: f.companies.A });
    expect(forged.status).toBe(422);
    const inB = await admin.post('/reservations', body({ vehicleId: vB1, driverId: f.drivers.b1 }));
    expect(inB.status).toBe(201);
    expect(inB.body.companyId).toBe(f.companies.B);
    expect(inB.body.editScope).toBe('COMPLETE');
  });

  it('modification avant le début (D-137) : véhicule et conducteur changés avec les contrôles de la création, motif et audit, société du véhicule', async () => {
    const r = await chefA.post('/reservations', body());
    expect(r.status).toBe(201);
    const noReason = await chefA.patch(`/reservations/${r.body.id}`, { vehicleId: vA2, expectedVersion: 1 });
    expect(noReason.status).toBe(422);
    const moved = await chefA.patch(`/reservations/${r.body.id}`, { vehicleId: vA2, driverId: f.drivers.a2, startAt: '2026-10-01T09:00:30Z', reason: 'véhicule plus adapté', expectedVersion: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ vehicleId: vA2, driverId: f.drivers.a2, startAt: '2026-10-01T09:00:00.000Z', endAt: '2026-10-01T12:00:00.000Z', companyId: f.companies.A, version: 2 });
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'reservation.modification', objectId: r.body.id } });
    expect(audit?.reason).toBe('véhicule plus adapté');
    expect(audit?.actorUserId).toBe(f.users.chefA);
    expect(audit?.before).toMatchObject({ vehicleId: vA1, driverId: f.drivers.a1 });
    expect(audit?.after).toMatchObject({ vehicleId: vA2, driverId: f.drivers.a2 });
    // Le créneau libéré sur VA-1 redevient réservable.
    expect((await chefA.post('/reservations', body())).status).toBe(201);
    // Véhicule hors périmètre du chef A : introuvable.
    const outOfScope = await chefA.patch(`/reservations/${r.body.id}`, { vehicleId: vB1, reason: 'essai', expectedVersion: 2 });
    expect(outOfScope.status).toBe(404);
    // Conducteur d'une autre société que le véhicule : refus identique à la création.
    const otherCompanyDriver = await admin.patch(`/reservations/${r.body.id}`, { driverId: f.drivers.b1, reason: 'essai', expectedVersion: 2 });
    expect(otherCompanyDriver.status).toBe(422);
    expect(otherCompanyDriver.body.code).toBe('RESERVATION_BLOQUEE');
    // L'administrateur déplace la mission sur un véhicule de B : la société suit le véhicule.
    const toB = await admin.patch(`/reservations/${r.body.id}`, { vehicleId: vB1, driverId: f.drivers.b1, reason: 'mission reprise par la société B', expectedVersion: 2 });
    expect(toB.status).toBe(200);
    expect(toB.body.companyId).toBe(f.companies.B);
    expect((await chefA.get(`/reservations/${r.body.id}`)).status).toBe(404);
    expect((await chefB.get(`/reservations/${r.body.id}`)).status).toBe(200);
  });

  it('modification : dérogation motivée transmise aux contrôles (exceptions.override), chevauchement et version contrôlés', async () => {
    const a3 = await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, code: 'D-A3', firstName: 'Sans', lastName: 'Permis' } });
    const r = await chefA.post('/reservations', body());
    const blocked = await chefA.patch(`/reservations/${r.body.id}`, { driverId: a3.id, reason: 'remplacement', expectedVersion: 1 });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('RESERVATION_BLOQUEE');
    expect(blocked.body.details.overridable).toBe(true);
    const byOperator = await operateurA.patch(`/reservations/${r.body.id}`, { driverId: a3.id, reason: 'remplacement', overrideReason: 'permis en cours de renouvellement', expectedVersion: 1 });
    expect(byOperator.status).toBe(403);
    const byChef = await chefA.patch(`/reservations/${r.body.id}`, { driverId: a3.id, reason: 'remplacement', overrideReason: 'permis en cours de renouvellement', expectedVersion: 1 });
    expect(byChef.status).toBe(200);
    expect(byChef.body.driverId).toBe(a3.id);
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'reservation.modification', objectId: r.body.id } });
    expect(audit?.after).toMatchObject({ driverId: a3.id, overrideReason: 'permis en cours de renouvellement' });
    await chefA.post('/reservations', body({ driverId: f.drivers.a2, startAt: '2026-10-01T14:00:00Z', endAt: '2026-10-01T16:00:00Z' }));
    const overlap = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T15:00:00Z', reason: 'mission prolongée', overrideReason: 'permis en cours de renouvellement', expectedVersion: 2 });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('RESERVATION_CHEVAUCHEMENT');
    const stale = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T13:00:00Z', reason: 'mission prolongée', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');
    // Raccourcir ne crée aucun conflit : pas de nouveau contrôle documentaire.
    const shortened = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T11:00:00Z', reason: 'mission écourtée', expectedVersion: 2 });
    expect(shortened.status).toBe(200);
    const unchanged = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T11:00:00Z', reason: 'rien', expectedVersion: 3 });
    expect(unchanged.status).toBe(422);
    expect(unchanged.body.code).toBe('AUCUNE_MODIFICATION');
    const cancelled = await chefA.post(`/reservations/${r.body.id}/cancel`, { reason: 'mission annulée', expectedVersion: 3 });
    expect(cancelled.status).toBe(200);
    const afterCancel = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T10:00:00Z', reason: 'essai', expectedVersion: 4 });
    expect(afterCancel.status).toBe(409);
    expect(afterCancel.body.code).toBe('ETAT_INVALIDE');
  });

  it('saisie (4.2, 15.1) : null refusé sur un champ non effaçable, motif ou dérogation blancs refusés (422, jamais 500), textes facultatifs blancs retirés', async () => {
    const r = await chefA.post('/reservations', body({ destination: '   ', comment: '  Clés au dépôt  ' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ destination: null, comment: 'Clés au dépôt' });
    const blankPurpose = await chefA.post('/reservations', body({ purpose: '    ', startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-05T09:00:00Z' }));
    expect(blankPurpose.status).toBe(422);
    expect(blankPurpose.body.fieldErrors.purpose).toHaveLength(1);
    // Absent = inchangé ; null n'efface pas un champ obligatoire : refus explicite (et non une erreur interne).
    for (const field of ['purpose', 'vehicleId', 'driverId', 'startAt', 'endAt', 'overrideReason']) {
      const res = await chefA.patch(`/reservations/${r.body.id}`, { [field]: null, reason: 'essai', expectedVersion: 1 });
      expect(res.status, field).toBe(422);
      expect(res.body.code, field).toBe('VALIDATION');
      expect(res.body.fieldErrors[field]?.length, field).toBeGreaterThan(0);
    }
    const blankPatch = await chefA.patch(`/reservations/${r.body.id}`, { purpose: '   ', reason: 'essai', expectedVersion: 1 });
    expect(blankPatch.status).toBe(422);
    expect(blankPatch.body.fieldErrors.purpose).toHaveLength(1);
    // Texte blanc sur un champ effaçable : retiré (null) ; déjà absent, ce n'est pas une modification.
    expect((await chefA.patch(`/reservations/${r.body.id}`, { destination: '  ', reason: 'essai', expectedVersion: 1 })).body.code).toBe('AUCUNE_MODIFICATION');
    const cleared = await chefA.patch(`/reservations/${r.body.id}`, { comment: ' ', reason: 'commentaire retiré', expectedVersion: 1 });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ comment: null, version: 2 });
    // Une dérogation blanche n'est pas une dérogation motivée, à la modification comme à la création.
    const a3 = await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, code: 'D-A3', firstName: 'Sans', lastName: 'Permis' } });
    const blankOverride = await chefA.patch(`/reservations/${r.body.id}`, { driverId: a3.id, reason: 'remplacement', overrideReason: '        ', expectedVersion: 2 });
    expect(blankOverride.status).toBe(422);
    expect(blankOverride.body.fieldErrors.overrideReason).toHaveLength(1);
    const blankOverrideCreate = await chefA.post('/reservations', body({ driverId: a3.id, startAt: '2026-10-03T08:00:00Z', endAt: '2026-10-03T09:00:00Z', overrideReason: '        ' }));
    expect(blankOverrideCreate.status).toBe(422);
    expect(blankOverrideCreate.body.fieldErrors.overrideReason).toHaveLength(1);
    expect((await chefA.get(`/reservations/${r.body.id}`)).body).toMatchObject({ driverId: f.drivers.a1, purpose: 'Mission', version: 2 });
    expect(await t.prisma.client.reservation.count()).toBe(1);
  });

  it('modification après le début prévu (D-137) : seule la fin reste modifiable (422 sinon)', async () => {
    const r = await chefA.post('/reservations', body({ startAt: '2026-09-24T11:00:00Z', endAt: '2026-09-24T15:00:00Z' }));
    expect(r.status).toBe(201);
    t.clock.set('2026-09-24T11:30:00Z');
    expect((await chefA.get(`/reservations/${r.body.id}`)).body.editScope).toBe('FIN_SEULEMENT');
    for (const change of [{ startAt: '2026-09-24T12:00:00Z' }, { vehicleId: vA2 }, { driverId: f.drivers.a2 }, { purpose: 'Autre motif' }, { comment: 'nouveau commentaire' }]) {
      const res = await chefA.patch(`/reservations/${r.body.id}`, { ...change, reason: 'essai', expectedVersion: 1 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('RESERVATION_COMMENCEE');
    }
    // Même valeur renvoyée : ce n'est pas une modification du début.
    const extended = await chefA.patch(`/reservations/${r.body.id}`, { startAt: '2026-09-24T11:00:00Z', endAt: '2026-09-24T17:00:00Z', reason: 'mission prolongée', expectedVersion: 1 });
    expect(extended.status).toBe(200);
    expect(extended.body.endAt).toBe('2026-09-24T17:00:00.000Z');
    const past = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-09-24T11:15:00Z', reason: 'fin passée', expectedVersion: 2 });
    expect(past.status).toBe(422);
    expect(past.body.code).toBe('INTERVALLE_PASSE');
  });

  it('occupation réelle (D-140) : création ou modification qui chevauche une utilisation en cours → 409 RESERVATION_CONFLIT', async () => {
    const out = await chefA
      .post('/usages/checkout', {
        vehicleId: vA1,
        driverId: f.drivers.a1,
        checkedOutAt: '2026-09-24T09:00:00Z',
        expectedReturnAt: '2026-09-24T14:00:00Z',
        purpose: 'Mission client',
        reading: { physicalKm: '10100' },
        location: { placeLabel: 'Dépôt central' },
        fuelGauge: 'TROIS_QUARTS',
        checklist: [{ label: 'Clés', present: true }],
      })
      .set('Idempotency-Key', key());
    expect(out.status).toBe(201);
    const clash = await chefA.post('/reservations', body({ driverId: f.drivers.a2, startAt: '2026-09-24T13:00:00Z', endAt: '2026-09-24T15:00:00Z' }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('RESERVATION_CONFLIT');
    expect(clash.body.details.usageId).toBe(out.body.id);
    const driverBusy = await chefA.post('/reservations', body({ vehicleId: vA2, startAt: '2026-09-24T13:00:00Z', endAt: '2026-09-24T15:00:00Z' }));
    expect(driverBusy.status).toBe(409);
    expect(driverBusy.body.code).toBe('RESERVATION_CONFLIT');
    // Après le retour prévu : accepté ; avancée sur le créneau occupé : refusée.
    const later = await chefA.post('/reservations', body({ driverId: f.drivers.a2, startAt: '2026-09-24T14:00:00Z', endAt: '2026-09-24T16:00:00Z' }));
    expect(later.status).toBe(201);
    const advanced = await chefA.patch(`/reservations/${later.body.id}`, { startAt: '2026-09-24T13:30:00Z', reason: 'départ avancé', expectedVersion: 1 });
    expect(advanced.status).toBe(409);
    expect(advanced.body.code).toBe('RESERVATION_CONFLIT');
  });

  it('immobilisation active (D-141) : refus seulement si elle chevauche le créneau ; sans fin prévue, tout créneau est refusé', async () => {
    const immo = await t.prisma.client.immobilization.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: vA1, status: 'ACTIVE', startedAt: new Date('2026-09-24T08:00:00Z'), expectedEndAt: new Date('2026-09-26T08:00:00Z') } });
    const during = await chefA.post('/reservations', body({ startAt: '2026-09-25T08:00:00Z', endAt: '2026-09-25T12:00:00Z' }));
    expect(during.status).toBe(409);
    expect(during.body.code).toBe('VEHICULE_IMMOBILISE');
    const after = await chefA.post('/reservations', body({ startAt: '2026-09-26T08:00:00Z', endAt: '2026-09-26T12:00:00Z' }));
    expect(after.status).toBe(201);
    await t.prisma.client.immobilization.update({ where: { id: immo.id }, data: { expectedEndAt: null } });
    const open = await chefA.post('/reservations', body({ startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-05T12:00:00Z' }));
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('VEHICULE_IMMOBILISE');
  });

  it('non-présentation (D-137) : à partir du début + reservations.noShowGraceMinutes, motif, auteur, audit et alerte résolue', async () => {
    const r = await chefA.post('/reservations', body({ startAt: '2026-09-24T10:30:00Z', endAt: '2026-09-24T15:00:00Z' }));
    expect(r.status).toBe(201);
    expect(r.body.noShowAllowedFrom).toBe('2026-09-24T11:30:00.000Z');
    await raiseCompromise(r.body.id, vA1);
    t.clock.set('2026-09-24T11:00:00Z');
    const early = await chefA.post(`/reservations/${r.body.id}/no-show`, { reason: 'conducteur absent', expectedVersion: 1 });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('TROP_TOT');
    expect(early.body.details).toMatchObject({ allowedFrom: '2026-09-24T11:30:00.000Z', graceMinutes: 60 });
    t.clock.set('2026-09-24T11:30:00Z');
    expect((await lecteurA.post(`/reservations/${r.body.id}/no-show`, { reason: 'conducteur absent', expectedVersion: 1 })).status).toBe(403);
    const blank = await operateurA.post(`/reservations/${r.body.id}/no-show`, { reason: '     ', expectedVersion: 1 });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('MOTIF_REQUIS');
    const done = await operateurA.post(`/reservations/${r.body.id}/no-show`, { reason: 'conducteur absent', expectedVersion: 1 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'NON_HONOREE', cancelReason: 'conducteur absent', noShowAt: '2026-09-24T11:30:00.000Z', closedByName: 'Omar Opérateur-A', editScope: null, noShowAllowedFrom: null, version: 2 });
    expect((await t.prisma.client.reservation.findUniqueOrThrow({ where: { id: r.body.id } })).cancelledById).toBe(f.users.operateurA);
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'reservation.non_honoree', objectId: r.body.id } });
    expect(audit).toMatchObject({ actorUserId: f.users.operateurA, reason: 'conducteur absent' });
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'RESERVATION_COMPROMISE', objectId: r.body.id } })).status).toBe('RESOLUE');
    // Le créneau est libéré ; le statut est définitif.
    expect((await chefA.post('/reservations', body({ driverId: f.drivers.a2, startAt: '2026-09-24T12:00:00Z', endAt: '2026-09-24T14:00:00Z' }))).status).toBe(201);
    const again = await chefA.post(`/reservations/${r.body.id}/cancel`, { reason: 'essai', expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ETAT_INVALIDE');
    // Délai paramétrable par société (reservations.noShowGraceMinutes), lu au constat comme à l'affichage.
    expect((await admin.put('/settings/reservations.noShowGraceMinutes', { value: 30, companyId: f.companies.A, reason: 'constat plus rapide' })).status).toBe(200);
    const next = await chefA.post('/reservations', body({ driverId: f.drivers.a2, startAt: '2026-09-24T14:00:00Z', endAt: '2026-09-24T16:00:00Z' }));
    expect(next.body.noShowAllowedFrom).toBe('2026-09-24T14:30:00.000Z');
    t.clock.set('2026-09-24T14:29:00Z');
    const beforeGrace = await chefA.post(`/reservations/${next.body.id}/no-show`, { reason: 'conducteur absent', expectedVersion: 1 });
    expect(beforeGrace.status).toBe(422);
    expect(beforeGrace.body.details).toMatchObject({ allowedFrom: '2026-09-24T14:30:00.000Z', graceMinutes: 30 });
    t.clock.set('2026-09-24T14:30:00Z');
    expect((await chefA.post(`/reservations/${next.body.id}/no-show`, { reason: 'conducteur absent', expectedVersion: 1 })).status).toBe(200);
  });

  it('rattrapage : NON_HONOREE à la fin prévue sans conversion, idempotent, alerte résolue ; annulation résout aussi l’alerte', async () => {
    const r = await chefA.post('/reservations', body({ startAt: '2026-09-24T11:00:00Z', endAt: '2026-09-24T12:00:00Z' }));
    const other = await chefA.post('/reservations', body({ vehicleId: vA2, driverId: f.drivers.a2, startAt: '2026-09-24T11:00:00Z', endAt: '2026-09-24T16:00:00Z' }));
    await raiseCompromise(r.body.id, vA1);
    await raiseCompromise(other.body.id, vA2);
    t.clock.set('2026-09-24T12:00:00Z');
    const service = t.app.get(ReservationsService);
    expect(await service.expireUnconverted(f.organizationId)).toBe(1);
    expect(await service.expireUnconverted(f.organizationId)).toBe(0);
    const expired = await chefA.get(`/reservations/${r.body.id}`);
    expect(expired.body).toMatchObject({ status: 'NON_HONOREE', noShowAt: '2026-09-24T12:00:00.000Z', closedByName: null });
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: r.body.id } })).status).toBe('RESOLUE');
    expect((await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'reservation.non_honoree', objectId: r.body.id } })).actorType).toBe('SYSTEME');
    expect((await chefA.get(`/reservations/${other.body.id}`)).body.status).toBe('CONFIRMEE');
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: other.body.id } })).status).toBe('ACTIVE');
    const cancelled = await chefA.post(`/reservations/${other.body.id}/cancel`, { reason: 'mission annulée', expectedVersion: 1 });
    expect(cancelled.body).toMatchObject({ status: 'ANNULEE', closedByName: 'Chaima Chef-A' });
    expect((await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: other.body.id } })).status).toBe('RESOLUE');
  });

  it('courses : modifications, annulations et constats parallèles sur la même version → une réussite, un 409 VERSION_OBSOLETE (jamais 500)', async () => {
    const expectOneWinner = (responses: Array<{ status: number; body: { code?: string } }>) => {
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)?.body.code).toBe('VERSION_OBSOLETE');
    };
    const r1 = await chefA.post('/reservations', body({ startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T10:00:00Z' }));
    expectOneWinner(await Promise.all([chefA.patch(`/reservations/${r1.body.id}`, { endAt: '2026-10-01T11:00:00Z', reason: 'prolongation A', expectedVersion: 1 }), operateurA.patch(`/reservations/${r1.body.id}`, { endAt: '2026-10-01T12:00:00Z', reason: 'prolongation B', expectedVersion: 1 })]));
    expect((await chefA.get(`/reservations/${r1.body.id}`)).body.version).toBe(2);

    const r2 = await chefA.post('/reservations', body({ startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T10:00:00Z' }));
    expectOneWinner(await Promise.all([chefA.post(`/reservations/${r2.body.id}/cancel`, { reason: 'annulée par A', expectedVersion: 1 }), operateurA.post(`/reservations/${r2.body.id}/cancel`, { reason: 'annulée par B', expectedVersion: 1 })]));
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'reservation.annulation', objectId: r2.body.id } })).toBe(1);

    const r3 = await chefA.post('/reservations', body({ startAt: '2026-10-03T08:00:00Z', endAt: '2026-10-03T10:00:00Z' }));
    expectOneWinner(await Promise.all([chefA.patch(`/reservations/${r3.body.id}`, { vehicleId: vA2, reason: 'changement de véhicule', expectedVersion: 1 }), operateurA.post(`/reservations/${r3.body.id}/cancel`, { reason: 'mission annulée', expectedVersion: 1 })]));

    const r4 = await chefA.post('/reservations', body({ vehicleId: vA2, driverId: f.drivers.a2, startAt: '2026-09-24T10:00:00Z', endAt: '2026-09-24T16:00:00Z' }));
    t.clock.set('2026-09-24T11:00:00Z');
    expectOneWinner(await Promise.all([chefA.post(`/reservations/${r4.body.id}/no-show`, { reason: 'absent', expectedVersion: 1 }), operateurA.post(`/reservations/${r4.body.id}/cancel`, { reason: 'annulée', expectedVersion: 1 })]));
    const r5 = await chefA.post('/reservations', body({ startAt: '2026-09-24T10:50:00Z', endAt: '2026-09-24T18:00:00Z' }));
    t.clock.set('2026-09-24T12:00:00Z');
    expectOneWinner(await Promise.all([chefA.post(`/reservations/${r5.body.id}/no-show`, { reason: 'absent A', expectedVersion: 1 }), operateurA.post(`/reservations/${r5.body.id}/no-show`, { reason: 'absent B', expectedVersion: 1 })]));
  });

  it('planning (10.2, D-205) : interventions planifiées et en cours du périmètre, société sur chaque élément, avertissement de chevauchement sans blocage', async () => {
    const r = await chefA.post('/reservations', body());
    const elsewhere = await chefA.post('/reservations', body({ vehicleId: vA2, driverId: f.drivers.a2, startAt: '2026-10-02T08:00:00Z', endAt: '2026-10-02T12:00:00Z' }));
    const planned = await chefA.post('/interventions', { vehicleId: vA1, kind: 'PREVENTIF', plannedStartAt: '2026-10-01T11:00:00Z', plannedEndAt: '2026-10-01T17:00:00Z', tasks: [{ label: 'Vidange' }] });
    expect(planned.status).toBe(201);
    const running = await chefA.post('/interventions', { vehicleId: vA2, kind: 'CORRECTIF', plannedStartAt: '2026-09-24T09:00:00Z', plannedEndAt: '2026-09-25T09:00:00Z', tasks: [{ label: 'Freins' }] });
    const started = await chefA.post(`/interventions/${running.body.id}/start`, { startedAt: '2026-09-24T09:30:00Z', expectedVersion: running.body.version });
    expect(started.status).toBe(200);
    const draft = await chefA.post('/interventions', { vehicleId: vA1, kind: 'CORRECTIF', tasks: [{ label: 'À planifier' }] });
    expect(draft.status).toBe(201);
    const inB = await chefB.post('/interventions', { vehicleId: vB1, kind: 'PREVENTIF', plannedStartAt: '2026-10-01T08:00:00Z', plannedEndAt: '2026-10-01T10:00:00Z', tasks: [{ label: 'Contrôle' }] });
    expect(inB.status).toBe(201);

    const window = '?from=2026-09-24T00:00:00Z&to=2026-10-08T00:00:00Z';
    const res = await chefA.get(`/planning${window}`);
    expect(res.status).toBe(200);
    const plan = res.body as PlanningBody;
    const interventions = plan.items.filter((i) => i.kind === 'INTERVENTION');
    expect(interventions.map((i) => i.id).sort()).toEqual([planned.body.id, running.body.id].sort());
    expect(interventions.find((i) => i.id === planned.body.id)).toMatchObject({ companyId: f.companies.A, vehicleId: vA1, startAt: '2026-10-01T11:00:00.000Z', endAt: '2026-10-01T17:00:00.000Z', status: 'PLANIFIEE', isLate: false });
    expect(interventions.find((i) => i.id === running.body.id)).toMatchObject({ status: 'EN_COURS', startAt: '2026-09-24T09:30:00.000Z', endAt: '2026-09-25T09:00:00.000Z' });
    expect(plan.items.every((i) => i.companyId === f.companies.A)).toBe(true);
    expect(plan.items.filter((i) => i.kind === 'RESERVATION').map((i) => i.id).sort()).toEqual([r.body.id, elsewhere.body.id].sort());
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatchObject({ code: 'INTERVENTION_CHEVAUCHE_RESERVATION', interventionId: planned.body.id, reservationId: r.body.id, vehicleId: vA1, companyId: f.companies.A });
    expect(plan.warnings[0]?.message).toContain('chevauche la réservation confirmée');
    // Avertissement sans blocage : la réservation reste modifiable, et l'avertissement disparaît quand les créneaux se séparent.
    const shortened = await chefA.patch(`/reservations/${r.body.id}`, { endAt: '2026-10-01T11:00:00Z', reason: 'libérer le véhicule pour l’entretien', expectedVersion: 1 });
    expect(shortened.status).toBe(200);
    expect(((await chefA.get(`/planning${window}`)).body as PlanningBody).warnings).toHaveLength(0);
    // L'administrateur voit aussi la société B, chaque élément portant sa société.
    const all = (await admin.get(`/planning${window}`)).body as PlanningBody;
    expect(all.items.find((i) => i.id === inB.body.id)?.companyId).toBe(f.companies.B);
    // Le chef B ne voit que sa société.
    const onlyB = (await chefB.get(`/planning${window}`)).body as PlanningBody;
    expect(onlyB.items.map((i) => i.id)).toEqual([inB.body.id]);
    // Fin prévue dépassée d'une intervention en cours : signalée, et toujours affichée.
    t.clock.set('2026-09-26T10:00:00Z');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const late = (await chefA.get('/planning?from=2026-09-26T00:00:00Z&to=2026-09-27T00:00:00Z')).body as PlanningBody;
    expect(late.items.find((i) => i.id === running.body.id)).toMatchObject({ kind: 'INTERVENTION', isLate: true });
  });
});
