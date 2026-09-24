import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Immobilisations — identifiant renvoyé par l'immobilisation depuis un incident, lieu et fin prévue
 * jamais ignorés sur une immobilisation active, lieu exclusif et garage valide, durées (D-219, D-220).
 */
describe('Immobilisations : lieu, fin prévue et durées (CDC 7.4 ; D-219, D-220, D-221)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;
  let vehicleId: string;
  let garageId: string;

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
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    const garage = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE' });
    expect(garage.status, JSON.stringify(garage.body)).toBe(201);
    garageId = garage.body.id as string;
  });

  async function incident(description = 'Panne moteur sur route') {
    const res = await chefA.post('/incidents', { vehicleId, type: 'PANNE', severity: 'ELEVEE', description });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; reference: string };
  }

  it('POST /incidents/:id/immobilize renvoie l’immobilisation créée puis complétée ; lieu et fin prévue appliqués explicitement', async () => {
    const first = await incident();
    const created = await chefA.post(`/incidents/${first.id}/immobilize`, { reason: 'Panne moteur', startedAt: '2026-09-24T08:00:00Z', locationLabel: 'Bord de route' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ created: true, placeApplied: true, expectedEndApplied: false, incident: { id: first.id } });
    expect(created.body.incident.openImmobilizationCauseId).toBe(created.body.causeId);
    const immobilizationId = created.body.immobilizationId as string;

    // Second incident sur le même véhicule : la cause complète l'immobilisation active (même identifiant) ;
    // le garage et la fin prévue fournis remplacent ceux de l'immobilisation, au lieu d'être ignorés.
    const second = await incident('Pare-brise fissuré');
    const completed = await chefA.post(`/incidents/${second.id}/immobilize`, { reason: 'Pare-brise à remplacer', garageSupplierId: garageId, expectedEndAt: '2026-09-27T17:00:00Z' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body).toMatchObject({ immobilizationId, created: false, placeApplied: true, expectedEndApplied: true });
    const immo = await chefA.get(`/immobilizations/${immobilizationId}`);
    expect(immo.body).toMatchObject({ status: 'ACTIVE', garageSupplierId: garageId, garageName: 'Garage Central', siteId: null, locationLabel: null, expectedEndAt: '2026-09-27T17:00:00.000Z' });
    expect(immo.body.causes).toHaveLength(2);
    expect(await t.prisma.client.immobilization.count({ where: { vehicleId } })).toBe(1);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'immobilisation.cause_ajoutee', objectId: immobilizationId } });
    expect(audit.before).toMatchObject({ locationLabel: 'Bord de route', garageSupplierId: null, expectedEndAt: null });
    const located = await t.prisma.client.vehicleLocationReport.findFirstOrThrow({ where: { vehicleId, placeLabel: 'Garage Garage Central' } });
    expect(located.context).toBe('GARAGE');

    // Fin prévue antérieure au début : 422 explicite.
    const third = await incident('Batterie à plat');
    const early = await chefA.post(`/incidents/${third.id}/immobilize`, { reason: 'Batterie', expectedEndAt: '2026-09-24T07:00:00Z' });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('FIN_PREVUE_AVANT_DEBUT');
  });

  it('lieu : site, garage et lieu libre exclusifs ; garage = fournisseur ACTIF de catégorie GARAGE de la même société', async () => {
    const inc = await incident();
    const site = await t.prisma.client.site.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, name: 'Dépôt Nord' } });
    const both = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne', garageSupplierId: garageId, locationLabel: 'Parking client' });
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('LIEU_EXCLUSIF');
    expect(Object.keys(both.body.fieldErrors).sort()).toEqual(['garageSupplierId', 'locationLabel']);
    const siteAndGarage = await chefA.post('/immobilizations', { vehicleId, reason: 'Contrôle', siteId: site.id, garageSupplierId: garageId });
    expect(siteAndGarage.status).toBe(422);
    expect(siteAndGarage.body.code).toBe('LIEU_EXCLUSIF');

    const station = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Station du Lac', category: 'STATION' });
    const notGarage = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne', garageSupplierId: station.body.id });
    expect(notGarage.status).toBe(422);
    expect(notGarage.body.code).toBe('FOURNISSEUR_NON_GARAGE');

    const garageB = await chefB.post('/suppliers', { companyId: f.companies.B, name: 'Garage B', category: 'GARAGE' });
    expect((await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne', garageSupplierId: garageB.body.id })).status).toBe(404);

    const archived = await chefA.post(`/suppliers/${garageId}/archive`, { expectedVersion: 1 });
    expect(archived.status).toBe(200);
    const refused = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne', garageSupplierId: garageId });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'FOURNISSEUR_ARCHIVE', fieldErrors: { garageSupplierId: ['Fournisseur archivé.'] } });
    expect(await t.prisma.client.immobilization.count()).toBe(0);

    // Modification : un seul lieu à la fois ; le garage archivé déjà enregistré reste accepté tel quel.
    const restored = await chefA.post(`/suppliers/${garageId}/restore`, { expectedVersion: archived.body.version });
    const ok = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne', garageSupplierId: garageId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await chefA.post(`/suppliers/${garageId}/archive`, { expectedVersion: restored.body.version });
    const immo = (await chefA.get(`/immobilizations/${ok.body.immobilizationId}`)).body;
    const keep = await chefA.patch(`/immobilizations/${immo.id}`, { siteId: null, garageSupplierId: garageId, locationLabel: null, expectedEndAt: '2026-09-25T10:00:00Z', expectedVersion: immo.version });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect(keep.body).toMatchObject({ garageSupplierId: garageId, expectedEndAt: '2026-09-25T10:00:00.000Z' });
    const twoPlaces = await chefA.patch(`/immobilizations/${immo.id}`, { siteId: site.id, garageSupplierId: garageId, locationLabel: null, expectedVersion: keep.body.version });
    expect(twoPlaces.status).toBe(422);
    expect(twoPlaces.body.code).toBe('LIEU_EXCLUSIF');
    const toSite = await chefA.patch(`/immobilizations/${immo.id}`, { siteId: site.id, garageSupplierId: null, locationLabel: null, expectedVersion: keep.body.version });
    expect(toSite.body).toMatchObject({ siteId: site.id, siteName: 'Dépôt Nord', garageSupplierId: null });
  });

  it('D-219 : durée totale = union des causes (heures et jours, une décimale) ; durée propre de chaque cause et mention', async () => {
    const inc = await incident();
    const opened = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne moteur', startedAt: '2026-09-24T08:00:00Z' });
    const immobilizationId = opened.body.immobilizationId as string;
    let immo = (await chefA.get(`/immobilizations/${immobilizationId}`)).body;
    // Cause rétroactive terminée avant la première : le trou entre les deux n'est pas compté.
    const retro = await chefA.post(`/immobilizations/${immobilizationId}/causes`, { reason: 'Attente dépanneuse', startedAt: '2026-09-24T02:00:00Z', expectedVersion: immo.version });
    expect(retro.status, JSON.stringify(retro.body)).toBe(201);
    const retroCause = retro.body.causes.find((c: { reason: string }) => c.reason === 'Attente dépanneuse');
    const ended = await chefA.post(`/immobilizations/${immobilizationId}/causes/${retroCause.id}/end`, { reason: 'Véhicule remorqué', endedAt: '2026-09-24T04:00:00Z', expectedVersion: retro.body.version });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    immo = ended.body;
    // Période 02:00 → 10:00 (8 h), causes 02:00-04:00 et 08:00-maintenant : total 4 h, pas 8 h.
    expect(immo).toMatchObject({ startedAt: '2026-09-24T02:00:00.000Z', durationHours: 4, durationDays: 0.2, causesOverlap: false });
    expect(immo.causeDurationsNote).toContain('La somme des causes peut dépasser le total');

    // Troisième cause superposée : chaque cause garde sa durée propre, le total ne compte la superposition qu'une fois.
    const overlapping = await chefA.post(`/immobilizations/${immobilizationId}/causes`, { reason: 'Expertise assurance', startedAt: '2026-09-24T09:00:00Z', expectedVersion: immo.version });
    t.clock.set('2026-09-24T12:30:00.000Z');
    const later = (await chefA.get(`/immobilizations/${immobilizationId}`)).body;
    expect(later.durationHours).toBe(6.5);
    expect(later.durationDays).toBe(0.3);
    expect(later.causesOverlap).toBe(true);
    const byReason = Object.fromEntries(later.causes.map((c: { reason: string; durationHours: number; durationDays: number }) => [c.reason, [c.durationHours, c.durationDays]]));
    expect(byReason).toEqual({ 'Attente dépanneuse': [2, 0.1], 'Panne moteur': [4.5, 0.2], 'Expertise assurance': [3.5, 0.1] });
    expect(overlapping.status).toBe(201);
    // Même calcul dans la liste.
    const list = await chefA.get(`/immobilizations?vehicleId=${vehicleId}`);
    expect(list.body.items[0]).toMatchObject({ id: immobilizationId, durationHours: 6.5, durationDays: 0.3, causesOverlap: true });
  });

  it('verrou optimiste relu dans la transaction : deux ajouts de cause concurrents sur la même version → un seul accepté', async () => {
    const created = await chefA.post('/immobilizations', { vehicleId, reason: 'Contrôle technique' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, version } = created.body as { id: string; version: number };
    const [a, b] = await Promise.all([
      chefA.post(`/immobilizations/${id}/causes`, { reason: 'Pneus à remplacer', expectedVersion: version }),
      chefA.post(`/immobilizations/${id}/causes`, { reason: 'Freins à contrôler', expectedVersion: version }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe('VERSION_OBSOLETE');
    expect(await t.prisma.client.immobilizationCause.count({ where: { immobilizationId: id } })).toBe(2);
  });

  it('fin d’immobilisation et ajout de cause concurrents sur la même version : jamais de seconde immobilisation ni de cause oubliée', async () => {
    const created = await chefA.post('/immobilizations', { vehicleId, reason: 'Contrôle technique', startedAt: '2026-09-24T08:00:00Z' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, version } = created.body as { id: string; version: number };
    const [ended, added] = await Promise.all([
      chefA.post(`/immobilizations/${id}/end`, { reason: 'Contrôle terminé', expectedVersion: version }),
      chefA.post(`/immobilizations/${id}/causes`, { reason: 'Carrosserie à reprendre', expectedVersion: version }),
    ]);
    // Exactement une des deux opérations aboutit ; l'autre reçoit 409 et doit être relancée après rechargement.
    expect([ended.status, added.status].filter((s) => s === 409)).toHaveLength(1);
    expect(await t.prisma.client.immobilization.count({ where: { vehicleId } })).toBe(1);
    const immo = (await chefA.get(`/immobilizations/${id}`)).body as { status: string; causes: Array<{ endedAt: string | null }> };
    if (ended.status === 200) {
      expect(immo.status).toBe('TERMINEE');
      expect(immo.causes.every((c) => c.endedAt !== null)).toBe(true);
    } else {
      expect(added.status).toBe(201);
      expect(immo).toMatchObject({ status: 'ACTIVE' });
      expect(immo.causes).toHaveLength(2);
    }
  });

  it('immobilisation depuis l’incident et clôture concurrentes : jamais d’incident clôturé avec une cause ouverte', async () => {
    for (let round = 1; round <= 3; round += 1) {
      const inc = await incident(`Panne n° ${round} sur route`);
      const resolved = await chefA.post(`/incidents/${inc.id}/transition`, { to: 'RESOLU', note: 'Dépannage effectué', expectedVersion: 1 });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const [immobilized, closed] = await Promise.all([
        chefA.post(`/incidents/${inc.id}/immobilize`, { reason: `Panne n° ${round}` }),
        chefA.post(`/incidents/${inc.id}/transition`, { to: 'CLOTURE', expectedVersion: resolved.body.version }),
      ]);
      expect([immobilized.status, closed.status].filter((s) => s === 200), JSON.stringify([immobilized.body, closed.body])).toHaveLength(1);
      const status = (await t.prisma.client.incident.findUniqueOrThrow({ where: { id: inc.id } })).status;
      const openCauses = await t.prisma.client.immobilizationCause.count({ where: { incidentId: inc.id, endedAt: null } });
      if (status === 'CLOTURE') {
        expect(openCauses).toBe(0);
        expect(immobilized.body.code).toBe('ETAT_INVALIDE');
      } else {
        expect(openCauses).toBe(1);
        expect(closed.body.code).toBe('CLOTURE_IMPOSSIBLE');
      }
    }
  });

  it('cause ajoutée à une immobilisation active sans lieu ni fin prévue : rien n’est modifié en silence', async () => {
    const created = await chefA.post('/immobilizations', { vehicleId, reason: 'Contrôle technique', garageSupplierId: garageId, expectedEndAt: '2026-09-26T10:00:00Z' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const inc = await incident();
    const added = await chefA.post(`/incidents/${inc.id}/immobilize`, { reason: 'Panne constatée au contrôle' });
    expect(added.body).toMatchObject({ immobilizationId: created.body.id, created: false, placeApplied: false, expectedEndApplied: false });
    expect((await chefA.get(`/immobilizations/${created.body.id}`)).body).toMatchObject({ garageSupplierId: garageId, expectedEndAt: '2026-09-26T10:00:00.000Z' });
  });
});
