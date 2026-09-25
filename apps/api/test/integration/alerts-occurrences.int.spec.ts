import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsService } from '../../src/modules/documents/documents.service.js';
import { ImmobilizationsService } from '../../src/modules/immobilizations/immobilizations.service.js';
import { MaintenancePlansService } from '../../src/modules/maintenance/maintenance-plans.service.js';
import { UsagesService } from '../../src/modules/usages/usages.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

type AlertItem = { id: string; type: string; status: string; severity: string; responsibleUserId: string | null; responsibleName: string; message: string; title: string; actionPath: string };

/**
 * Cycle de vie des occurrences d'alerte (CDC 6.4, 7.3, 9.1, 9.2) : la clôture résout, la récurrence
 * suivante (échéance suivante d'un même plan, document suivant) crée une nouvelle occurrence ; l'incident
 * critique est adressé au responsable de suivi ; une immobilisation compromet les réservations proches.
 */
describe('Alertes : nouvelle occurrence à la récurrence suivante, responsable de suivi, réservation compromise (CDC 6.4, 7.3, 9.1, 9.2)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let vehicleId: string;

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
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'AL-01' });
  });

  async function reading(physicalKm: string, observedAt: string): Promise<string> {
    const res = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.outcome).toBe('ACCEPTE');
    return res.body.reading.id as string;
  }

  async function alertsOf(objectId: string, type: string) {
    return t.prisma.client.alert.findMany({ where: { objectId, type: type as never }, orderBy: { triggeredAt: 'asc' } });
  }

  async function centerItem(agent: Agent, id: string, status: 'ACTIVE' | 'RESOLUE' = 'ACTIVE'): Promise<AlertItem | undefined> {
    const res = await agent.get(`/alerts?status=${status}&pageSize=100`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as AlertItem[]).find((a) => a.id === id);
  }

  it('R-6.4-13 / R-9.2-06 — plan : la clôture résout l’occurrence, l’échéance suivante crée une nouvelle alerte (nouvelle ligne, ancienne conservée résolue)', async () => {
    const typeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '1000', noticeKm: '100', responsibleUserId: f.users.chefA, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '89000', baseDate: '2026-01-10' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const planId = plan.body.id as string;
    const readingId = await reading('90200', '2026-09-24T08:00:00Z');

    const [first] = await alertsOf(planId, 'ENTRETIEN_ECHEANCE');
    expect(first).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE', occurrenceKey: 'echeance:90000:-', responsibleUserId: f.users.chefA });

    // Clôture de l'intervention préventive : l'occurrence de l'échéance 90 000 est résolue.
    const created = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const i = created.body as { id: string; version: number; tasks: Array<{ id: string }> };
    const done = await chefA.post(`/interventions/${i.id}/complete`, { completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version, performedOn: '2026-09-24', acceptedReadingId: readingId }).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const resolved = await t.prisma.client.alert.findUniqueOrThrow({ where: { id: first!.id } });
    expect(resolved.status).toBe('RESOLUE');
    expect(resolved.resolvedAt?.toISOString()).toBe(NOW);
    expect((await chefA.get(`/maintenance-plans/${planId}`)).body).toMatchObject({ status: 'A_JOUR', nextDueKm: '91200' });
    expect(await t.prisma.client.alert.count({ where: { objectId: planId, status: 'ACTIVE' } })).toBe(0);

    // Récurrence suivante : l'échéance 91 200 est dépassée six jours plus tard → nouvelle occurrence.
    t.clock.set('2026-09-30T10:00:00.000Z');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD); // session de 12 h expirée
    await reading('91300', '2026-09-30T08:00:00Z');
    const all = await alertsOf(planId, 'ENTRETIEN_ECHEANCE');
    expect(all).toHaveLength(2);
    const second = all[1]!;
    expect(second.id).not.toBe(first!.id);
    expect(second).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE', occurrenceKey: 'echeance:91200:-', resolvedAt: null, responsibleUserId: f.users.chefA });
    expect(second.triggeredAt.toISOString()).toBe('2026-09-30T10:00:00.000Z');
    // L'ancienne occurrence reste résolue (historique), elle n'est pas réactivée.
    expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('RESOLUE');

    // Le rattrapage ne duplique rien.
    await t.app.get(MaintenancePlansService).recomputeAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { objectId: planId, type: 'ENTRETIEN_ECHEANCE' } })).toBe(2);
    // Centre d'alertes : la nouvelle occurrence est active, l'ancienne figure parmi les résolues.
    expect(await centerItem(chefA, second.id)).toMatchObject({ status: 'ACTIVE', responsibleName: 'Chaima Chef-A', actionPath: `/entretiens?plan=${planId}` });
    expect(await centerItem(chefA, first!.id, 'RESOLUE')).toMatchObject({ status: 'RESOLUE' });
  });

  it('R-9.2-06 — document suivant : le renouvellement résout l’alerte de l’ancienne version ; l’échéance de la nouvelle crée une nouvelle occurrence', async () => {
    const typeId = (await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: false, blocksCheckout: false })).body.id as string;
    const v1 = await chefA.post('/documents', { documentTypeId: typeId, vehicleId, number: 'POL-2025', validFrom: '2025-10-11', validTo: '2026-10-10' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const [first] = await alertsOf(v1.body.id, 'DOCUMENT_ECHEANCE');
    expect(first).toMatchObject({ status: 'ACTIVE', occurrenceKey: 'echeance:2026-10-10', companyId: f.companies.A });

    // Document suivant : la nouvelle version remplace l'échéance de l'ancienne.
    const v2 = await chefA.post('/documents', { documentTypeId: typeId, vehicleId, number: 'POL-2026', validFrom: '2026-09-24', validTo: '2027-10-10' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('RESOLUE');
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE', status: 'ACTIVE', vehicleId } })).toBe(0);

    // Un an plus tard, l'échéance de la nouvelle version approche : nouvelle occurrence (rattrapage quotidien).
    t.clock.set('2027-09-20T08:00:00.000Z');
    await t.app.get(DocumentsService).evaluateAll(f.organizationId);
    const next = await alertsOf(v2.body.id, 'DOCUMENT_ECHEANCE');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ status: 'ACTIVE', occurrenceKey: 'echeance:2027-10-10' });
    expect(next[0]!.id).not.toBe(first!.id);
    expect(next[0]!.triggeredAt.toISOString()).toBe('2027-09-20T08:00:00.000Z');
    expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('RESOLUE');
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE', vehicleId } })).toBe(2);
    // Répéter le rattrapage ne crée pas de doublon.
    await t.app.get(DocumentsService).evaluateAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE', vehicleId } })).toBe(2);
  });

  it('R-7.3-10 — incident critique non traité : alerte adressée au responsable de suivi, qui suit ses changements ; résolue à la prise en charge', async () => {
    const created = await chefA.post('/incidents', { vehicleId, type: 'PANNE', severity: 'CRITIQUE', description: 'Fumée sous le capot, véhicule arrêté', followUpUserId: f.users.operateurA });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const incidentId = created.body.id as string;
    const [alert] = await alertsOf(incidentId, 'INCIDENT_CRITIQUE');
    expect(alert).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE', responsibleUserId: f.users.operateurA, actionPath: `/incidents/${incidentId}`, companyId: f.companies.A });
    expect(await centerItem(chefA, alert!.id)).toMatchObject({ responsibleUserId: f.users.operateurA, responsibleName: 'Omar Opérateur-A' });

    // Nouveau responsable de suivi : la même alerte (pas de doublon) change de responsable.
    const current = (await chefA.get(`/incidents/${incidentId}`)).body as { version: number };
    const reassigned = await chefA.patch(`/incidents/${incidentId}`, { followUpUserId: f.users.chefA, expectedVersion: current.version });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    const alerts = await alertsOf(incidentId, 'INCIDENT_CRITIQUE');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: alert!.id, status: 'ACTIVE', responsibleUserId: f.users.chefA });
    expect(await centerItem(chefA, alert!.id)).toMatchObject({ responsibleName: 'Chaima Chef-A' });

    // Sans responsable de suivi : « Non attribué », jamais un nom inventé.
    const other = await chefA.post('/incidents', { vehicleId, type: 'DOMMAGE', severity: 'CRITIQUE', description: 'Pare-brise éclaté, visibilité nulle' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const [unassigned] = await alertsOf(other.body.id, 'INCIDENT_CRITIQUE');
    expect(unassigned!.responsibleUserId).toBeNull();
    expect(await centerItem(chefA, unassigned!.id)).toMatchObject({ responsibleUserId: null, responsibleName: 'Non attribué' });

    // Prise en charge : condition disparue, alerte résolue.
    const fresh = (await chefA.get(`/incidents/${incidentId}`)).body as { version: number };
    const taken = await chefA.post(`/incidents/${incidentId}/transition`, { to: 'EN_TRAITEMENT', expectedVersion: fresh.version });
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    expect((await t.prisma.client.alert.findUniqueOrThrow({ where: { id: alert!.id } })).status).toBe('RESOLUE');
  });

  it('R-9.1-06 — immobilisation : réservation proche compromise (date locale dans le texte), réservation lointaine au rattrapage, résolution à la fin de l’immobilisation', async () => {
    const driver = await t.prisma.client.driver.findUniqueOrThrow({ where: { id: f.drivers.a1 } });
    const soon = await t.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, startAt: new Date('2026-09-24T14:00:00Z'), endAt: new Date('2026-09-24T18:00:00Z'), purpose: 'Rendez-vous client' } });
    const later = await t.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, startAt: new Date('2026-09-26T07:00:00Z'), endAt: new Date('2026-09-26T16:00:00Z'), purpose: 'Salon professionnel' } });

    const immo = await chefA.post('/immobilizations', { vehicleId, reason: 'Embrayage hors d’usage' });
    expect(immo.status, JSON.stringify(immo.body)).toBe(201);
    const immoId = immo.body.id as string;

    const [compromised] = await alertsOf(soon.id, 'RESERVATION_COMPROMISE');
    expect(compromised).toMatchObject({ status: 'ACTIVE', severity: 'URGENT', companyId: f.companies.A, vehicleId, objectType: 'Reservation', occurrenceKey: `immobilisation:${immoId}`, actionPath: `/planning?reservation=${soon.id}` });
    // Début de la réservation dans le fuseau du groupe (14:00 UTC = 15:00 à Tunis), pas en UTC brut.
    expect(compromised!.message).toBe(`La réservation de ${driver.firstName} ${driver.lastName} du 24/09/2026 à 15:00 est compromise : le véhicule est immobilisé.`);
    expect(compromised!.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Réservation au-delà de 24 h : pas encore d'alerte.
    expect(await alertsOf(later.id, 'RESERVATION_COMPROMISE')).toHaveLength(0);
    expect(await centerItem(chefA, compromised!.id)).toMatchObject({ type: 'RESERVATION_COMPROMISE', status: 'ACTIVE' });

    // Le rattrapage (horizon glissant de 24 h) signale la réservation suivante quand elle approche.
    t.clock.set('2026-09-25T09:00:00.000Z');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD); // session de 12 h expirée
    await t.app.get(ImmobilizationsService).evaluateActive(f.organizationId);
    const [laterAlert] = await alertsOf(later.id, 'RESERVATION_COMPROMISE');
    expect(laterAlert).toMatchObject({ status: 'ACTIVE', severity: 'URGENT' });
    expect(laterAlert!.message).toContain('du 26/09/2026 à 08:00');
    await t.app.get(ImmobilizationsService).evaluateActive(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { type: 'RESERVATION_COMPROMISE', vehicleId } })).toBe(2);

    // Fin de l'immobilisation : les réservations ne sont plus compromises.
    const current = (await chefA.get(`/immobilizations/${immoId}`)).body as { version: number };
    const ended = await chefA.post(`/immobilizations/${immoId}/end`, { reason: 'Embrayage remplacé', expectedVersion: current.version });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(await t.prisma.client.alert.count({ where: { type: 'RESERVATION_COMPROMISE', vehicleId, status: 'ACTIVE' } })).toBe(0);
  });

  it('R-9.1-06 — retard de retour : retour dépassé et réservation suivante compromise, textes datés dans le fuseau du groupe (jamais en UTC brut)', async () => {
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' })).status).toBe(201);
    await t.prisma.client.driverPermit.createMany({ data: [f.drivers.a1, f.drivers.a2].map((driverId) => ({ organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') })) });
    const [d1, d2] = await Promise.all([f.drivers.a1, f.drivers.a2].map((id) => t.prisma.client.driver.findUniqueOrThrow({ where: { id } })));
    const out = await chefA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T09:00:00Z', expectedReturnAt: '2026-09-24T12:00:00Z', purpose: 'Livraison', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt central' }, fuelGauge: 'PLEIN', checklist: [] })
      .set('Idempotency-Key', randomUUID());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const next = await chefA.post('/reservations', { vehicleId, driverId: f.drivers.a2, startAt: '2026-09-24T14:00:00Z', endAt: '2026-09-24T18:00:00Z', purpose: 'Réservation suivante' });
    expect(next.status, JSON.stringify(next.body)).toBe(201);

    t.clock.set('2026-09-24T13:30:00.000Z');
    expect(await t.app.get(UsagesService).evaluateLateReturns(f.organizationId)).toEqual({ late: 1, compromised: 1 });
    const [late] = await alertsOf(out.body.id as string, 'RETOUR_DEPASSE');
    // 12:00 UTC = 13:00 à Tunis ; 14:00 UTC = 15:00 à Tunis.
    expect(late!.message).toBe(`Retour prévu le 24/09/2026 à 13:00 ; ${d1!.firstName} ${d1!.lastName} n’a pas encore restitué le véhicule. L’utilisation reste ouverte.`);
    const [compromised] = await alertsOf(next.body.id as string, 'RESERVATION_COMPROMISE');
    expect(compromised).toMatchObject({ status: 'ACTIVE', severity: 'URGENT', occurrenceKey: out.body.id });
    expect(compromised!.message).toBe(`La réservation de ${d2!.firstName} ${d2!.lastName} du 24/09/2026 à 15:00 est compromise : le véhicule n’est pas encore restitué.`);
    for (const a of [late!, compromised!]) expect(a.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Rattrapage répété : aucun doublon, textes inchangés.
    await t.app.get(UsagesService).evaluateLateReturns(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { vehicleId, type: { in: ['RETOUR_DEPASSE', 'RESERVATION_COMPROMISE'] } } })).toBe(2);
  });
});
