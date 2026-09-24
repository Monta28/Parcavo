import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function uploadPng(agent: Agent, server: TestApp['server'], companyId: string): Promise<string> {
  const res = await request(server).post('/api/v1/attachments').set('Cookie', agent.cookies).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', agent.csrf).field('companyId', companyId).attach('file', PNG_1x1, 'photo.png');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe('Suppression d’une pièce jointe : droit de gestion du propriétaire et référence métier détachée (CDC 16.2, 7.1 ; D-209, D-210)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;
  let vehicleId: string;

  const remove = (agent: Agent, id: string, reason = 'Fichier erroné') => agent.delete(`/attachments/${id}`).send({ reason });

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
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A');
  });

  it('justificatif de document : lecteur et opérateur sans documents.manage refusés (403) ; suppression par un gestionnaire → « justificatif absent », téléchargement 404, audit motivé', async () => {
    const type = await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, visibleToDriver: true });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const fileId = await uploadPdf(chefA, t.server, f.companies.A, 'attestation.pdf');
    const doc = await chefA.post('/documents', { documentTypeId: type.body.id, vehicleId, number: 'POL-1', validFrom: '2026-01-01', validTo: '2026-12-31', attachmentId: fileId });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    expect(doc.body).toMatchObject({ attachmentId: fileId, missingFile: false, version: 1 });

    // Lecture seule : le lecteur voit le document et télécharge le fichier, mais ne le supprime pas.
    expect((await lecteurA.get(`/attachments/${fileId}/download`)).status).toBe(200);
    const byReader = await remove(lecteurA, fileId);
    expect(byReader.status, JSON.stringify(byReader.body)).toBe(403);
    expect(byReader.body.code).toBe('ACTION_INTERDITE');
    // Opérateur privé de documents.manage : refusé aussi.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.operateurA }, data: { revokedPermissions: ['DOCUMENTS_MANAGE'] } });
    const byOperator = await remove(operateurA, fileId);
    expect(byOperator.status, JSON.stringify(byOperator.body)).toBe(403);
    expect(byOperator.body.message).toContain('documents.manage');
    // Hors périmètre ou conducteur sans accès : introuvable.
    expect((await remove(chefB, fileId)).status).toBe(404);
    expect((await remove(conducteurA, fileId)).status).toBe(404);
    expect((await chefA.get(`/documents/${doc.body.id}`)).body).toMatchObject({ attachmentId: fileId, missingFile: false, version: 1 });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'piece_jointe.suppression' } })).toBe(0);

    // Gestionnaire (documents.manage) : suppression et détachement dans la même transaction.
    const ok = await remove(chefA, fileId, 'Attestation d’un autre véhicule');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await chefA.get(`/documents/${doc.body.id}`);
    expect(after.body).toMatchObject({ attachmentId: null, missingFile: true, version: 2 });
    const listed = await chefA.get(`/documents?vehicleId=${vehicleId}`);
    expect(listed.body.items[0]).toMatchObject({ id: doc.body.id, missingFile: true });
    expect((await chefA.get(`/attachments/${fileId}/download`)).status).toBe(404);
    expect((await lecteurA.get(`/attachments/${fileId}/download`)).status).toBe(404);
    expect(await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({ deletedById: f.users.chefA });
    const deletion = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.suppression', objectId: fileId } });
    expect(deletion.reason).toBe('Attestation d’un autre véhicule');
    expect(deletion.after).toMatchObject({ detachedFrom: [{ objectType: 'DocumentVersion', objectId: doc.body.id }] });
    const detach = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.detachement', objectId: doc.body.id } });
    expect(detach).toMatchObject({ objectType: 'DocumentVersion', reason: 'Attestation d’un autre véhicule', companyId: f.companies.A });
    // Le statut ne dépend que des dates (D-210) ; la version a changé : une correction sur l'ancienne version est refusée.
    expect((await chefA.get(`/documents/compliance?vehicleId=${vehicleId}`)).body.items[0]).toMatchObject({ status: 'VALIDE' });
    expect((await chefA.patch(`/documents/${doc.body.id}`, { number: 'POL-10', reason: 'Faute de frappe', expectedVersion: 1 })).status).toBe(409);
    // Seconde suppression : déjà supprimée.
    expect((await remove(chefA, fileId)).status).toBe(404);
  });

  it('concurrence : suppression du justificatif et correction qui le remplace, en parallèle → un seul gagnant, jamais d’erreur serveur ni d’état incohérent', async () => {
    const type = await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const pairs: Array<{ docId: string; oldFile: string; newFile: string }> = [];
    for (let i = 0; i < 8; i += 1) {
      const oldFile = await uploadPdf(chefA, t.server, f.companies.A, `ancien-${i}.pdf`);
      const newFile = await uploadPdf(chefA, t.server, f.companies.A, `nouveau-${i}.pdf`);
      const doc = await chefA.post('/documents', { documentTypeId: type.body.id, vehicleId, number: `POL-${i}`, validFrom: '2026-01-01', validTo: '2026-12-31', attachmentId: oldFile });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
      pairs.push({ docId: doc.body.id as string, oldFile, newFile });
    }
    const results = await Promise.all(
      pairs.map(async (p) => {
        const [deletion, correction] = await Promise.all([remove(chefA, p.oldFile, 'Fichier erroné'), chefA.patch(`/documents/${p.docId}`, { attachmentId: p.newFile, reason: 'Attestation signée', expectedVersion: 1 })]);
        return { ...p, deletion, correction };
      }),
    );
    for (const r of results) {
      expect([200, 404], JSON.stringify(r.deletion.body)).toContain(r.deletion.status);
      expect([200, 409], JSON.stringify(r.correction.body)).toContain(r.correction.status);
      // Exactement une des deux opérations aboutit ; l'autre voit l'état validé par la première.
      expect([r.deletion.status, r.correction.status].filter((s) => s === 200)).toHaveLength(1);
      const doc = await t.prisma.client.documentVersion.findUniqueOrThrow({ where: { id: r.docId } });
      const oldFile = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: r.oldFile } });
      const newFile = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: r.newFile } });
      expect(oldFile.deletedAt).not.toBeNull();
      expect(doc.version).toBe(2);
      if (r.correction.status === 200) {
        expect(doc.attachmentId).toBe(r.newFile);
        expect(newFile).toMatchObject({ deletedAt: null, ownerType: 'DOCUMENT', ownerId: r.docId });
        expect((await chefA.get(`/attachments/${r.newFile}/download`)).status).toBe(200);
      } else {
        expect(doc.attachmentId).toBeNull();
        expect(newFile).toMatchObject({ deletedAt: null, ownerId: null });
      }
      expect(await t.prisma.client.auditEvent.count({ where: { action: 'piece_jointe.suppression', objectId: r.oldFile } })).toBe(1);
    }
  });

  it('intervention et relevé : bon d’intervention supprimable par l’opérateur ; preuve du relevé réservée à readings.correct et détachée du relevé', async () => {
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-06-01T08:00:00Z' })).status).toBe(201);
    const created = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Contrôle freins' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bon = await uploadPdf(chefA, t.server, f.companies.A, 'bon-travaux.pdf');
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'compteur.pdf');
    const done = await chefA
      .post(`/interventions/${created.body.id}/complete`, {
        completedTaskIds: created.body.tasks.map((x: { id: string }) => x.id),
        expectedVersion: created.body.version,
        performedOn: '2026-09-24',
        newReading: { physicalKm: '90300', observedAt: '2026-09-24T09:00:00Z', attachmentId: photo },
        attachmentIds: [bon],
      })
      .set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const view = (await chefA.get(`/interventions/${created.body.id}`)).body;
    expect(view.attachments.map((a: { id: string }) => a.id)).toEqual([bon, photo]);
    const readingId = view.performedReadingId as string;
    expect(await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: readingId } })).toMatchObject({ attachmentId: photo });

    // Bon d'intervention : lisible par un lecteur doté de costs.read, mais la suppression exige le rôle opérationnel.
    expect((await remove(lecteurA, bon)).status).toBe(404);
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.lecteurA }, data: { grantedPermissions: ['COSTS_READ'] } });
    expect((await lecteurA.get(`/attachments/${bon}/download`)).status).toBe(200);
    const byReader = await remove(lecteurA, bon);
    expect(byReader.status, JSON.stringify(byReader.body)).toBe(403);
    expect(byReader.body.code).toBe('ACTION_INTERDITE');
    const byOperator = await remove(operateurA, bon, 'Bon d’un autre véhicule');
    expect(byOperator.status, JSON.stringify(byOperator.body)).toBe(200);
    expect((await chefA.get(`/interventions/${created.body.id}`)).body.attachments.map((a: { id: string }) => a.id)).toEqual([photo]);

    // Preuve du relevé : l'opérateur (sans readings.correct) est refusé ; le chef supprime et le relevé est détaché.
    const readingBefore = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: readingId } });
    const refused = await remove(operateurA, photo);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.message).toContain('readings.correct');
    const byChef = await remove(chefA, photo, 'Photo illisible');
    expect(byChef.status, JSON.stringify(byChef.body)).toBe(200);
    const readingAfter = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: readingId } });
    expect(readingAfter.attachmentId).toBeNull();
    expect(readingAfter.version).toBe(readingBefore.version + 1);
    const readings = await chefA.get(`/vehicles/${vehicleId}/readings`);
    expect(readings.body.items.find((r: { id: string }) => r.id === readingId)).toMatchObject({ attachmentId: null });
    expect((await chefA.get(`/interventions/${created.body.id}`)).body.attachments).toEqual([]);
    expect((await chefA.get(`/attachments/${photo}/download`)).status).toBe(404);
    const detach = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.detachement', objectId: readingId } });
    expect(detach).toMatchObject({ objectType: 'OdometerReading', reason: 'Photo illisible' });
  });

  it('justificatif du permis : lecteur refusé (403) ; suppression par l’opérateur → permis détaché (version incrémentée), audit rattaché à la société du conducteur', async () => {
    const scan = await uploadPdf(chefA, t.server, f.companies.A, 'permis.pdf');
    const permit = await chefA.put(`/drivers/${f.drivers.a1}/permit`, { number: 'P-123', categories: ['B'], attachmentId: scan });
    expect(permit.status, JSON.stringify(permit.body)).toBe(200);
    expect(permit.body).toMatchObject({ attachmentId: scan });
    const before = await t.prisma.client.driverPermit.findUniqueOrThrow({ where: { id: permit.body.id } });
    expect((await remove(lecteurA, scan)).status).toBe(403);
    const ok = await remove(operateurA, scan, 'Permis d’un autre conducteur');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await t.prisma.client.driverPermit.findUniqueOrThrow({ where: { id: permit.body.id } });
    expect(after.attachmentId).toBeNull();
    expect(after.version).toBe(before.version + 1);
    expect((await chefA.get(`/attachments/${scan}/download`)).status).toBe(404);
    const detach = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.detachement', objectId: permit.body.id } });
    expect(detach).toMatchObject({ objectType: 'DriverPermit', companyId: f.companies.A, reason: 'Permis d’un autre conducteur' });
  });

  it('photos du véhicule et de l’incident : lecteur et conducteur refusés, rôle opérationnel autorisé ; la photo disparaît de la fiche', async () => {
    const vehiclePhoto = await uploadPng(chefA, t.server, f.companies.A);
    expect((await chefA.post(`/vehicles/${vehicleId}/photos`, { attachmentId: vehiclePhoto })).status).toBe(201);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.photoAttachmentIds).toEqual([vehiclePhoto]);
    expect((await remove(lecteurA, vehiclePhoto)).status).toBe(403);
    const removed = await remove(operateurA, vehiclePhoto, 'Photo d’un autre véhicule');
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).body.photoAttachmentIds).toEqual([]);

    const incidentPhoto = await uploadPng(operateurA, t.server, f.companies.A);
    const incident = await operateurA.post('/incidents', { vehicleId, type: 'DOMMAGE', description: 'Rayure portière avant', photoAttachmentIds: [incidentPhoto] });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    expect(incident.body.photoAttachmentIds).toEqual([incidentPhoto]);
    expect((await remove(lecteurA, incidentPhoto)).status).toBe(403);
    expect((await remove(conducteurA, incidentPhoto)).status).toBe(404);
    const byChef = await remove(chefA, incidentPhoto, 'Photo floue');
    expect(byChef.status, JSON.stringify(byChef.body)).toBe(200);
    expect((await chefA.get(`/incidents/${incident.body.id}`)).body.photoAttachmentIds).toEqual([]);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'piece_jointe.suppression', objectId: incidentPhoto } });
    expect(audit.reason).toBe('Photo floue');
  });
});
