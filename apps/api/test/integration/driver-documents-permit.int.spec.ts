import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

/**
 * Documents conducteur, permis et incidents (CDC 3.3, 7.1, 7.2, 7.3) : justificatifs personnels privés entre
 * conducteurs, contrôle du permis et des justificatifs conducteur au départ selon le seul paramétrage de
 * l'organisation, et types d'incident.
 */
describe('Documents conducteur, permis au départ et types d’incident (CDC 3.3, 7.1–7.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
  let conducteur: Agent;
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
    conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    expect((await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' })).status).toBe(201);
  });

  const checkoutBody = (driverId: string, at = '2026-09-24T09:00:00Z', km = '10100') => ({ vehicleId, driverId, checkedOutAt: at, expectedReturnAt: new Date(new Date(at).getTime() + 9 * 3600_000).toISOString(), purpose: 'Mission client', reading: { physicalKm: km }, location: { placeLabel: 'Dépôt' } });
  const checkout = (agent: Agent, body: Record<string, unknown>) => agent.post('/usages/checkout', body).set('Idempotency-Key', randomUUID());
  const blockerCodes = (body: { details?: { blockers?: Array<{ code: string }> } }) => (body.details?.blockers ?? []).map((b) => b.code);
  const validPermit = (driverId: string, categories = ['B'], expiresOn = '2030-01-01') => t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId, number: `P-${driverId.slice(0, 6)}`, categories, expiresOn: new Date(`${expiresOn}T00:00:00Z`) } });

  it('R-7.1-12 — un conducteur ne télécharge ni le justificatif de document ni le scan de permis d’un autre conducteur ; les siens oui', async () => {
    const type = await admin.post('/document-types', { code: 'AUTORISATION_CONDUCTEUR', label: 'Autorisation de conduite', ownerType: 'CONDUCTEUR', hasExpiry: true, required: false, blocksCheckout: false, visibleToDriver: true });
    expect(type.status).toBe(201);
    const otherFile = await uploadPdf(chefA, t.server, f.companies.A, 'autorisation-a2.pdf');
    const otherDoc = await chefA.post('/documents', { documentTypeId: type.body.id, driverId: f.drivers.a2, number: 'AUT-A2', validFrom: '2026-01-01', validTo: '2027-01-01', attachmentId: otherFile });
    expect(otherDoc.status, JSON.stringify(otherDoc.body)).toBe(201);
    const ownFile = await uploadPdf(chefA, t.server, f.companies.A, 'autorisation-a1.pdf');
    const ownDoc = await chefA.post('/documents', { documentTypeId: type.body.id, driverId: f.drivers.a1, number: 'AUT-A1', validFrom: '2026-01-01', validTo: '2027-01-01', attachmentId: ownFile });
    expect(ownDoc.status).toBe(201);
    const otherScan = await uploadPdf(chefA, t.server, f.companies.A, 'permis-a2.pdf');
    expect((await chefA.put(`/drivers/${f.drivers.a2}/permit`, { number: 'P-A2', categories: ['B'], attachmentId: otherScan })).status).toBe(200);
    const ownScan = await uploadPdf(chefA, t.server, f.companies.A, 'permis-a1.pdf');
    expect((await chefA.put(`/drivers/${f.drivers.a1}/permit`, { number: 'P-A1', categories: ['B'], attachmentId: ownScan })).status).toBe(200);

    // Justificatifs personnels d'autrui : 404 (existence non révélée), fiche du document comprise.
    expect((await conducteur.get(`/attachments/${otherFile}/download`)).status).toBe(404);
    expect((await conducteur.get(`/attachments/${otherScan}/download`)).status).toBe(404);
    expect((await conducteur.get(`/documents/${otherDoc.body.id}`)).status).toBe(404);
    expect((await conducteur.get(`/documents?driverId=${f.drivers.a2}`)).body.items ?? []).toEqual([]);
    // Ses propres justificatifs : téléchargeables.
    const own = await conducteur.get(`/attachments/${ownFile}/download`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect((await conducteur.get(`/attachments/${ownScan}/download`)).status).toBe(200);
    // Le personnel de la société y accède.
    expect((await chefA.get(`/attachments/${otherFile}/download`)).status).toBe(200);
  });

  it('R-3.3-X01 — sans paramétrage (catégorie sans permis exigé, aucun justificatif bloquant) : aucun contrôle inventé, départ accepté sans permis', async () => {
    const free = await t.prisma.client.vehicleCategory.create({ data: { organizationId: f.organizationId, code: 'ENGIN', label: 'Engin de manutention', requiredPermitCategories: [] } });
    await t.prisma.client.vehicle.update({ where: { id: vehicleId }, data: { categoryId: free.id } });
    expect(await t.prisma.client.driverPermit.count({ where: { driverId: f.drivers.a2 } })).toBe(0);
    const res = await checkout(operateurA, checkoutBody(f.drivers.a2));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.documentOverrideReason ?? null).toBeNull();
  });

  it('R-3.3-X01 — permis exigé par la catégorie : absent, expiré ou d’une autre catégorie → départ refusé ; dérogation motivée du chef seulement, auditée', async () => {
    // Catégorie VP (fixture) : permis B exigé. a2 sans permis.
    const none = await checkout(operateurA, checkoutBody(f.drivers.a2));
    expect(none.status).toBe(422);
    expect(blockerCodes(none.body)).toContain('PERMIS_NON_CONFORME');
    await validPermit(f.drivers.a2, ['C'], '2030-01-01');
    expect(blockerCodes((await checkout(operateurA, checkoutBody(f.drivers.a2))).body)).toContain('PERMIS_NON_CONFORME');
    await t.prisma.client.driverPermit.updateMany({ where: { driverId: f.drivers.a2 }, data: { categories: ['B'], expiresOn: new Date('2026-09-23T00:00:00Z') } });
    const expired = await checkout(operateurA, checkoutBody(f.drivers.a2));
    expect(expired.status).toBe(422);
    expect(blockerCodes(expired.body)).toContain('PERMIS_NON_CONFORME');
    // L'opérateur n'a pas exceptions.override : sa dérogation est refusée.
    const opOverride = await checkout(operateurA, { ...checkoutBody(f.drivers.a2), overrideReason: 'Permis en cours de renouvellement' });
    expect([403, 422]).toContain(opOverride.status);
    expect(await t.prisma.client.vehicleUsage.count()).toBe(0);
    const chefOverride = await checkout(chefA, { ...checkoutBody(f.drivers.a2), overrideReason: 'Récépissé de renouvellement présenté' });
    expect(chefOverride.status, JSON.stringify(chefOverride.body)).toBe(201);
    expect(chefOverride.body.documentOverrideReason).toBe('Récépissé de renouvellement présenté');
    // La dérogation ne modifie pas le permis (ni l'expiration, ni la règle).
    const permit = await t.prisma.client.driverPermit.findFirstOrThrow({ where: { driverId: f.drivers.a2 } });
    expect(permit.expiresOn?.toISOString().slice(0, 10)).toBe('2026-09-23');
    expect(await t.prisma.client.auditEvent.count({ where: { objectId: chefOverride.body.id, reason: 'Récépissé de renouvellement présenté' } })).toBeGreaterThanOrEqual(1);
  });

  it('R-3.3-X01 — justificatif conducteur paramétré bloquant (type CONDUCTEUR) : départ refusé tant qu’il manque, accepté une fois valide ; restitution toujours possible', async () => {
    await validPermit(f.drivers.a1);
    const type = await admin.post('/document-types', { code: 'AUTORISATION_CONDUCTEUR', label: 'Autorisation de conduite', ownerType: 'CONDUCTEUR', hasExpiry: true, required: true, blocksCheckout: true });
    expect(type.status).toBe(201);
    const refused = await checkout(operateurA, checkoutBody(f.drivers.a1));
    expect(refused.status).toBe(422);
    const blocker = refused.body.details.blockers.find((b: { code: string }) => b.code === 'DOCUMENT_BLOQUANT');
    expect(blocker).toMatchObject({ overridable: true });
    expect(blocker.message).toContain('Autorisation de conduite (conducteur)');
    expect(blockerCodes(refused.body)).not.toContain('PERMIS_NON_CONFORME');
    // Justificatif valide jusqu'au 24/09 inclus (fin de journée locale) : départ accepté.
    const doc = await chefA.post('/documents', { documentTypeId: type.body.id, driverId: f.drivers.a1, number: 'AUT-1', validFrom: '2026-01-01', validTo: '2026-09-24' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const ok = await checkout(operateurA, checkoutBody(f.drivers.a1));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // Le lendemain, le justificatif est expiré : la restitution reste autorisée, un nouveau départ non.
    t.clock.set('2026-09-25T09:00:00.000Z');
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    const back = await operateurA.post(`/usages/${ok.body.id}/return`, { returnedAt: '2026-09-25T08:30:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt' }, expectedVersion: ok.body.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const again = await checkout(operateurA, checkoutBody(f.drivers.a1, '2026-09-25T08:45:00Z', '10160'));
    expect(again.status).toBe(422);
    expect(blockerCodes(again.body), JSON.stringify(again.body)).toContain('DOCUMENT_BLOQUANT');
  });

  it('R-7.3-01 — les sept types d’incident sont acceptés (dont anomalie compteur et autre) ; tout autre type est refusé', async () => {
    const types = ['PANNE', 'DOMMAGE', 'ACCIDENT', 'CREVAISON', 'ANOMALIE_COMPTEUR', 'CONTRAVENTION', 'AUTRE'];
    for (const type of types) {
      const res = await chefA.post('/incidents', { vehicleId, type, description: `Déclaration de type ${type}` });
      expect(res.status, `${type} : ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.type).toBe(type);
    }
    expect((await chefA.post('/incidents', { vehicleId, type: 'VOL', description: 'Type hors liste' })).status).toBe(422);
    // Déclaration conducteur d'une anomalie compteur sur son utilisation.
    await validPermit(f.drivers.a1);
    const usage = await checkout(chefA, checkoutBody(f.drivers.a1));
    expect(usage.status, JSON.stringify(usage.body)).toBe(201);
    const anomaly = await conducteur.post('/incidents', { type: 'ANOMALIE_COMPTEUR', description: 'Le compteur affiche une valeur incohérente' });
    expect(anomaly.status, JSON.stringify(anomaly.body)).toBe(201);
    expect(anomaly.body).toMatchObject({ type: 'ANOMALIE_COMPTEUR', vehicleId, usageId: usage.body.id, status: 'OUVERT' });
    const other = await conducteur.post('/incidents', { type: 'AUTRE', description: 'Rétroviseur mal réglé à la prise' });
    expect(other.status).toBe(201);
    expect(await t.prisma.client.incident.count({ where: { type: { in: ['ANOMALIE_COMPTEUR', 'AUTRE'] } } })).toBe(4);
  });
});
