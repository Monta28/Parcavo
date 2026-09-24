import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsService } from '../../src/modules/documents/documents.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Documents et conformité (CDC 7.1, 7.2 — T21, T22)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let assuranceId: string;

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
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    const type = await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, visibleToDriver: true });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    expect(type.body.noticeDays).toEqual([30, 15, 7]);
    assuranceId = type.body.id;
  });

  const status = async (agent: Agent = chefA) => (await agent.get(`/documents/compliance?vehicleId=${vehicleId}&documentTypeId=${assuranceId}`)).body.items[0];

  it('paramétrage réservé à l’administrateur ; un document bloquant est requis ; pas de date de fin sans expiration', async () => {
    expect((await chefA.post('/document-types', { code: 'VIGNETTE', label: 'Vignette', ownerType: 'VEHICULE', hasExpiry: true, required: false, blocksCheckout: false })).status).toBe(403);
    const bad = await admin.post('/document-types', { code: 'X', label: 'Incohérent', ownerType: 'VEHICULE', hasExpiry: true, required: false, blocksCheckout: true });
    expect(bad.body.code).toBe('BLOQUANT_IMPLIQUE_REQUIS');
    const carteGrise = await admin.post('/document-types', { code: 'CARTE_GRISE', label: 'Carte grise', ownerType: 'VEHICULE', hasExpiry: false, required: true, blocksCheckout: false });
    const withEnd = await chefA.post('/documents', { documentTypeId: carteGrise.body.id, vehicleId, number: 'CG-1', validTo: '2030-01-01' });
    expect(withEnd.body.code).toBe('SANS_EXPIRATION');
    const ok = await chefA.post('/documents', { documentTypeId: carteGrise.body.id, vehicleId, number: 'CG-1', issuedOn: '2020-01-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.missingFile).toBe(true);
    const row = (await chefA.get(`/documents/compliance?vehicleId=${vehicleId}&documentTypeId=${carteGrise.body.id}`)).body.items[0];
    expect(row).toMatchObject({ status: 'VALIDE', validTo: null });
    // Aucun document sans expiration ne produit d'alerte d'échéance.
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE' } })).toBe(0);
  });

  it('absence d’un document requis : MANQUANT et alerte dédiée, résolue à l’enregistrement', async () => {
    expect(await status()).toMatchObject({ status: 'MANQUANT', blocksCheckout: true });
    // Rattrapage : l'alerte existe une seule fois, même relancé.
    const docs = t.app.get(DocumentsService);
    await docs.evaluateAll(f.organizationId);
    await docs.evaluateAll(f.organizationId);
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_MANQUANT', objectId: vehicleId, status: 'ACTIVE' } })).toBe(1);
    await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', issuer: 'Assureur', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(await status()).toMatchObject({ status: 'VALIDE' });
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_MANQUANT', objectId: vehicleId, status: 'ACTIVE' } })).toBe(0);
  });

  it('T21 — fin de validité aujourd’hui : valable jusqu’à la fin du jour local, expiré le lendemain, puis valide à l’entrée en vigueur du renouvellement futur', async () => {
    const v1 = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2025-09-25', validTo: '2026-09-24' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    // 24/09 22:30 à Tunis (21:30 UTC) : encore valable ce soir.
    t.clock.set('2026-09-24T21:30:00.000Z');
    const docs = t.app.get(DocumentsService);
    await docs.evaluateAll(f.organizationId);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    expect(await status(admin)).toMatchObject({ status: 'A_RENOUVELER', daysRemaining: 0, blocksCheckout: false });
    let alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DOCUMENT_ECHEANCE', objectId: v1.body.id, status: 'ACTIVE' } });
    expect(alert.severity).toBe('URGENT');
    // Renouvellement futur (à partir du 26/09) : ne remplace pas la version en cours.
    const v2 = await admin.post(`/documents/${v1.body.id}/renew`, { number: 'POL-2', validFrom: '2026-09-26', validTo: '2027-09-25' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body.previousVersionId).toBe(v1.body.id);
    // 25/09 00:00 locale : expiré (trou d'un jour), bloquant, malgré la version future.
    t.clock.set('2026-09-24T23:00:00.000Z');
    await docs.evaluateAll(f.organizationId);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const expired = await status(admin);
    expect(expired).toMatchObject({ status: 'EXPIRE', blocksCheckout: true, upcomingVersionId: v2.body.id });
    expect(expired.detail).toBe('Expiré depuis le 24/09/2026 ; nouvelle version valable à partir du 26/09/2026.');
    expect(expired).toMatchObject({ validFrom: '2025-09-25', validTo: '2026-09-24', nextValidFrom: '2026-09-26', nextValidTo: '2027-09-25' });
    alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DOCUMENT_ECHEANCE', objectId: v1.body.id, status: 'ACTIVE' } });
    expect(alert.severity).toBe('CRITIQUE');
    // 26/09 : la nouvelle version entre en vigueur ; l'alerte est résolue.
    t.clock.set('2026-09-25T23:00:00.000Z');
    await docs.evaluateAll(f.organizationId);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    expect(await status(admin)).toMatchObject({ status: 'VALIDE', currentVersionId: v2.body.id });
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE', status: 'ACTIVE' } })).toBe(0);
  });

  it('paliers de préavis 30/15/7 : une seule alerte dont la gravité monte ; renouvellement sans trou → alerte résolue', async () => {
    const v1 = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2025-10-20', validTo: '2026-10-20' });
    const docs = t.app.get(DocumentsService);
    await docs.evaluateAll(f.organizationId);
    let alerts = await t.prisma.client.alert.findMany({ where: { type: 'DOCUMENT_ECHEANCE', objectId: v1.body.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('INFO');
    t.clock.set('2026-10-10T10:00:00.000Z');
    await docs.evaluateAll(f.organizationId);
    t.clock.set('2026-10-15T10:00:00.000Z');
    await docs.evaluateAll(f.organizationId);
    alerts = await t.prisma.client.alert.findMany({ where: { type: 'DOCUMENT_ECHEANCE', objectId: v1.body.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('URGENT');
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    await chefA.post(`/documents/${v1.body.id}/renew`, { number: 'POL-2', validFrom: '2026-10-21', validTo: '2027-10-20' });
    const row = await status();
    expect(row).toMatchObject({ status: 'VALIDE', renewed: true });
    expect(await t.prisma.client.alert.count({ where: { type: 'DOCUMENT_ECHEANCE', status: 'ACTIVE' } })).toBe(0);
  });

  it('T22 — document bloquant expiré : départ refusé, dérogation motivée du chef, restitution toujours possible', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '10000' });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-1', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-0', validFrom: '2025-09-01', validTo: '2026-09-23' });
    const body = { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T09:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission client', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' } };
    const refused = await operateurA.post('/usages/checkout', body).set('Idempotency-Key', randomUUID());
    expect(refused.status).toBe(422);
    expect(refused.body.details.blockers.map((b: { code: string }) => b.code)).toContain('DOCUMENT_BLOQUANT');
    const override = await chefA.post('/usages/checkout', { ...body, overrideReason: 'Attestation provisoire reçue' }).set('Idempotency-Key', randomUUID());
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    const back = await operateurA.post(`/usages/${override.body.id}/return`, { returnedAt: '2026-09-24T09:30:00Z', reading: { physicalKm: '10150' }, location: { placeLabel: 'Dépôt' }, expectedVersion: override.body.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // Portée : un type restreint à une autre société ne bloque pas.
    await admin.patch(`/document-types/${assuranceId}`, { companyIds: [f.companies.B], expectedVersion: 1 });
    const allowed = await operateurA.post('/usages/checkout', { ...body, checkedOutAt: '2026-09-24T09:40:00Z', reading: { physicalKm: '10160' } }).set('Idempotency-Key', randomUUID());
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it('correction en place motivée et auditée, archivage d’une version erronée, verrou optimiste', async () => {
    const v = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1O', validFrom: '2026-01-01', validTo: '2026-12-31' });
    const fixed = await operateurA.patch(`/documents/${v.body.id}`, { number: 'POL-10', reason: 'Faute de frappe', expectedVersion: 1 });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ number: 'POL-10', validTo: '2026-12-31', version: 2 });
    expect((await operateurA.patch(`/documents/${v.body.id}`, { number: 'X', reason: 'Conflit', expectedVersion: 1 })).status).toBe(409);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'document.correction', objectId: v.body.id } });
    expect(audit.reason).toBe('Faute de frappe');
    const archived = await chefA.post(`/documents/${v.body.id}/archive`, { reason: 'Version saisie sur le mauvais véhicule', expectedVersion: 2 });
    expect(archived.body.archivedAt).not.toBeNull();
    expect(await t.prisma.client.documentVersion.count({ where: { id: v.body.id } })).toBe(1);
    expect(await status()).toMatchObject({ status: 'MANQUANT' });
  });

  it('cloisonnement et conducteur : documents visibles du véhicule en cours uniquement', async () => {
    const v = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect((await chefB.get(`/documents/${v.body.id}`)).status).toBe(404);
    expect((await chefB.get('/documents')).body.total).toBe(0);
    expect((await chefB.get('/documents/compliance')).body.items.every((r: { companyId: string }) => r.companyId !== f.companies.A)).toBe(true);
    expect((await chefB.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'X', validTo: '2027-01-01' })).status).toBe(404);
    const lecteur = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    expect((await lecteur.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'X', validTo: '2027-01-01' })).status).toBe(403);

    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.get(`/documents?vehicleId=${vehicleId}`)).body.total).toBe(0);
    expect((await conducteur.get(`/documents/${v.body.id}`)).status).toBe(404);
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:00:00Z'), expectedReturnAt: new Date('2026-09-24T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const visible = await conducteur.get(`/documents?vehicleId=${vehicleId}`);
    expect(visible.body.total).toBe(1);
    expect((await conducteur.get(`/documents/${v.body.id}`)).status).toBe(200);
    expect((await conducteur.get('/documents/compliance')).status).toBe(403);
  });
});
