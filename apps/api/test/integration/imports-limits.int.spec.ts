import ExcelJS from 'exceljs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const MIB = 1024 * 1024;
const HEADER = 'company_code;vehicle_code;registration;make;model;category';
/** PNG 1×1 valide (image insérée dans un classeur). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/**
 * Limites et contenu d'un lot d'import par la route réelle POST /imports (CDC 12.1, 12.2, 17.1) :
 * 5 Mo et 2 000 lignes par lot, documents numérisés jamais importés par les cellules, base d'entretien
 * importée sans recul de la base courante.
 */
describe('Import assisté : limites d’un lot, documents et bases d’entretien (CDC 12.1, 12.2, 17.1)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;

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
  });

  function upload(agent: Agent, kind: string, content: string | Buffer, name: string) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    return request(t.server).post('/api/v1/imports').set('Cookie', agent.cookies).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', agent.csrf).field('kind', kind).attach('file', buffer, name);
  }

  async function validate(agent: Agent, up: { body: { id: string; columnMapping: Record<string, string>; version: number } }) {
    const res = await agent.post(`/imports/${up.body.id}/validate`, { mapping: up.body.columnMapping, expectedVersion: up.body.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; status: string; errorCount: number; counts: { total: number; valid: number; errors: number } };
  }

  function commit(agent: Agent, id: string) {
    return agent.post(`/imports/${id}/commit`).set('Idempotency-Key', randomUUID());
  }

  /** CSV UTF-8 d'exactement `bytes` octets : une ligne de véhicule dont une colonne libre sert de remplissage. */
  function csvOfSize(bytes: number): Buffer {
    const head = `${HEADER};commentaire\nA;TAILLE-1;700 TU 7001;Peugeot;208;VP;`;
    const tail = '\n';
    return Buffer.from(head + 'x'.repeat(bytes - Buffer.byteLength(head) - tail.length) + tail, 'utf8');
  }

  const vehicleRows = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `A;${prefix}-${i + 1};${String(i + 1).padStart(4, '0')} TU ${prefix.length}${String(i + 1).padStart(4, '0')};Renault;Clio;VP`);

  async function nothingStored(before: { batches: number; attachments: number }) {
    expect(await t.prisma.client.importBatch.count()).toBe(before.batches);
    expect(await t.prisma.client.attachment.count()).toBe(before.attachments);
  }

  it('5 Mo au plus : exactement 5 Mo accepté ; un octet de plus refusé par la route (422 FICHIER_TROP_VOLUMINEUX), rien de conservé', async () => {
    const exact = await upload(chefA, 'VEHICULES', csvOfSize(5 * MIB), 'cinq-mo.csv');
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body).toMatchObject({ status: 'TELEVERSE', rowCount: 1 });
    const before = { batches: await t.prisma.client.importBatch.count(), attachments: await t.prisma.client.attachment.count() };

    const over = await upload(chefA, 'VEHICULES', csvOfSize(5 * MIB + 1), 'trop-gros.csv');
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: 'FICHIER_TROP_VOLUMINEUX', message: 'Le fichier dépasse la taille maximale d’un import (5 Mo).', fieldErrors: { file: ['5 Mo au plus par lot, hors pièces jointes.'] } });
    const far = await upload(chefA, 'VEHICULES', csvOfSize(6 * MIB), 'six-mo.csv');
    expect(far.status).toBe(422);
    expect(far.body.code).toBe('FICHIER_TROP_VOLUMINEUX');
    await nothingStored(before);

    // Limite paramétrée plus basse (17.1, administrateur, auditée) : même refus, par le service.
    const setting = await admin.put('/settings/imports.maxSizeBytes', { value: MIB, reason: 'lots plus petits' });
    expect(setting.status, JSON.stringify(setting.body)).toBe(200);
    const lowered = await upload(chefA, 'VEHICULES', csvOfSize(2 * MIB), 'deux-mo.csv');
    expect(lowered.status).toBe(422);
    expect(lowered.body).toMatchObject({ code: 'FICHIER_TROP_VOLUMINEUX', message: 'Le fichier dépasse la taille maximale d’un import (1 Mo).' });
    await nothingStored(before);
    // Au-delà du plafond de 5 Mo, le paramètre est refusé.
    expect((await admin.put('/settings/imports.maxSizeBytes', { value: 5 * MIB + 1, reason: 'essai' })).status).toBe(422);
  });

  it('2 000 lignes au plus : un lot de 2 000 lignes se contrôle et se confirme ; 2 001 lignes (CSV ou XLSX) refusées dès l’envoi', async () => {
    const before = { batches: await t.prisma.client.importBatch.count(), attachments: await t.prisma.client.attachment.count() };
    const tooMany = await upload(chefA, 'VEHICULES', [HEADER, ...vehicleRows(2001, 'TROP')].join('\n'), 'trop-de-lignes.csv');
    expect(tooMany.status).toBe(422);
    expect(tooMany.body).toMatchObject({ code: 'TROP_DE_LIGNES', message: 'Le fichier contient 2001 lignes : maximum 2000 par lot.' });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Données');
    ws.addRow(HEADER.split(';'));
    for (const line of vehicleRows(2001, 'XLS')) ws.addRow(line.split(';'));
    const xlsx = await upload(chefA, 'VEHICULES', Buffer.from(await wb.xlsx.writeBuffer()), 'trop-de-lignes.xlsx');
    expect(xlsx.status).toBe(422);
    expect(xlsx.body.code).toBe('TROP_DE_LIGNES');
    await nothingStored(before);

    // Les lignes vides ne comptent pas : 2 000 lignes de données et des lignes blanches passent.
    const full = await upload(chefA, 'VEHICULES', [HEADER, ...vehicleRows(2000, 'LOT'), '', ';;;;;', ''].join('\n'), 'deux-mille.csv');
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expect(full.body.rowCount).toBe(2000);
    const controlled = await validate(chefA, full);
    expect(controlled).toMatchObject({ status: 'CONTROLE', errorCount: 0, counts: { total: 2000, valid: 2000, errors: 0 } });
    const done = await commit(chefA, controlled.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('CONFIRME');
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'LOT-' } } })).toBe(2000);
  }, 300_000);

  it('documents numérisés : aucune colonne de document ; image insérée, lien et colonne « carte grise » ignorés ; aucune pièce jointe ni document créé', async () => {
    const models = await chefA.get('/imports/models');
    expect(models.status).toBe(200);
    const columns = (models.body as Array<{ kind: string; columns: Array<{ name: string; label?: string }> }>).flatMap((m) => m.columns.map((c) => `${m.kind}.${c.name}`));
    expect(columns.length).toBeGreaterThan(20);
    for (const column of columns) expect(column).not.toMatch(/document|fichier|file|piece|pièce|scan|photo|image|pdf|justificatif|attachment|carte_grise|assurance/i);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Données');
    ws.addRow([...HEADER.split(';'), 'carte_grise', 'assurance_pdf']);
    ws.addRow(['A', 'DOC-1', '800 TU 8001', 'Toyota', 'Yaris', 'VP', 'voir image', { text: 'assurance.pdf', hyperlink: 'https://documents.example.test/assurance.pdf' }]);
    ws.addImage(wb.addImage({ buffer: PNG as unknown as ExcelJS.Buffer, extension: 'png' }), 'G2:G2');
    const up = await upload(chefA, 'VEHICULES', Buffer.from(await wb.xlsx.writeBuffer()), 'avec-documents.xlsx');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    // Les colonnes supplémentaires ne s'associent à aucune colonne du modèle.
    expect(Object.values(up.body.columnMapping as Record<string, string>)).not.toContain('carte_grise');
    expect(Object.values(up.body.columnMapping as Record<string, string>)).not.toContain('assurance_pdf');
    const refused = await chefA.post(`/imports/${up.body.id}/validate`, { mapping: { ...up.body.columnMapping, document: 'assurance_pdf' }, expectedVersion: up.body.version });
    expect(refused.status).toBe(422);
    const controlled = await validate(chefA, up);
    expect(controlled.errorCount).toBe(0);
    expect((await commit(chefA, controlled.id)).status).toBe(200);

    const vehicle = await t.prisma.client.vehicle.findFirstOrThrow({ where: { code: 'DOC-1' } });
    // Seul le fichier source du lot est conservé, rattaché au lot ; ni photo, ni document, ni pièce jointe du véhicule.
    const attachments = await t.prisma.client.attachment.findMany({ select: { ownerType: true, ownerId: true, mimeType: true } });
    expect(attachments).toEqual([{ ownerType: 'IMPORT', ownerId: controlled.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]);
    expect(await t.prisma.client.documentVersion.count()).toBe(0);
    const synthesis = await chefA.get(`/vehicles/${vehicle.id}/synthesis`);
    expect(synthesis.status).toBe(200);
    expect(JSON.stringify(synthesis.body)).not.toContain('documents.example.test');
    expect(JSON.stringify(await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }))).not.toContain('assurance.pdf');
  });

  it('T18 — base d’entretien importée antérieure à la dernière opération : plan actif inchangé (ligne en erreur) ; plan recréé : la dernière opération reste la base', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'BASE-1' });
    const typeId = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-06-01T08:00:00Z' })).status).toBe(201);
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: typeId, intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: '2026-01-10' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const reading = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '90300', observedAt: '2026-09-23T09:00:00Z' });
    expect(reading.status, JSON.stringify(reading.body)).toBe(201);
    const intervention = await chefA.post('/interventions', { vehicleId, kind: 'PREVENTIF', tasks: [{ planId: plan.body.id }] });
    expect(intervention.status, JSON.stringify(intervention.body)).toBe(201);
    const done = await chefA
      .post(`/interventions/${intervention.body.id}/complete`, { completedTaskIds: intervention.body.tasks.map((x: { id: string }) => x.id), expectedVersion: intervention.body.version, performedOn: '2026-09-23', acceptedReadingId: reading.body.reading.id })
      .set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const current = (await chefA.get(`/maintenance-plans/${plan.body.id}`)).body;
    expect(current).toMatchObject({ baseKm: '90300', baseDate: '2026-09-23', nextDueKm: '100300' });

    // Import d'une vidange plus ancienne (86 000 km le 1er juillet) : le plan actif n'est pas touché.
    const header = 'company_code;vehicle_code;maintenance_type;interval_km;interval_months;base_mode;base_km;base_date';
    const line = 'A;BASE-1;VIDANGE;10000;;DERNIERE_OPERATION;86000;2026-07-01';
    const up = await upload(chefA, 'BASES_ENTRETIEN', `${header}\n${line}\n`, 'base-ancienne.csv');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const controlled = await validate(chefA, up);
    expect(controlled.errorCount).toBe(1);
    const rows = (await chefA.get(`/imports/${controlled.id}/rows`)).body.items as Array<{ errors: Array<{ column: string | null; message: string }> }>;
    expect(rows[0]?.errors).toEqual([{ column: 'maintenance_type', message: 'Un plan actif existe déjà pour ce véhicule et cette opération. L’import crée de nouveaux dossiers et ne modifie jamais une fiche existante.' }]);
    const refused = await commit(chefA, controlled.id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('LOT_INVALIDE');
    expect((await chefA.get(`/maintenance-plans/${plan.body.id}`)).body).toMatchObject({ baseKm: '90300', baseDate: '2026-09-23', nextDueKm: '100300', version: current.version });

    // Plan désactivé puis base importée : la vidange réalisée le 23 septembre reste la base du nouveau plan.
    const off = await chefA.post(`/maintenance-plans/${plan.body.id}/deactivate`, { reason: 'reprise par import', expectedVersion: current.version });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const again = await upload(chefA, 'BASES_ENTRETIEN', `${header}\n${line}\n`, 'base-ancienne-2.csv');
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const ok = await validate(chefA, again);
    expect(ok.errorCount).toBe(0);
    expect((await commit(chefA, ok.id)).status).toBe(200);
    const created = await t.prisma.client.vehicleMaintenancePlan.findFirstOrThrow({ where: { vehicleId, active: true } });
    expect(created.id).not.toBe(plan.body.id);
    expect((await chefA.get(`/maintenance-plans/${created.id}`)).body).toMatchObject({ baseMode: 'DERNIERE_OPERATION', baseKm: '90300', baseDate: '2026-09-23', nextDueKm: '100300' });
    // Aucune prestation simulée : toujours une seule intervention, aucune dépense.
    expect(await t.prisma.client.intervention.count({ where: { vehicleId } })).toBe(1);
    expect(await t.prisma.client.expense.count({ where: { vehicleId } })).toBe(0);
  });
});
