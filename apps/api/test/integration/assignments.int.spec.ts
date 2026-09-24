import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors.js';
import type { RequestContext } from '../../src/common/request-context.js';
import { DriverSubmissionService } from '../../src/modules/assignments/driver-submission.service.js';
import { ContextBuilderService } from '../../src/modules/auth/context-builder.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

type View = { id: string; driverId: string; vehicleId: string; startsAt: string; endsAt: string | null; status: string; isCurrent: boolean; canEnd: boolean; version: number; endReason: string | null };

describe('Responsables habituels et visibilité conducteur (CDC 3.3, 4.1, 2.3, 10.3 ; D-136, D-268)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let lecteurA: Agent;
  let conducteur: Agent;
  let v1: string;
  let v2: string;
  let keySeq = 0;
  const key = () => `cle-aff-${Date.now()}-${keySeq++}`;

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
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    v1 = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    v2 = await createVehicle(t.prisma, f, 'A', { code: 'VA-2' });
  });

  const assign = (agent: Agent, body: Record<string, unknown>) => agent.post('/responsible-assignments', body);
  /** Avance l'horloge ; les sessions expirent (session.ttlHours), on se reconnecte à la nouvelle date. */
  const travel = async (iso: string) => {
    t.clock.set(iso);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  };
  const vehicleVersion = async (id: string) => (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id } })).version;

  it('statut A_VENIR / EN_COURS / TERMINEE et canEnd calculés par le serveur, bornes comprises', async () => {
    const done = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-09-01T00:00:00Z' });
    const current = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-10T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' });
    const upcoming = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2027-01-01T00:00:00Z' });
    expect([done.status, current.status, upcoming.status]).toEqual([201, 201, 201]);
    expect(current.body).toMatchObject({ status: 'EN_COURS', isCurrent: true, canEnd: true });

    const list = await chefA.get(`/responsible-assignments?vehicleId=${v1}`);
    expect(list.status).toBe(200);
    expect((list.body as View[]).map((a) => [a.status, a.isCurrent, a.canEnd])).toEqual([
      ['A_VENIR', false, true],
      ['EN_COURS', true, true],
      ['TERMINEE', false, false],
    ]);
    // Lecteur : même statut, aucune action possible.
    const read = await lecteurA.get(`/responsible-assignments?vehicleId=${v1}`);
    expect((read.body as View[]).map((a) => [a.status, a.canEnd])).toEqual([
      ['A_VENIR', false],
      ['EN_COURS', false],
      ['TERMINEE', false],
    ]);
    // Synthèse : responsable EN_COURS malgré une fin prévue.
    expect((await chefA.get(`/vehicles/${v1}/synthesis`)).body.responsible).toMatchObject({ assignmentId: current.body.id, driverId: f.drivers.a1 });

    // Fin atteinte (borne exclue) : TERMINEE, plus de responsable en synthèse.
    await travel('2026-12-31T00:00:00.000Z');
    const atEnd = (await chefA.get(`/responsible-assignments?vehicleId=${v1}`)).body as View[];
    expect(atEnd.find((a) => a.id === current.body.id)).toMatchObject({ status: 'TERMINEE', isCurrent: false, canEnd: false });
    expect((await chefA.get(`/vehicles/${v1}/synthesis`)).body.responsible).toBeNull();
    // Début atteint (borne incluse) : EN_COURS.
    await travel('2027-01-01T00:00:00.000Z');
    const atStart = (await chefA.get(`/responsible-assignments?vehicleId=${v1}`)).body as View[];
    expect(atStart.find((a) => a.id === upcoming.body.id)).toMatchObject({ status: 'EN_COURS', isCurrent: true, canEnd: true });
    expect((await chefA.get(`/vehicles/${v1}/synthesis`)).body.responsible).toMatchObject({ assignmentId: upcoming.body.id });
  });

  it('un conducteur voit le véhicule dont il est responsable EN_COURS (même avec une fin prévue), jamais une affectation à venir ou terminée', async () => {
    const qr1 = (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: v1 } })).qrToken;
    // V1 : affectation à venir, sans fin prévue.
    expect((await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-10-01T00:00:00Z' })).status).toBe(201);
    // V2 : affectation en cours avec fin prévue.
    expect((await assign(chefA, { vehicleId: v2, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' })).status).toBe(201);

    expect((await conducteur.get(`/vehicles/${v1}`)).status).toBe(404);
    expect((await conducteur.get(`/vehicles/qr/${qr1}`)).status).toBe(404);
    expect((await conducteur.get(`/vehicles/${v2}`)).status).toBe(200);

    await travel('2026-10-01T00:00:00.000Z');
    expect((await conducteur.get(`/vehicles/${v1}`)).status).toBe(200);
    expect((await conducteur.get(`/vehicles/qr/${qr1}`)).status).toBe(200);

    await travel('2026-12-31T00:00:00.000Z');
    expect((await conducteur.get(`/vehicles/${v2}`)).status).toBe(404);
  });

  it('remplacement explicite d’un responsable EN_COURS avec fin prévue ; une affectation à venir n’est jamais remplacée', async () => {
    const current = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' });
    expect(current.status).toBe(201);
    const refused = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    const replaced = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z', replaceCurrent: true });
    expect(replaced.status).toBe(201);
    expect(replaced.body).toMatchObject({ status: 'EN_COURS', driverId: f.drivers.a2 });
    const old = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: current.body.id } });
    expect(old.endsAt?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(old.version).toBe(2);
    expect(old.endReason).toBe('Remplacé par un nouveau responsable habituel');
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.remplacement', objectId: current.body.id } })).toBe(1);
    const earlier = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-15T00:00:00Z', replaceCurrent: true });
    expect(earlier.status).toBe(422);
    expect(earlier.body.code).toBe('INTERVALLE_INVALIDE');

    // V2 : seule une affectation à venir existe ; replaceCurrent ne la clôture pas (409, rien de modifié).
    const upcoming = await assign(chefA, { vehicleId: v2, driverId: f.drivers.a1, startsAt: '2026-10-01T00:00:00Z' });
    expect(upcoming.status).toBe(201);
    const notReplaced = await assign(chefA, { vehicleId: v2, driverId: f.drivers.a2, startsAt: '2026-10-05T00:00:00Z', replaceCurrent: true });
    expect(notReplaced.status).toBe(409);
    expect(notReplaced.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    expect(await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: upcoming.body.id } })).toMatchObject({ endsAt: null, version: 1 });
  });

  it('création refusée sur un véhicule cédé ou archivé (422) et pour un conducteur inactif', async () => {
    expect((await chefA.post(`/vehicles/${v1}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de vie', expectedVersion: await vehicleVersion(v1) })).status).toBe(200);
    expect((await chefA.post(`/vehicles/${v2}/lifecycle`, { lifecycleStatus: 'CEDE', reason: 'vendu', expectedVersion: await vehicleVersion(v2) })).status).toBe(200);
    for (const vehicleId of [v1, v2]) {
      const res = await assign(chefA, { vehicleId, driverId: f.drivers.a1, startsAt: '2026-09-24T09:00:00Z' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VEHICULE_INACTIF');
    }
    const v3 = await createVehicle(t.prisma, f, 'A', { code: 'VA-3' });
    await t.prisma.client.driver.update({ where: { id: f.drivers.a2 }, data: { status: 'INACTIF', deactivatedAt: new Date(NOW) } });
    const inactive = await assign(chefA, { vehicleId: v3, driverId: f.drivers.a2, startsAt: '2026-09-24T09:00:00Z' });
    expect(inactive.status).toBe(422);
    expect(inactive.body.code).toBe('CONDUCTEUR_INACTIF');
    expect(await t.prisma.client.vehicleResponsibleAssignment.count()).toBe(0);
  });

  it('archivage et cession : affectation en cours (même avec fin future) clôturée, version incrémentée, affectation à venir retirée, audit', async () => {
    const current = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' });
    const upcoming = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2027-01-01T00:00:00Z' });
    const openEnded = await assign(chefA, { vehicleId: v2, driverId: f.drivers.a2, startsAt: '2026-09-01T00:00:00Z' });
    expect([current.status, upcoming.status, openEnded.status]).toEqual([201, 201, 201]);
    expect((await conducteur.get(`/vehicles/${v1}`)).status).toBe(200);

    const archived = await chefA.post(`/vehicles/${v1}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de vie', expectedVersion: await vehicleVersion(v1) });
    expect(archived.status).toBe(200);
    const closed = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: current.body.id } });
    expect(closed).toMatchObject({ version: 2, endReason: 'véhicule archivé', endedById: f.users.chefA });
    expect(closed.endsAt?.toISOString()).toBe(NOW);
    expect(await t.prisma.client.vehicleResponsibleAssignment.findUnique({ where: { id: upcoming.body.id } })).toBeNull();
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.fin', objectId: current.body.id } })).toBe(1);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.retrait', objectId: upcoming.body.id } })).toBe(1);
    expect((await conducteur.get(`/vehicles/${v1}`)).status).toBe(404);
    expect((await chefA.get(`/responsible-assignments?vehicleId=${v1}`)).body.map((a: View) => a.status)).toEqual(['TERMINEE']);

    const ceded = await chefA.post(`/vehicles/${v2}/lifecycle`, { lifecycleStatus: 'CEDE', reason: 'vendu', expectedVersion: await vehicleVersion(v2) });
    expect(ceded.status).toBe(200);
    const closedB = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: openEnded.body.id } });
    expect(closedB).toMatchObject({ version: 2, endReason: 'véhicule cédé' });
    expect(closedB.endsAt?.toISOString()).toBe(NOW);
  });

  it('archivage et nomination en parallèle : jamais de responsable ouvert sur un véhicule archivé', async () => {
    for (let round = 0; round < 3; round += 1) {
      const vehicleId = await createVehicle(t.prisma, f, 'A', { code: `VA-P${round}` });
      const [archive, created] = await Promise.all([
        chefA.post(`/vehicles/${vehicleId}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de vie', expectedVersion: 1 }),
        assign(chefA, { vehicleId, driverId: f.drivers.a1, startsAt: '2026-09-24T09:00:00Z' }),
      ]);
      expect(archive.status).toBe(200);
      expect([201, 422]).toContain(created.status);
      if (created.status === 422) expect(created.body.code).toBe('VEHICULE_INACTIF');
      const open = await t.prisma.client.vehicleResponsibleAssignment.count({ where: { vehicleId, OR: [{ endsAt: null }, { endsAt: { gt: new Date(NOW) } }] } });
      expect(open).toBe(0);
    }
  });

  it('remplacement versionné : seule l’affectation affichée, à sa version, est remplacée (courses et vue périmée → 409)', async () => {
    const shown = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' });
    expect(shown.status).toBe(201);
    const replaceShown = (driverId: string, startsAt: string) => assign(chefA, { vehicleId: v1, driverId, startsAt, replaceCurrent: true, replacedAssignmentId: shown.body.id, replacedExpectedVersion: shown.body.version });
    // Deux utilisateurs remplacent en même temps le responsable affiché, à des dates différentes :
    // un seul remplacement aboutit, l'autre ne clôture pas silencieusement le nouveau responsable.
    const [r1, r2] = await Promise.all([replaceShown(f.drivers.a2, '2026-09-20T00:00:00Z'), replaceShown(f.drivers.a1, '2026-09-22T00:00:00Z')]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = [r1, r2].find((r) => r.status === 409);
    const winner = [r1, r2].find((r) => r.status === 201)?.body as View;
    expect(loser?.body.code).toBe('VERSION_OBSOLETE');
    const rows = await t.prisma.client.vehicleResponsibleAssignment.findMany({ where: { vehicleId: v1 }, orderBy: { startsAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: shown.body.id, version: 2 });
    expect(rows[0]?.endsAt?.toISOString()).toBe(winner.startsAt);
    expect(rows[1]).toMatchObject({ id: winner.id, endsAt: null, version: 1 });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.remplacement' } })).toBe(1);

    // Vue périmée rejouée : l'affectation affichée n'est plus en cours → 409, rien de modifié.
    const stale = await replaceShown(f.drivers.a1, '2026-09-23T00:00:00Z');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');
    // Bonne affectation mais version périmée → 409.
    const staleVersion = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-23T00:00:00Z', replaceCurrent: true, replacedAssignmentId: winner.id, replacedExpectedVersion: winner.version + 1 });
    expect(staleVersion.status).toBe(409);
    expect(staleVersion.body.code).toBe('VERSION_OBSOLETE');
    // Affectation à remplacer sans demande explicite de remplacement → 422.
    const incoherent = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-23T00:00:00Z', replacedAssignmentId: winner.id, replacedExpectedVersion: winner.version });
    expect(incoherent.status).toBe(422);
    expect(incoherent.body.code).toBe('REMPLACEMENT_INCOHERENT');
    expect(await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: winner.id } })).toMatchObject({ endsAt: null, version: 1 });
    expect(await t.prisma.client.vehicleResponsibleAssignment.count({ where: { vehicleId: v1 } })).toBe(2);

    // Vue à jour : le remplacement aboutit.
    const ok = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-23T00:00:00Z', replaceCurrent: true, replacedAssignmentId: winner.id, replacedExpectedVersion: winner.version });
    expect(ok.status).toBe(201);
    expect(await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: winner.id } })).toMatchObject({ version: 2 });
  });

  it('nominations concurrentes : une seule réussit ; remplacements concurrents : un seul responsable en cours', async () => {
    const [a, b] = await Promise.all([
      assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z' }),
      assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-09-02T00:00:00Z' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    expect(await t.prisma.client.vehicleResponsibleAssignment.count({ where: { vehicleId: v1 } })).toBe(1);

    const [r1, r2] = await Promise.all([
      assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z', replaceCurrent: true }),
      assign(chefA, { vehicleId: v1, driverId: f.drivers.a2, startsAt: '2026-09-20T00:00:00Z', replaceCurrent: true }),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 201)).toHaveLength(1);
    expect([r1.status, r2.status].every((s) => s === 201 || s === 409 || s === 422)).toBe(true);
    const rows = await t.prisma.client.vehicleResponsibleAssignment.findMany({ where: { vehicleId: v1 }, orderBy: { startsAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.endsAt?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(rows[0]?.version).toBe(2);
    expect((await chefA.get(`/responsible-assignments?vehicleId=${v1}`)).body.filter((x: View) => x.status === 'EN_COURS')).toHaveLength(1);
  });

  it('fin : version contrôlée sous verrou (fins concurrentes : une seule), déjà terminée → 409, chevauchement → 409 lisible', async () => {
    const first = await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z' });
    const [e1, e2] = await Promise.all([
      chefA.post(`/responsible-assignments/${first.body.id}/end`, { endsAt: '2026-09-24T09:00:00Z', reason: 'départ du conducteur', expectedVersion: 1 }),
      chefA.post(`/responsible-assignments/${first.body.id}/end`, { endsAt: '2026-09-24T08:00:00Z', reason: 'mutation', expectedVersion: 1 }),
    ]);
    expect([e1.status, e2.status].sort()).toEqual([200, 409]);
    expect([e1, e2].find((r) => r.status === 409)?.body.code).toBe('VERSION_OBSOLETE');
    const ended = [e1, e2].find((r) => r.status === 200)?.body as View;
    expect(ended).toMatchObject({ status: 'TERMINEE', canEnd: false, version: 2 });
    const again = await chefA.post(`/responsible-assignments/${first.body.id}/end`, { endsAt: '2026-09-24T09:30:00Z', reason: 'nouvelle tentative', expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ETAT_INVALIDE');

    // Prolonger une fin prévue jusque sur l'affectation suivante : 409 métier, pas d'erreur serveur.
    const withEnd = await assign(chefA, { vehicleId: v2, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' });
    expect((await assign(chefA, { vehicleId: v2, driverId: f.drivers.a2, startsAt: '2026-10-01T00:00:00Z' })).status).toBe(201);
    const overlap = await chefA.post(`/responsible-assignments/${withEnd.body.id}/end`, { endsAt: '2026-10-15T00:00:00Z', reason: 'prolongation', expectedVersion: 1 });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    // Le lecteur ne peut pas terminer une affectation (403).
    expect((await lecteurA.post(`/responsible-assignments/${withEnd.body.id}/end`, { endsAt: '2026-09-30T00:00:00Z', reason: 'essai', expectedVersion: 1 })).status).toBe(403);
  });

  it('liste : refus 403 cohérent pour un compte conducteur seul, avant tout chargement', async () => {
    // Même le véhicule dont il est responsable, sa propre fiche, un filtre absent ou un objet invisible : 403.
    expect((await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z' })).status).toBe(201);
    const other = await createVehicle(t.prisma, f, 'B', { code: 'VB-1' });
    for (const path of ['/responsible-assignments', `/responsible-assignments?vehicleId=${v1}`, `/responsible-assignments?driverId=${f.drivers.a1}`, `/responsible-assignments?vehicleId=${other}`, `/responsible-assignments?driverId=${f.drivers.a2}`]) {
      const res = await conducteur.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('ACTION_INTERDITE');
    }
    expect((await chefA.get('/responsible-assignments')).status).toBe(422);
    // Nomination et fin : actions de gestion, même refus 403 quel que soit l'objet visé.
    const own = (await chefA.get(`/responsible-assignments?vehicleId=${v1}`)).body[0] as View;
    for (const vehicleId of [v1, other]) {
      const res = await conducteur.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a1, startsAt: '2026-12-01T00:00:00Z' });
      expect(res.status, vehicleId).toBe(403);
      expect(res.body.code).toBe('ACTION_INTERDITE');
    }
    const end = await conducteur.post(`/responsible-assignments/${own.id}/end`, { endsAt: '2026-12-01T00:00:00Z', reason: 'essai conducteur', expectedVersion: own.version });
    expect(end.status).toBe(403);
    expect(end.body.code).toBe('ACTION_INTERDITE');
    expect(await t.prisma.client.vehicleResponsibleAssignment.count()).toBe(1);
  });

  it('D-268 : véhicule de soumission du conducteur (utilisation EN_COURS, sinon responsable en cours si le paramètre de groupe est actif)', async () => {
    // Responsable en cours de V1, à venir sur V2.
    expect((await assign(chefA, { vehicleId: v1, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' })).status).toBe(201);
    expect((await assign(chefA, { vehicleId: v2, driverId: f.drivers.a1, startsAt: '2026-10-01T00:00:00Z' })).status).toBe(201);
    // Paramètre désactivé par défaut : aucune soumission hors utilisation.
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([]);
    // Point d'entrée des modules relevés, incidents et carburant : véhicule lisible (200) mais hors droit de soumission → 403 (D-118).
    const submissions = t.app.get(DriverSubmissionService);
    const driverCtx = (await t.app.get(ContextBuilderService).forUser(f.users.conducteurA, f.organizationId, 'test-d268')) as RequestContext;
    const forbidden = async (vehicleId: string) => {
      const error = await submissions.requireTarget(driverCtx, vehicleId).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(403);
      expect((error as AppError).code).toBe('ACTION_INTERDITE');
    };
    expect((await conducteur.get(`/vehicles/${v1}`)).status).toBe(200);
    await forbidden(v1);
    const settings = await admin.get('/settings');
    expect(settings.body.find((s: { key: string }) => s.key === 'drivers.allowHabitualVehicleSubmissions')).toMatchObject({ value: false, source: 'defaut', companyOverride: false });

    // Paramètre de groupe réservé à l'administrateur, sans surcharge par société.
    expect((await chefA.put('/settings/drivers.allowHabitualVehicleSubmissions', { value: true, reason: 'essai chef' })).status).toBe(403);
    const override = await admin.put('/settings/drivers.allowHabitualVehicleSubmissions', { value: true, companyId: f.companies.A, reason: 'surcharge société' });
    expect(override.status).toBe(422);
    expect(override.body.code).toBe('SURCHARGE_INTERDITE');
    expect((await admin.put('/settings/drivers.allowHabitualVehicleSubmissions', { value: true, reason: 'véhicules de fonction' })).status).toBe(200);
    const habitual = await conducteur.get('/driver-submissions/vehicles');
    expect(habitual.status).toBe(200);
    expect(habitual.body).toEqual([{ vehicleId: v1, vehicleCode: 'VA-1', registration: expect.any(String), basis: 'RESPONSABLE_HABITUEL', usageId: null }]);
    expect(await submissions.requireTarget(driverCtx, v1)).toMatchObject({ vehicleId: v1, basis: 'RESPONSABLE_HABITUEL', usageId: null });
    // Affectation à venir sur V2 : aucun droit de soumission.
    await forbidden(v2);

    // Utilisation EN_COURS sur V2 : seul ce véhicule, même avec le paramètre actif.
    await chefA.post(`/vehicles/${v2}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-A1', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const checkout = await chefA
      .post('/usages/checkout', { vehicleId: v2, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T09:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'TROIS_QUARTS', checklist: [{ label: 'Clés', present: true }] })
      .set('Idempotency-Key', key());
    expect(checkout.status).toBe(201);
    expect((await conducteur.get('/driver-submissions/vehicles')).body).toEqual([{ vehicleId: v2, vehicleCode: 'VA-2', registration: expect.any(String), basis: 'UTILISATION_EN_COURS', usageId: checkout.body.id }]);

    // Un compte sans fiche conducteur n'a aucun véhicule de soumission.
    expect((await chefA.get('/driver-submissions/vehicles')).body).toEqual([]);
  });
});
