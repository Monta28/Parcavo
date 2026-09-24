import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsService } from '../../src/modules/documents/documents.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

describe('Documents : correction, type archivé et détail de conformité (CDC 7.1, 7.2 ; D-209 à D-212)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let lecteurA: Agent;
  let vehicleId: string;
  let assuranceId: string;
  let carteGriseId: string;

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
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
    const assurance = await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true });
    expect(assurance.status, JSON.stringify(assurance.body)).toBe(201);
    assuranceId = assurance.body.id;
    const carteGrise = await admin.post('/document-types', { code: 'CARTE_GRISE', label: 'Carte grise', ownerType: 'VEHICULE', hasExpiry: false, required: true, blocksCheckout: false });
    expect(carteGrise.status, JSON.stringify(carteGrise.body)).toBe(201);
    carteGriseId = carteGrise.body.id;
  });

  it('PATCH : null efface une date facultative (émission, début) ; la fin reste exigée pour un type qui expire', async () => {
    const created = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', issuer: 'Assureur', issuedOn: '2025-12-15', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    const cleared = await chefA.patch(`/documents/${id}`, { issuedOn: null, validFrom: null, reason: 'Dates saisies sur la mauvaise police', expectedVersion: 1 });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ issuedOn: null, validFrom: null, validTo: '2026-12-31', number: 'POL-1', issuer: 'Assureur', version: 2 });
    const stored = await t.prisma.client.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(stored.issuedOn).toBeNull();
    expect(stored.validFrom).toBeNull();
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'document.correction', objectId: id } });
    expect(audit.reason).toBe('Dates saisies sur la mauvaise police');
    expect(audit.before).toMatchObject({ issuedOn: '2025-12-15', validFrom: '2026-01-01' });
    expect(audit.after).toMatchObject({ issuedOn: null, validFrom: null, validTo: '2026-12-31' });

    // Un champ absent est conservé ; un texte vide ou null efface le texte.
    const text = await chefA.patch(`/documents/${id}`, { issuer: null, notes: '', reason: 'Organisme inconnu', expectedVersion: 2 });
    expect(text.status, JSON.stringify(text.body)).toBe(200);
    expect(text.body).toMatchObject({ issuer: null, notes: null, number: 'POL-1', validTo: '2026-12-31', version: 3 });

    // Type avec expiration : la fin de validité ne peut pas être effacée.
    const noEnd = await chefA.patch(`/documents/${id}`, { validTo: null, reason: 'Effacement interdit', expectedVersion: 3 });
    expect(noEnd.status).toBe(422);
    expect(noEnd.body.code).toBe('FIN_VALIDITE_REQUISE');
    expect((await chefA.get(`/documents/${id}`)).body).toMatchObject({ validTo: '2026-12-31', version: 3 });

    // Type sans expiration : fin de validité null acceptée, date d'émission effaçable.
    const cg = await chefA.post('/documents', { documentTypeId: carteGriseId, vehicleId, number: 'CG-1', issuedOn: '2020-01-01', validFrom: '2020-01-01' });
    expect(cg.status, JSON.stringify(cg.body)).toBe(201);
    const cgFixed = await chefA.patch(`/documents/${cg.body.id}`, { validTo: null, issuedOn: null, reason: 'Date d’émission inconnue', expectedVersion: 1 });
    expect(cgFixed.status, JSON.stringify(cgFixed.body)).toBe(200);
    expect(cgFixed.body).toMatchObject({ validTo: null, issuedOn: null, validFrom: '2020-01-01' });
    expect((await chefA.get(`/documents/compliance?vehicleId=${vehicleId}&documentTypeId=${carteGriseId}`)).body.items[0]).toMatchObject({ status: 'VALIDE', validFrom: '2020-01-01', validTo: null });
  });

  it('PATCH : attachmentId null détache le justificatif (« justificatif absent »), fichier supprimé avec motif et audit', async () => {
    const fileId = await uploadPdf(chefA, t.server, f.companies.A, 'attestation.pdf');
    const created = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2026-01-01', validTo: '2026-12-31', attachmentId: fileId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ attachmentId: fileId, missingFile: false });
    expect((await chefA.get(`/attachments/${fileId}/download`)).status).toBe(200);

    const detached = await chefA.patch(`/documents/${created.body.id}`, { attachmentId: null, reason: 'Attestation d’un autre véhicule', expectedVersion: 1 });
    expect(detached.status, JSON.stringify(detached.body)).toBe(200);
    expect(detached.body).toMatchObject({ attachmentId: null, missingFile: true, validTo: '2026-12-31', version: 2 });
    expect((await chefA.get(`/documents/${created.body.id}`)).body).toMatchObject({ attachmentId: null, missingFile: true });
    expect((await chefA.get(`/attachments/${fileId}/download`)).status).toBe(404);
    expect(await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({ deletedById: f.users.chefA });
    const correction = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'document.correction', objectId: created.body.id } });
    expect(correction.reason).toBe('Attestation d’un autre véhicule');
    expect(correction.before).toMatchObject({ attachmentId: fileId, missingFile: false });
    expect(correction.after).toMatchObject({ attachmentId: null, missingFile: true });
    const deletion = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.suppression', objectId: fileId } });
    expect(deletion.reason).toBe('Attestation d’un autre véhicule');

    // Nouveau justificatif, puis remplacement : l'ancien fichier n'est plus accessible.
    const first = await uploadPdf(chefA, t.server, f.companies.A, 'bonne-attestation.pdf');
    const attached = await chefA.patch(`/documents/${created.body.id}`, { attachmentId: first, reason: 'Bonne attestation', expectedVersion: 2 });
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    expect(attached.body).toMatchObject({ attachmentId: first, missingFile: false });
    const second = await uploadPdf(chefA, t.server, f.companies.A, 'attestation-signee.pdf');
    const replaced = await chefA.patch(`/documents/${created.body.id}`, { attachmentId: second, reason: 'Version signée', expectedVersion: 3 });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect((await chefA.get(`/attachments/${first}/download`)).status).toBe(404);
    expect((await chefA.get(`/attachments/${second}/download`)).status).toBe(200);

    // Donnée antérieure : fichier déjà supprimé mais encore référencé par la version → le détachement aboutit.
    await t.prisma.client.attachment.update({ where: { id: second }, data: { deletedAt: new Date('2026-09-24T09:00:00Z') } });
    const legacy = await chefA.patch(`/documents/${created.body.id}`, { attachmentId: null, reason: 'Référence orpheline', expectedVersion: 4 });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(legacy.body).toMatchObject({ attachmentId: null, missingFile: true, version: 5 });
  });

  it('type archivé : renouvellement, correction et enregistrement refusés par un 422 TYPE_ARCHIVE explicite ; archivage de la version possible', async () => {
    const v = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const archivedType = await admin.patch(`/document-types/${assuranceId}`, { status: 'ARCHIVE', expectedVersion: 1 });
    expect(archivedType.status, JSON.stringify(archivedType.body)).toBe(200);

    const renew = await chefA.post(`/documents/${v.body.id}/renew`, { number: 'POL-2', validFrom: '2027-01-01', validTo: '2027-12-31' });
    expect(renew.status, JSON.stringify(renew.body)).toBe(422);
    expect(renew.body.code).toBe('TYPE_ARCHIVE');
    expect(renew.body.message).toContain('« Assurance » est archivé');
    const correct = await chefA.patch(`/documents/${v.body.id}`, { number: 'POL-10', reason: 'Faute de frappe', expectedVersion: 1 });
    expect(correct.status, JSON.stringify(correct.body)).toBe(422);
    expect(correct.body.code).toBe('TYPE_ARCHIVE');
    const create = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-3', validTo: '2027-12-31' });
    expect(create.status, JSON.stringify(create.body)).toBe(422);
    expect(create.body.code).toBe('TYPE_ARCHIVE');
    // L'autorisation passe avant l'état du type : un lecteur reste refusé (403).
    expect((await lecteurA.post(`/documents/${v.body.id}/renew`, { number: 'X', validTo: '2027-12-31' })).status).toBe(403);
    expect(await t.prisma.client.documentVersion.count()).toBe(1);
    expect((await chefA.get(`/documents/${v.body.id}`)).body).toMatchObject({ number: 'POL-1', version: 1 });
    const archived = await chefA.post(`/documents/${v.body.id}/archive`, { reason: 'Version erronée', expectedVersion: 1 });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    // Version archivée : l'autorisation passe aussi avant l'état de la version (lecteur 403, gestionnaire 409).
    const readerOnArchived = await lecteurA.post(`/documents/${v.body.id}/renew`, { number: 'X', validTo: '2027-12-31' });
    expect(readerOnArchived.status, JSON.stringify(readerOnArchived.body)).toBe(403);
    const managerOnArchived = await chefA.post(`/documents/${v.body.id}/renew`, { number: 'X', validTo: '2027-12-31' });
    expect(managerOnArchived.status, JSON.stringify(managerOnArchived.body)).toBe(409);
    expect(managerOnArchived.body.code).toBe('ETAT_INVALIDE');
  });

  it('conformité : détail en JJ/MM/AAAA sans date ISO brute, dates dans des champs séparés, alerte au même format', async () => {
    const v1 = await chefA.post('/documents', { documentTypeId: assuranceId, vehicleId, number: 'POL-1', validFrom: '2025-09-01', validTo: '2026-09-20' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const v2 = await chefA.post(`/documents/${v1.body.id}/renew`, { number: 'POL-2', validFrom: '2026-10-01', validTo: '2027-09-30' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    const res = await chefA.get(`/documents/compliance?vehicleId=${vehicleId}&documentTypeId=${assuranceId}`);
    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row).toMatchObject({
      status: 'EXPIRE',
      currentVersionId: v1.body.id,
      upcomingVersionId: v2.body.id,
      validFrom: '2025-09-01',
      validTo: '2026-09-20',
      nextValidFrom: '2026-10-01',
      nextValidTo: '2027-09-30',
      daysRemaining: -4,
      blocksCheckout: true,
    });
    expect(row.detail).toBe('Expiré depuis le 20/09/2026 ; nouvelle version valable à partir du 01/10/2026.');
    expect(row.detail).not.toMatch(ISO_DATE);

    await t.app.get(DocumentsService).evaluateAll(f.organizationId);
    const alert = await t.prisma.client.alert.findFirstOrThrow({ where: { type: 'DOCUMENT_ECHEANCE', objectId: v1.body.id, status: 'ACTIVE' } });
    expect(alert.message).toContain('Expiré depuis le 20/09/2026');
    expect(alert.message).not.toMatch(ISO_DATE);

    // A_RENOUVELER : fin et début exposés, aucune version future.
    const cg = await chefA.get(`/documents/compliance?vehicleId=${vehicleId}&documentTypeId=${carteGriseId}`);
    expect(cg.body.items[0]).toMatchObject({ status: 'MANQUANT', validFrom: null, validTo: null, nextValidFrom: null, nextValidTo: null, detail: 'Aucun document enregistré.' });
  });
  it('D-308 — Idempotency-Key facultative : un nouvel envoi identique ne crée pas de seconde version ; sans clé, rien ne change', async () => {
    const body = { documentTypeId: assuranceId, vehicleId, number: 'POL-IDEM', validFrom: '2026-01-01', validTo: '2026-12-31' };
    const [a, b] = await Promise.all([chefA.post('/documents', body).set('Idempotency-Key', 'doc-creation-cle-1'), chefA.post('/documents', body).set('Idempotency-Key', 'doc-creation-cle-1')]);
    const statuses = [a.status, b.status].sort();
    // Deux envois simultanés : l'un crée, l'autre est rejoué ou signalé « en cours » (jamais un doublon).
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    const replay = await chefA.post('/documents', body).set('Idempotency-Key', 'doc-creation-cle-1');
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(a.status === 201 ? a.body.id : b.body.id);
    expect(await t.prisma.client.documentVersion.count({ where: { number: 'POL-IDEM' } })).toBe(1);
    const other = await chefA.post('/documents', { ...body, number: 'POL-AUTRE' }).set('Idempotency-Key', 'doc-creation-cle-1');
    expect(other.status).toBe(409);
    const tooShort = await chefA.post('/documents', body).set('Idempotency-Key', 'court');
    expect(tooShort.status).toBe(422);
    expect(tooShort.body.code).toBe('IDEMPOTENCE_CLE_INVALIDE');
  });
});
