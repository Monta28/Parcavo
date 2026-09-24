import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

type View = { id: string; driverId: string; startsAt: string; endsAt: string | null; notes: string | null; status: string; editableFields: string[]; version: number };

/**
 * Modification d'une affectation habituelle (CDC 15.2 « /responsible-assignments : créer, modifier, terminer »,
 * 4.1) : PATCH versionné et motivé, mêmes contrôles que la nomination, audit avant/après.
 */
describe('Modification d’une affectation habituelle (CDC 15.2, 4.1 ; R-15.2-08, R-1.2-03)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let v1: string;

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
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    v1 = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
  });

  const assign = async (body: Record<string, unknown>): Promise<View> => {
    const res = await chefA.post('/responsible-assignments', { vehicleId: v1, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as View;
  };

  it('affectation à venir : responsable, début, fin et notes modifiés avec motif, version incrémentée et audit avant/après', async () => {
    const a = await assign({ driverId: f.drivers.a1, startsAt: '2026-10-01T08:00:00Z', notes: 'Tournée nord' });
    expect(a.status).toBe('A_VENIR');
    expect(a.editableFields).toEqual(['driverId', 'startsAt', 'endsAt', 'notes']);
    const res = await operateurA.patch(`/responsible-assignments/${a.id}`, { driverId: f.drivers.a2, startsAt: '2026-10-02T08:00:00Z', endsAt: '2026-12-31T18:00:00Z', notes: '  ', reason: 'Changement de tournée', expectedVersion: a.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ driverId: f.drivers.a2, startsAt: '2026-10-02T08:00:00.000Z', endsAt: '2026-12-31T18:00:00.000Z', notes: null, status: 'A_VENIR', version: a.version + 1 });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'responsable_habituel.modification', objectId: a.id } });
    expect(audit.reason).toBe('Changement de tournée');
    expect(audit.before).toMatchObject({ driverId: f.drivers.a1, startsAt: '2026-10-01T08:00:00.000Z', endsAt: null, notes: 'Tournée nord' });
    expect(audit.after).toMatchObject({ driverId: f.drivers.a2, endsAt: '2026-12-31T18:00:00.000Z', notes: null, changedFields: ['driverId', 'startsAt', 'endsAt', 'notes'] });
    // Version périmée : 409 VERSION_OBSOLETE, rien n'est modifié.
    const stale = await chefA.patch(`/responsible-assignments/${a.id}`, { notes: 'Autre', reason: 'Vue périmée', expectedVersion: a.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');
    expect((await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: a.id } })).notes).toBeNull();
  });

  it('affectation en cours : fin prévue et notes modifiables ; responsable, début ou fin passée refusés (422) ; terminée : 409', async () => {
    const a = await assign({ driverId: f.drivers.a1, startsAt: '2026-09-01T08:00:00Z' });
    expect(a.status).toBe('EN_COURS');
    expect(a.editableFields).toEqual(['endsAt', 'notes']);
    const driver = await chefA.patch(`/responsible-assignments/${a.id}`, { driverId: f.drivers.a2, reason: 'Nouveau responsable', expectedVersion: a.version });
    expect(driver.status).toBe(422);
    expect(driver.body.code).toBe('MODIFICATION_INTERDITE');
    expect(Object.keys(driver.body.fieldErrors)).toEqual(['driverId']);
    const start = await chefA.patch(`/responsible-assignments/${a.id}`, { startsAt: '2026-09-02T08:00:00Z', reason: 'Début corrigé', expectedVersion: a.version });
    expect(start.status).toBe(422);
    expect(start.body.code).toBe('MODIFICATION_INTERDITE');
    const past = await chefA.patch(`/responsible-assignments/${a.id}`, { endsAt: '2026-09-20T08:00:00Z', reason: 'Fin passée', expectedVersion: a.version });
    expect(past.status).toBe(422);
    expect(past.body.code).toBe('FIN_PASSEE');
    const empty = await chefA.patch(`/responsible-assignments/${a.id}`, { reason: 'Rien', expectedVersion: a.version });
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe('MODIFICATION_VIDE');
    const nullDriver = await chefA.patch(`/responsible-assignments/${a.id}`, { driverId: null, reason: 'Effacement', expectedVersion: a.version });
    expect(nullDriver.status).toBe(422);
    const ok = await chefA.patch(`/responsible-assignments/${a.id}`, { endsAt: '2026-11-30T18:00:00Z', notes: 'Jusqu’à la fin du chantier', reason: 'Fin de chantier connue', expectedVersion: a.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'EN_COURS', endsAt: '2026-11-30T18:00:00.000Z', notes: 'Jusqu’à la fin du chantier', driverId: f.drivers.a1 });
    const cleared = await chefA.patch(`/responsible-assignments/${a.id}`, { endsAt: null, reason: 'Chantier prolongé sans date', expectedVersion: ok.body.version });
    expect(cleared.status).toBe(200);
    expect(cleared.body.endsAt).toBeNull();
    // Terminée : historique figé (409), editableFields vide.
    const ended = await chefA.post(`/responsible-assignments/${a.id}/end`, { endsAt: '2026-09-24T09:00:00Z', reason: 'Fin de mission', expectedVersion: cleared.body.version });
    expect(ended.status).toBe(200);
    expect(ended.body.editableFields).toEqual([]);
    const frozen = await chefA.patch(`/responsible-assignments/${a.id}`, { notes: 'a posteriori', reason: 'Réécriture', expectedVersion: ended.body.version });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('ETAT_INVALIDE');
  });

  it('mêmes contrôles que la nomination : chevauchement 409, conducteur inactif ou d’une autre société 422, hors périmètre 404, lecteur 403', async () => {
    const current = await assign({ driverId: f.drivers.a1, startsAt: '2026-09-01T08:00:00Z', endsAt: '2026-10-01T08:00:00Z' });
    const upcoming = await assign({ driverId: f.drivers.a2, startsAt: '2026-10-05T08:00:00Z' });
    // Avancer le début de l'affectation à venir sur la période en cours : chevauchement (contrainte d'exclusion).
    const overlap = await chefA.patch(`/responsible-assignments/${upcoming.id}`, { startsAt: '2026-09-28T08:00:00Z', reason: 'Début avancé', expectedVersion: upcoming.version });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    // Prolonger l'affectation en cours au-delà du début de la suivante : même refus.
    const extend = await chefA.patch(`/responsible-assignments/${current.id}`, { endsAt: '2026-10-10T08:00:00Z', reason: 'Prolongation', expectedVersion: current.version });
    expect(extend.status).toBe(409);
    expect(extend.body.code).toBe('RESPONSABLE_CHEVAUCHEMENT');
    // Conducteur d'une autre société : invisible pour le chef A (404), refusé pour l'administrateur (422).
    expect((await chefA.patch(`/responsible-assignments/${upcoming.id}`, { driverId: f.drivers.b1, reason: 'Autre société', expectedVersion: upcoming.version })).status).toBe(404);
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const otherCompany = await admin.patch(`/responsible-assignments/${upcoming.id}`, { driverId: f.drivers.b1, reason: 'Autre société', expectedVersion: upcoming.version });
    expect(otherCompany.status).toBe(422);
    expect(otherCompany.body.code).toBe('SOCIETE_DIFFERENTE');
    // Conducteur inactif.
    const inactive = await t.prisma.client.driver.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, code: 'D-A9', firstName: 'Ina', lastName: 'Ctif', status: 'INACTIF' } });
    const refused = await chefA.patch(`/responsible-assignments/${upcoming.id}`, { driverId: inactive.id, reason: 'Conducteur inactif', expectedVersion: upcoming.version });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('CONDUCTEUR_INACTIF');
    // Hors périmètre (chef B) : 404 sans révéler l'existence ; lecteur : 403.
    expect((await chefB.patch(`/responsible-assignments/${upcoming.id}`, { notes: 'x', reason: 'Hors périmètre', expectedVersion: upcoming.version })).status).toBe(404);
    expect((await lecteurA.patch(`/responsible-assignments/${upcoming.id}`, { notes: 'x', reason: 'Lecture seule', expectedVersion: upcoming.version })).status).toBe(403);
    expect((await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: upcoming.id } })).version).toBe(upcoming.version);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.modification' } })).toBe(0);
  });

  it('modifications concurrentes sur la même version : une seule réussit, l’autre reçoit 409 (jamais 500)', async () => {
    const a = await assign({ driverId: f.drivers.a1, startsAt: '2026-10-01T08:00:00Z' });
    const results = await Promise.all([
      chefA.patch(`/responsible-assignments/${a.id}`, { notes: 'Version A', reason: 'Course A', expectedVersion: a.version }),
      operateurA.patch(`/responsible-assignments/${a.id}`, { notes: 'Version B', reason: 'Course B', expectedVersion: a.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.version).toBe(a.version + 1);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'responsable_habituel.modification', objectId: a.id } })).toBe(1);
  });
});
