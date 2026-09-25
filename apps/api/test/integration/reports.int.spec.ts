import ExcelJS from 'exceljs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/bootstrap.js';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { ReportExportJobHandler } from '../../src/modules/reports/export/report-export.job-handler.js';
import { ReportExportPolicy } from '../../src/modules/reports/export/report-export.policy.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';
const HYPERLINK = '=HYPERLINK("http://evil.example","clic")';

/** Corps binaire d'une réponse supertest (XLSX, CSV brut). */
function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('Rapports V1 et exports (CDC 11.2, 11.3 — T01, T32, T34)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    t.app.get(ReportExportPolicy).syncMaxRows = 5_000;
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
  });

  async function initCounter(agent: Agent, vehicleId: string, physicalKm: string, startedAt = '2026-09-01T08:00:00Z'): Promise<void> {
    const res = await agent.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt, physicalKm });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function reading(agent: Agent, vehicleId: string, physicalKm: string, observedAt: string): Promise<void> {
    const res = await agent.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.outcome).toBe('ACCEPTE');
  }

  async function expense(agent: Agent, body: Record<string, unknown>): Promise<void> {
    const res = await agent.post('/expenses', body).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  function exportFile(agent: Agent, path: string) {
    return agent.get(path).buffer(true).parse(binary);
  }

  it('T34 — export CSV filtré : formules neutralisées, nombres non préfixés, bloc de métadonnées, lignes de B absentes ; XLSX sans formule', async () => {
    const trap = await createVehicle(t.prisma, f, 'A', { code: 'V-A-PIEGE', model: HYPERLINK, make: '@Marque' });
    const minus = await createVehicle(t.prisma, f, 'A', { code: 'V-A-MOINS', model: '-5', make: '＝pleinechasse' });
    await createVehicle(t.prisma, f, 'B', { code: 'V-B-SECRET', model: 'Secret' });
    await initCounter(chefA, trap, '12000');
    await initCounter(chefA, minus, '800');
    await expense(chefA, { vehicleId: trap, occurredOn: '2026-09-10', category: 'ENTRETIEN_REPARATION', amount: '300.000' });
    await expense(chefA, { vehicleId: trap, occurredOn: '2026-09-11', category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', amount: '50.000' });

    const csvRes = await exportFile(chefA, `/reports/inventaire/export?format=csv&companyId=${f.companies.A}`);
    expect(csvRes.status, csvRes.body.toString()).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.headers['content-disposition']).toContain('rapport-inventaire-vehicules-2026-09-24.csv');
    const csv = (csvRes.body as Buffer).toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).not.toMatch(/[^\r]\n/);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Rapport;Inventaire du parc — Véhicules');
    expect(lines[1]).toBe('Généré le;24/09/2026 11:00:00 (Africa/Tunis)');
    expect(lines).toContain('Auteur;Chaima Chef-A');
    expect(lines).toContain('Périmètre;A — Société A');
    expect(lines).toContain('Filtre — Société;A — Société A');
    expect(lines.find((l) => l.startsWith('Unités;'))).toContain('kilomètres');
    const blank = lines.indexOf('');
    expect(blank).toBeGreaterThan(4);
    const header = (lines[blank + 1] as string).split(';');
    expect(header.slice(0, 4)).toEqual(['Code', 'Immatriculation', 'Marque', 'Modèle']);
    expect(header).toContain('Kilométrage cumulé (km)');
    const data = lines.slice(blank + 2).filter((l) => l !== '');
    expect(data).toHaveLength(2);
    const trapLine = data.find((l) => l.startsWith('V-A-PIEGE;')) as string;
    expect(trapLine).toContain(`;'@Marque;"'=HYPERLINK(""http://evil.example"",""clic"")";`);
    expect(trapLine).toContain(';12000;');
    const minusLine = data.find((l) => l.startsWith('V-A-MOINS;')) as string;
    expect(minusLine).toContain(";'＝pleinechasse;'-5;");
    expect(minusLine).toContain(';800;');
    expect(csv).not.toContain('V-B-SECRET');
    // Aucune cellule du tableau ne commence par un caractère de formule (hors apostrophe de neutralisation).
    for (const line of data) for (const cell of line.split(';')) expect(cell.replace(/^"/, '')).not.toMatch(/^[=+\-@\t\r＝＋－＠]/);

    // Dépenses : l'avoir donne un montant signé négatif, écrit comme nombre (virgule décimale), jamais préfixé.
    const detail = await exportFile(chefA, `/reports/depenses/export?format=csv&vue=detail&companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    expect(detail.status, detail.body.toString()).toBe(200);
    const detailCsv = (detail.body as Buffer).toString('utf8');
    expect(detailCsv).toContain(';Avoir;');
    expect(detailCsv).toContain(';50,000;-50,000;');
    expect(detailCsv).not.toContain("'-50");
    expect(detailCsv).toContain('Total — Coût d’exploitation net;250,000 TND');

    const xlsxRes = await exportFile(chefA, `/reports/inventaire/export?format=xlsx&companyId=${f.companies.A}`);
    expect(xlsxRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsxRes.body);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Données', 'Paramètres']);
    const sheet = workbook.getWorksheet('Données') as ExcelJS.Worksheet;
    let formulas = 0;
    const cells: ExcelJS.Cell[] = [];
    workbook.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
      cells.push(cell);
      if (cell.type === ExcelJS.ValueType.Formula || cell.formula) formulas += 1;
    })));
    expect(formulas).toBe(0);
    expect(sheet.rowCount).toBe(3);
    const headerRow = sheet.getRow(1).values as unknown[];
    const modelCol = headerRow.indexOf('Modèle');
    const kmCol = headerRow.indexOf('Kilométrage cumulé (km)');
    const trapRow = [2, 3].map((i) => sheet.getRow(i)).find((r) => r.getCell(1).value === 'V-A-PIEGE') as ExcelJS.Row;
    expect(trapRow.getCell(modelCol).value).toBe(`'${HYPERLINK}`);
    expect(trapRow.getCell(modelCol).type).toBe(ExcelJS.ValueType.String);
    expect(trapRow.getCell(kmCol).value).toBe(12000);
    expect(trapRow.getCell(kmCol).type).toBe(ExcelJS.ValueType.Number);
    const params = workbook.getWorksheet('Paramètres') as ExcelJS.Worksheet;
    expect(params.getRow(2).values).toEqual([undefined, 'Rapport', 'Inventaire du parc — Véhicules']);
    expect(cells.some((c) => c.value === 'V-B-SECRET')).toBe(false);

    const xlsxDetail = await exportFile(chefA, `/reports/depenses/export?format=xlsx&vue=detail&companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    const detailBook = new ExcelJS.Workbook();
    await detailBook.xlsx.load(xlsxDetail.body);
    const detailSheet = detailBook.getWorksheet('Données') as ExcelJS.Worksheet;
    const signedCol = (detailSheet.getRow(1).values as unknown[]).indexOf('Montant signé (avoir négatif) (TND)');
    const signed = [2, 3].map((i) => detailSheet.getRow(i).getCell(signedCol).value);
    expect(signed.sort()).toEqual([-50, 300]);

    const audits = await t.prisma.client.auditEvent.findMany({ where: { organizationId: f.organizationId, action: 'export.rapport' }, orderBy: { createdAt: 'asc' } });
    expect(audits).toHaveLength(4);
    expect(audits[0]?.actorUserId).toBe(f.users.chefA);
    expect(audits[0]?.after).toMatchObject({ report: 'inventaire', format: 'csv', mode: 'synchrone', rowCount: 2, filters: { companyId: f.companies.A, vue: 'vehicules' } });
  });

  it('T01 — le chef A demandant un rapport filtré sur la société B reçoit 404, sans fuite dans le total ; conducteur seul : 403', async () => {
    await createVehicle(t.prisma, f, 'A', { code: 'V-A-1' });
    await createVehicle(t.prisma, f, 'B', { code: 'V-B-1' });
    await createVehicle(t.prisma, f, 'B', { code: 'V-B-2' });
    const forbidden = await chefA.get(`/reports/inventaire?companyId=${f.companies.B}`);
    expect(forbidden.status).toBe(404);
    expect(forbidden.body.total).toBeUndefined();
    expect(forbidden.body.items).toBeUndefined();
    expect((await chefA.get(`/reports/utilisations?companyId=${f.companies.B}`)).status).toBe(404);
    expect((await chefA.get(`/reports/inventaire/export?format=csv&companyId=${f.companies.B}`)).status).toBe(404);

    const own = await chefA.get('/reports/inventaire');
    expect(own.status).toBe(200);
    expect(own.body.total).toBe(1);
    expect(own.body.items.map((i: { code: string }) => i.code)).toEqual(['V-A-1']);
    expect(own.body.meta.scope.map((c: { code: string }) => c.code)).toEqual(['A']);
    expect(own.body.meta.timezone).toBe('Africa/Tunis');
    expect(own.body.meta.generatedAt).toBe(NOW);
    expect(own.body.meta.columns.find((c: { key: string }) => c.key === 'currentKm')).toMatchObject({ unit: 'km', kind: 'decimal' });

    const other = await chefB.get('/reports/inventaire');
    expect(other.body.total).toBe(2);
    const all = await admin.get('/reports/inventaire');
    expect(all.body.total).toBe(3);

    // Un véhicule d'une autre société utilisé comme filtre est introuvable, sans révéler son existence.
    const vB = (await t.prisma.client.vehicle.findFirstOrThrow({ where: { code: 'V-B-1' } })).id;
    expect((await chefA.get(`/reports/utilisations?vehicleId=${vB}`)).status).toBe(404);

    const driver = await conducteurA.get('/reports/inventaire');
    expect(driver.status).toBe(403);
    expect((await conducteurA.get('/reports')).status).toBe(403);
  });

  it('T32 — compte désactivé par l’administrateur : un nouvel export avec l’ancienne session est refusé (401)', async () => {
    await createVehicle(t.prisma, f, 'A');
    expect((await exportFile(chefA, '/reports/inventaire/export?format=csv')).status).toBe(200);
    const disabled = await admin.post(`/users/${f.users.chefA}/disable`, { reason: 'départ de la société' });
    expect(disabled.status).toBe(200);
    const again = await exportFile(chefA, '/reports/inventaire/export?format=csv');
    expect(again.status).toBe(401);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'export.rapport', actorUserId: f.users.chefA } })).toBe(1);
  });

  it('costs.read (D-266) : sans la permission, colonnes de coût retirées du DTO et rapport des dépenses refusé (403) ; export refusé sans reports.export', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-CARBU' });
    expect((await chefA.patch(`/vehicles/${vehicleId}`, { energy: 'DIESEL', tankCapacityLiters: '60', expectedVersion: 1 })).status).toBe(200);
    await initCounter(chefA, vehicleId, '9000');
    for (const [filledAt, liters, total, km] of [
      ['2026-09-05T08:00:00Z', '40', '101.000', '9100'],
      ['2026-09-15T08:00:00Z', '30', '75.750', '9600'],
    ] as const) {
      const res = await chefA.post('/fuel-entries', { vehicleId, filledAt, liters, unitPrice: '2.525', totalAmount: total, isFullTank: true, odometerKm: km }).set('Idempotency-Key', randomUUID());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const query = `?companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`;
    const chef = await chefA.get(`/reports/carburant${query}`);
    expect(chef.status, JSON.stringify(chef.body)).toBe(200);
    expect(chef.body.total).toBe(2);
    expect(chef.body.meta.costColumns).toBe('toutes');
    const [latest, earliest] = chef.body.items;
    expect(latest).toMatchObject({ liters: '30.000', totalAmount: '75.750', unitPrice: '2.525', fullTank: true, consumption: '6.0', consumptionNote: null });
    expect(earliest.consumption).toBeNull();
    expect(earliest.consumptionNote).toMatch(/Aucun plein complet validé de référence/);
    expect(chef.body.meta.columns.find((c: { key: string }) => c.key === 'totalAmount')).toMatchObject({ unit: 'TND', kind: 'money', cost: true, decimals: 3 });

    const reader = await lecteurA.get(`/reports/carburant${query}`);
    expect(reader.status).toBe(200);
    expect(reader.body.meta.costColumns).toBe('aucune');
    expect(reader.body.meta.columns.map((c: { key: string }) => c.key)).not.toContain('totalAmount');
    for (const item of reader.body.items) {
      expect(item).not.toHaveProperty('totalAmount');
      expect(item).not.toHaveProperty('unitPrice');
      expect(item).toHaveProperty('liters');
    }
    expect(reader.body.items[0].consumption).toBe('6.0');

    const expenses = await lecteurA.get(`/reports/depenses${query}`);
    expect(expenses.status).toBe(403);
    expect(expenses.body.code).toBe('ACTION_INTERDITE');
    expect((await chefA.get(`/reports/depenses${query}`)).body.items[0]).toMatchObject({ label: 'Carburant', operatingNet: '176.750', count: 2 });

    const readerExport = await exportFile(lecteurA, `/reports/carburant/export?format=csv${query.replace('?', '&')}`);
    expect(readerExport.status).toBe(403);

    // Lecteur avec reports.export mais sans costs.read : export sans colonnes de coût.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.lecteurA }, data: { grantedPermissions: ['REPORTS_EXPORT'] } });
    const allowed = await exportFile(lecteurA, `/reports/carburant/export?format=csv${query.replace('?', '&')}`);
    expect(allowed.status).toBe(200);
    const csv = (allowed.body as Buffer).toString('utf8');
    expect(csv).toContain('Colonnes de coût;Non incluses');
    expect(csv).not.toContain('Montant TTC');
    expect(csv).not.toContain('75,750');
    expect(csv).toContain('30,000');
  });

  it('export asynchrone au-delà du seuil : job, fichier privé EXPORT, téléchargement par le demandeur seul, droits revérifiés (403 après retrait de reports.export)', async () => {
    t.app.get(ReportExportPolicy).syncMaxRows = 2;
    for (const code of ['V-A-01', 'V-A-02', 'V-A-03']) await createVehicle(t.prisma, f, 'A', { code });
    await createVehicle(t.prisma, f, 'B', { code: 'V-B-99' });

    const accepted = await chefA.get('/reports/inventaire/export?format=csv');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const jobId = accepted.body.jobId as string;
    expect(accepted.body.rowCount).toBe(3);
    const pending = await chefA.get(`/reports/exports/${jobId}`);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'EN_ATTENTE', reportCode: 'inventaire', format: 'csv', downloadPath: null });
    expect((await chefB.get(`/reports/exports/${jobId}`)).status).toBe(404);
    expect((await admin.get(`/reports/exports/${jobId}`)).status).toBe(404);
    expect((await chefA.get(`/reports/exports/${jobId}/download`)).status).toBe(409);

    const jobs = t.app.get(JobsService);
    const handler = t.app.get(ReportExportJobHandler);
    const outcome = await jobs.runOne([handler], 'worker-test');
    expect(outcome).toMatchObject({ jobId, status: 'TERMINE', error: null });
    expect(await jobs.runOne([handler], 'worker-test')).toBeNull();

    const done = await chefA.get(`/reports/exports/${jobId}`);
    expect(done.body).toMatchObject({ status: 'TERMINE', progress: 100, rowCount: 3, fileName: 'rapport-inventaire-vehicules-2026-09-24.csv', expiresAt: '2026-09-25T10:00:00.000Z', downloadPath: `/api/v1/reports/exports/${jobId}/download` });
    const attachment = await t.prisma.client.attachment.findFirstOrThrow({ where: { ownerType: 'EXPORT', ownerId: jobId } });
    expect(attachment.companyId).toBeNull();
    expect(attachment.uploadedById).toBe(f.users.chefA);

    expect((await exportFile(chefB, `/reports/exports/${jobId}/download`)).status).toBe(404);
    const file = await exportFile(chefA, `/reports/exports/${jobId}/download`);
    expect(file.status).toBe(200);
    const csv = (file.body as Buffer).toString('utf8');
    expect(csv).toContain('Lignes;3');
    for (const code of ['V-A-01', 'V-A-02', 'V-A-03']) expect(csv).toContain(`\r\n${code};`);
    expect(csv).not.toContain('V-B-99');
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'export.telechargement', objectId: jobId, actorUserId: f.users.chefA } })).toBe(1);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'export.rapport', objectId: jobId } })).toBe(1);

    // Retrait de reports.export sur l'habilitation (contexte relu à chaque requête) : téléchargement refusé (droits revérifiés).
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.chefA }, data: { revokedPermissions: ['REPORTS_EXPORT'] } });
    const refused = await chefA.get(`/reports/exports/${jobId}/download`);
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ permission: 'reports.export' });
    expect((await chefA.get('/reports/inventaire/export?format=csv')).status).toBe(403);

    // Conservation 24 h : purge du fichier, téléchargement impossible ensuite.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.chefA }, data: { revokedPermissions: [] } });
    t.clock.advance(25 * 3600 * 1000);
    expect(await handler.purgeExpiredExports()).toBe(1);
    expect((await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: attachment.id } })).deletedAt).not.toBeNull();
    const chefAgain = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await chefAgain.get(`/reports/exports/${jobId}/download`)).status).toBe(410);
  });

  it('export différé abandonné si le demandeur perd reports.export avant l’exécution', async () => {
    t.app.get(ReportExportPolicy).syncMaxRows = 1;
    for (const code of ['V-A-11', 'V-A-12']) await createVehicle(t.prisma, f, 'A', { code });
    const accepted = await chefA.get('/reports/inventaire/export?format=xlsx');
    expect(accepted.status).toBe(202);
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.chefA }, data: { revokedPermissions: ['REPORTS_EXPORT'] } });
    const outcome = await t.app.get(JobsService).runOne([t.app.get(ReportExportJobHandler)], 'worker-test');
    expect(outcome?.status).toBe('ABANDONNE');
    expect(outcome?.error).toMatch(/reports\.export/);
    const status = await chefA.get(`/reports/exports/${accepted.body.jobId as string}`);
    expect(status.body).toMatchObject({ status: 'ABANDONNE', downloadPath: null });
    expect(await t.prisma.client.attachment.count({ where: { ownerType: 'EXPORT' } })).toBe(0);
  });

  it('deux workers concurrents : un seul réserve et exécute le job d’export', async () => {
    t.app.get(ReportExportPolicy).syncMaxRows = 1;
    for (const code of ['V-A-21', 'V-A-22']) await createVehicle(t.prisma, f, 'A', { code });
    const accepted = await chefA.get('/reports/inventaire/export?format=csv');
    expect(accepted.status).toBe(202);
    const jobs = t.app.get(JobsService);
    const handler = t.app.get(ReportExportJobHandler);
    const outcomes = await Promise.all([jobs.runOne([handler], 'worker-1'), jobs.runOne([handler], 'worker-2')]);
    expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
    expect(outcomes.find((o) => o !== null)?.status).toBe('TERMINE');
    const job = await t.prisma.client.job.findUniqueOrThrow({ where: { id: accepted.body.jobId as string } });
    expect(job).toMatchObject({ status: 'TERMINE', attempts: 1, progress: 100, lockedBy: null });
    expect(job.finishedAt).not.toBeNull();
    expect(await t.prisma.client.attachment.count({ where: { ownerType: 'EXPORT', ownerId: job.id } })).toBe(1);
  });

  it('immobilisations (D-271) : union des intervalles découpée à la période, « en cours », ventilation par cause qui se chevauchent', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-IMMO' });
    const incident = await chefA.post('/incidents', { vehicleId, type: 'PANNE', severity: 'ELEVEE', occurredAt: '2026-09-02T09:00:00Z', description: 'Panne moteur sur la tournée' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const first = await chefA.post('/immobilizations', { vehicleId, reason: 'Panne moteur', incidentId: incident.body.id, startedAt: '2026-09-02T10:00:00Z' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await chefA.post(`/immobilizations/${first.body.id}/causes`, { reason: 'Attente de pièce', startedAt: '2026-09-03T10:00:00Z', expectedVersion: first.body.version });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const ended = await chefA.post(`/immobilizations/${first.body.id}/end`, { endedAt: '2026-09-06T10:00:00Z', reason: 'Réparation terminée', expectedVersion: second.body.version });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    const ongoing = await chefA.post('/immobilizations', { vehicleId, reason: 'Carrosserie', startedAt: '2026-09-22T10:00:00Z' });
    expect(ongoing.status, JSON.stringify(ongoing.body)).toBe(201);

    const period = '&from=2026-09-01&to=2026-09-24';
    const byVehicle = await chefA.get(`/reports/incidents-immobilisations?vue=immobilisations${period}`);
    expect(byVehicle.status, JSON.stringify(byVehicle.body)).toBe(200);
    expect(byVehicle.body.items).toHaveLength(1);
    expect(byVehicle.body.items[0]).toMatchObject({ vehicle: 'V-A-IMMO', immobilizations: 2, durationDays: '6.0', state: 'ACTIVE', firstStart: '2026-09-02T10:00:00.000Z', lastEnd: NOW });
    const byCause = await chefA.get(`/reports/incidents-immobilisations?vue=causes${period}`);
    const causes = new Map(byCause.body.items.map((i: { causeKind: string; durationDays: string }) => [i.causeKind, i.durationDays]));
    expect(causes.get('INCIDENT')).toBe('4.0');
    expect(causes.get('AUTRE')).toBe('5.0');
    expect(byCause.body.meta.notes.join(' ')).toContain('Les causes se chevauchent');
    // Période coupant la première immobilisation : seules les heures dans la période comptent.
    const cut = await chefA.get('/reports/incidents-immobilisations?vue=immobilisations&from=2026-09-05&to=2026-09-05');
    expect(cut.body.items[0]).toMatchObject({ durationDays: '1.0', state: 'TERMINEE' });
    const incidents = await chefA.get(`/reports/incidents-immobilisations?vue=incidents${period}`);
    expect(incidents.body.items).toHaveLength(1);
    expect(incidents.body.items[0]).toMatchObject({ type: 'PANNE', severity: 'ELEVEE', immobilizing: true, company: 'A' });
    const xlsx = await exportFile(chefA, `/reports/incidents-immobilisations/export?format=xlsx&vue=immobilisations${period}`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.body);
    const sheet = book.getWorksheet('Données') as ExcelJS.Worksheet;
    const header = sheet.getRow(1).values as unknown[];
    expect(sheet.getRow(2).getCell(header.indexOf('Durée immobilisée (période) (jours)')).value).toBe(6);
    expect(sheet.getRow(2).getCell(header.indexOf('État')).value).toBe('En cours');
  });

  it('utilisations : distance validée des relevés de remise et de restitution, retard mesuré avec la tolérance, filtre des retards', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-USAGE' });
    await initCounter(chefA, vehicleId, '10000');
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-RAPPORT', categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const out = await chefA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-20T08:00:00Z', expectedReturnAt: '2026-09-20T18:00:00Z', purpose: 'Tournée clients', reading: { physicalKm: '10100' }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'DEMI', checklist: [{ label: 'Clés', present: true }] })
      .set('Idempotency-Key', randomUUID());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const back = await chefA.post(`/usages/${out.body.id as string}/return`, { returnedAt: '2026-09-20T20:00:00Z', reading: { physicalKm: '10250' }, location: { placeLabel: 'Dépôt' }, expectedVersion: out.body.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const period = '&from=2026-09-01&to=2026-09-24';
    const report = await chefA.get(`/reports/utilisations?vue=utilisations${period}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.items[0]).toMatchObject({ vehicle: 'V-A-USAGE', company: 'A', driver: 'Karim Conducteur-A', status: 'TERMINEE', distanceKm: '150', distanceStatus: 'VALIDEE', late: true, delayMinutes: 120, returnedAt: '2026-09-20T20:00:00.000Z' });
    expect((await chefA.get(`/reports/utilisations?lateOnly=true${period}`)).body.total).toBe(1);
    await t.prisma.client.settingValue.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, key: 'usage.lateReturnToleranceMinutes', value: 180, settingVersion: 1 } });
    const tolerated = await chefA.get(`/reports/utilisations?lateOnly=true${period}`);
    expect(tolerated.body.total).toBe(0);
    expect((await chefA.get(`/reports/utilisations${period.replace('&', '?')}`)).body.items[0]).toMatchObject({ late: false, delayMinutes: null });
    expect((await chefA.get(`/reports/utilisations?from=2026-09-21&to=2026-09-24`)).body.total).toBe(0);
    expect((await chefA.get(`/reports/releves?vue=qualite&freshness=A_ACTUALISER${period}`)).body.total).toBe(0);
    const quality = await chefA.get(`/reports/releves?vue=qualite&freshness=A_JOUR${period}`);
    expect(quality.body.items[0]).toMatchObject({ vehicle: 'V-A-USAGE', freshness: 'A_JOUR', ageDays: 3, pendingCount: 0, rejectedCount: 0, correctedCount: 0 });
    const readings = await chefA.get(`/reports/releves?vue=releves&status=ACCEPTE${period}`);
    expect(readings.body.items.map((r: { context: string }) => r.context)).toEqual(['RESTITUTION', 'REMISE', 'INITIALISATION']);
  });

  it('distances et coût/km (D-274) : N/D avec moins de deux relevés ou une couverture insuffisante, jamais 0', async () => {
    const single = await createVehicle(t.prisma, f, 'A', { code: 'V-A-D1' });
    const full = await createVehicle(t.prisma, f, 'A', { code: 'V-A-D2' });
    const short = await createVehicle(t.prisma, f, 'A', { code: 'V-A-D3' });
    await initCounter(chefA, single, '5000');
    await initCounter(chefA, full, '1000');
    await reading(chefA, full, '2000', '2026-09-22T08:00:00Z');
    await initCounter(chefA, short, '1000', '2026-09-20T08:00:00Z');
    await reading(chefA, short, '1100', '2026-09-22T08:00:00Z');
    for (const vehicleId of [full, short, single]) await expense(chefA, { vehicleId, occurredOn: '2026-09-21', category: 'ENTRETIEN_REPARATION', amount: '300.000' });
    await expense(chefA, { vehicleId: full, occurredOn: '2026-09-21', category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', amount: '50.000' });

    const res = await chefA.get(`/reports/couts-distances?companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byCode = new Map<string, Record<string, unknown>>(res.body.items.map((i: Record<string, unknown>) => [i['vehicle'] as string, i]));
    expect(byCode.get('V-A-D1')).toMatchObject({ readings: 1, distanceKm: null, distanceNote: expect.stringMatching(/Moins de deux relevés/), costPerKm: null, costPerKmNote: expect.stringMatching(/Distance de la période non déterminable/) });
    expect(byCode.get('V-A-D2')).toMatchObject({ readings: 2, distanceKm: '1000', estimatedDistanceKm: null, transferNote: null, operatingCost: '250.000', costPerKm: '0.250', costPerKmNature: 'CALCULE', costPerKmNote: null });
    expect(byCode.get('V-A-D3')).toMatchObject({ distanceKm: '100', costPerKm: null, costPerKmNote: expect.stringMatching(/couvre trop peu/) });
    expect(res.body.meta.columns.find((c: { key: string }) => c.key === 'costPerKm')).toMatchObject({ unit: 'TND/km', missing: 'N/D' });

    const reader = await lecteurA.get(`/reports/couts-distances?companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    expect(reader.body.items.find((i: Record<string, unknown>) => i['vehicle'] === 'V-A-D2')).not.toHaveProperty('costPerKm');

    const csv = await exportFile(chefA, `/reports/couts-distances/export?format=csv&companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    const text = (csv.body as Buffer).toString('utf8');
    const d1 = text.split('\r\n').find((l) => l.startsWith('V-A-D1;')) as string;
    expect(d1).toContain(';N/D;');
    expect(d1).not.toMatch(/;0;|;0,000;/);
  });

  it('chaque rapport et chaque vue répond sur le périmètre et s’exporte (filtres non pris en charge refusés)', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-ALL' });
    await initCounter(chefA, vehicleId, '1000');
    await reading(chefA, vehicleId, '1200', '2026-09-10T08:00:00Z');
    await expense(chefA, { vehicleId, occurredOn: '2026-09-12', category: 'PEAGE', amount: '12.500' });
    await expense(chefA, { companyId: f.companies.A, occurredOn: '2026-09-12', category: 'ASSURANCE', amount: '100.000' });
    const catalogue = await chefA.get('/reports');
    expect(catalogue.status).toBe(200);
    expect(catalogue.body).toMatchObject({ canExport: true, canReadCosts: true, syncMaxRows: 5000, maxRows: 100000 });
    for (const report of catalogue.body.reports as Array<{ code: string; views: Array<{ code: string; period: boolean }> }>) {
      for (const view of report.views) {
        const period = view.period ? '&from=2026-09-01&to=2026-09-24' : '';
        const page = await chefA.get(`/reports/${report.code}?vue=${view.code}${period}`);
        expect(page.status, `${report.code}/${view.code} ${JSON.stringify(page.body)}`).toBe(200);
        expect(page.body.meta.view.code).toBe(view.code);
        expect(page.body.meta.period).toEqual(view.period ? { from: '2026-09-01', to: '2026-09-24' } : null);
        const file = await exportFile(chefA, `/reports/${report.code}/export?format=xlsx&vue=${view.code}${period}`);
        expect(file.status, `${report.code}/${view.code}`).toBe(200);
      }
    }
    const inventory = await chefA.get('/reports/inventaire?vue=vehicules');
    expect(inventory.body.items[0]).toMatchObject({ code: 'V-A-ALL', operationalStatus: 'DISPONIBLE', currentKm: '1200', odometerSource: 'MANUAL', freshness: 'A_ACTUALISER', freshnessAgeDays: 14 });
    const byVehicle = await chefA.get('/reports/depenses?vue=vehicule&from=2026-09-01&to=2026-09-24');
    expect(byVehicle.body.items.map((i: { label: string; operatingNet: string }) => [i.label, i.operatingNet])).toEqual([
      ['V-A-ALL', '12.500'],
      ['Non ventilé', '100.000'],
    ]);
    expect(byVehicle.body.meta.summary[0]).toMatchObject({ label: 'Coût d’exploitation net', value: '112.500', unit: 'TND' });

    const unsupported = await chefA.get('/reports/inventaire?from=2026-09-01');
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.code).toBe('FILTRE_NON_PRIS_EN_CHARGE');
    expect((await chefA.get('/reports/inconnu')).status).toBe(404);
    expect((await chefA.get('/reports/utilisations?from=2026-09-10&to=2026-09-01')).status).toBe(422);
    expect((await chefA.get('/reports/releves?status=MANQUANT')).status).toBe(422);
    const raw = await request(t.server).get('/api/v1/reports/inventaire').set('Origin', TEST_ORIGIN);
    expect(raw.status).toBe(401);

    const openapi = buildOpenApiDocument(t.app);
    for (const path of ['/api/v1/reports', '/api/v1/reports/{code}', '/api/v1/reports/{code}/export', '/api/v1/reports/exports/{jobId}', '/api/v1/reports/exports/{jobId}/download']) {
      expect(openapi.paths[path]?.get?.tags, path).toEqual(['reports']);
      expect(openapi.paths[path]?.get?.summary, path).toBeTruthy();
    }
    expect(Object.keys(openapi.paths['/api/v1/reports/{code}/export']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '202']));
  });
  it('affectations habituelles : état À venir / En cours / Terminée par la règle unique (responsible-assignment.ts), filtre de statut', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-AFFECT' });
    const assign = (body: Record<string, unknown>) => chefA.post('/responsible-assignments', { vehicleId, ...body });
    const done = await assign({ driverId: f.drivers.a2, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-05T00:00:00Z' });
    const current = await assign({ driverId: f.drivers.a1, startsAt: '2026-09-10T00:00:00Z', endsAt: '2026-10-31T00:00:00Z' });
    const upcoming = await assign({ driverId: f.drivers.a2, startsAt: '2026-11-01T00:00:00Z' });
    expect([done.status, current.status, upcoming.status], JSON.stringify([done.body, current.body, upcoming.body])).toEqual([201, 201, 201]);

    const period = '&from=2026-09-01&to=2026-12-31';
    const all = await chefA.get(`/reports/utilisations?vue=affectations${period}`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.items.map((i: { status: string; startsAt: string }) => [i.startsAt, i.status])).toEqual([
      ['2026-11-01T00:00:00.000Z', 'A_VENIR'],
      ['2026-09-10T00:00:00.000Z', 'EN_COURS'],
      ['2026-09-01T00:00:00.000Z', 'TERMINEE'],
    ]);
    expect(all.body.meta.columns.find((c: { key: string }) => c.key === 'status').labels).toMatchObject({ A_VENIR: 'À venir' });
    for (const [status, startsAt] of [['A_VENIR', '2026-11-01T00:00:00.000Z'], ['EN_COURS', '2026-09-10T00:00:00.000Z'], ['TERMINEE', '2026-09-01T00:00:00.000Z']] as const) {
      const filtered = await chefA.get(`/reports/utilisations?vue=affectations&status=${status}${period}`);
      expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
      expect(filtered.body.items.map((i: { startsAt: string }) => i.startsAt)).toEqual([startsAt]);
    }
    const inventory = await chefA.get('/reports/inventaire?q=V-A-AFFECT');
    expect(inventory.body.items[0]).toMatchObject({ code: 'V-A-AFFECT', responsible: 'Karim Conducteur-A' });
  });

  it('entretiens à venir : statut matérialisé remis à jour au jour local avant le filtre (même règle que la liste des plans)', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-PLAN' });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const plan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: type.body.id, intervalMonths: 6, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-09-01' } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body.status).toBe('A_JOUR');

    // Six mois plus tard, aucun événement n'a recalculé le plan : l'échéance en date est dépassée.
    t.clock.set('2027-03-15T10:00:00.000Z');
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const report = await chef.get('/reports/entretiens?vue=a-venir');
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const status = report.body.items[0].status as string;
    expect(['A_FAIRE', 'EN_RETARD']).toContain(status);
    expect(report.body.items[0]).toMatchObject({ vehicle: 'V-A-PLAN', nextDueDate: '2027-03-01' });
    expect((await chef.get('/reports/entretiens?vue=a-venir&status=A_JOUR')).body.total).toBe(0);
    expect((await chef.get(`/reports/entretiens?vue=a-venir&status=${status}`)).body.total).toBe(1);
    const plans = await chef.get(`/maintenance-plans?vehicleId=${vehicleId}`);
    expect(plans.body.items[0].status).toBe(status);
  });

  it('catalogue : valeurs admises des filtres fermés et estimations décrites par le serveur (aucune liste côté écran)', async () => {
    const catalogue = await chefA.get('/reports');
    expect(catalogue.status).toBe(200);
    expect(Object.keys(catalogue.body.filterOptions.energy)).toEqual(['DIESEL', 'ESSENCE', 'GPL']);
    expect(catalogue.body.filterOptions.category).toMatchObject({ ACHAT_VEHICULE: 'Achat de véhicule' });
    expect((await chefA.get('/reports/carburant?energy=ELECTRIQUE')).status).toBe(422);
    const distances = await chefA.get('/reports/couts-distances');
    const byKey = new Map(distances.body.meta.columns.map((c: { key: string; estimates: string[] | null }) => [c.key, c.estimates]));
    expect(byKey.get('estimatedEndNature')).toEqual(['ESTIMATION']);
    expect(byKey.get('costPerKmNature')).toEqual(['ESTIME']);
    expect(byKey.get('vehicle')).toBeNull();
  });
  it('distances (D-276) : bornes physiques par défaut, estimation GPS dans une colonne séparée, coût/km « estimé » à défaut de distance physique', async () => {
    const mixed = await createVehicle(t.prisma, f, 'A', { code: 'V-A-GPS1' });
    const gpsOnly = await createVehicle(t.prisma, f, 'A', { code: 'V-A-GPS2' });
    await initCounter(chefA, mixed, '1000', '2026-09-02T08:00:00Z');
    await reading(chefA, mixed, '1300', '2026-09-20T08:00:00Z');
    await initCounter(chefA, gpsOnly, '5000', '2026-09-02T08:00:00Z');
    async function gps(vehicleId: string, cumulativeKm: string, observedAt: string): Promise<void> {
      const segment = await t.prisma.client.odometerSegment.findFirstOrThrow({ where: { vehicleId, endedAt: null } });
      await t.prisma.client.odometerReading.create({
        data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, segmentId: segment.id, source: 'TELEMATICS', context: 'SYNCHRONISATION', measurementKind: 'DISTANCE_GPS', status: 'ACCEPTE', gpsDistanceKm: '100', cumulativeKm, isEstimate: true, observedAt: new Date(observedAt) },
      });
    }
    await gps(mixed, '1450', '2026-09-23T08:00:00Z');
    await gps(gpsOnly, '5600', '2026-09-23T08:00:00Z');
    await expense(chefA, { vehicleId: gpsOnly, occurredOn: '2026-09-10', category: 'ENTRETIEN_REPARATION', amount: '120.000' });

    const res = await chefA.get(`/reports/couts-distances?companyId=${f.companies.A}&from=2026-09-01&to=2026-09-24`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byCode = new Map<string, Record<string, unknown>>(res.body.items.map((i: Record<string, unknown>) => [i['vehicle'] as string, i]));
    // Distance par défaut sur relevés physiques (1 000 → 1 300) ; la borne GPS (1 450) n'apparaît que dans la colonne estimée.
    expect(byCode.get('V-A-GPS1')).toMatchObject({ readings: 3, distanceKm: '300', endObservedAt: '2026-09-20T08:00:00.000Z', estimatedDistanceKm: '450', estimatedStartNature: 'MESURE', estimatedEndNature: 'ESTIMATION', costPerKmNote: expect.stringMatching(/Aucune dépense/) });
    // Un seul relevé physique : distance N/D, estimation disponible et coût/km marqué « estimé ».
    expect(byCode.get('V-A-GPS2')).toMatchObject({ distanceKm: null, distanceNote: expect.stringMatching(/Moins de deux relevés/), estimatedDistanceKm: '600', costPerKm: '0.200', costPerKmNature: 'ESTIME' });
    expect(res.body.meta.columns.find((c: { key: string }) => c.key === 'costPerKmNature').estimates).toEqual(['ESTIME']);
  });

  it('11.3 — transfert au milieu de la période : kilomètres et coûts ventilés par société détentrice, bornés par le relevé de transfert', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-A-TRANSF' });
    await initCounter(chefA, vehicleId, '10000', '2026-09-01T08:00:00Z');
    await reading(chefA, vehicleId, '10100', '2026-09-03T08:00:00Z');
    await expense(chefA, { vehicleId, occurredOn: '2026-09-05', category: 'ENTRETIEN_REPARATION', amount: '200.000' });

    t.clock.set('2026-09-12T10:00:00.000Z');
    const adminThen = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const version = (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).version;
    const transfer = await adminThen
      .post(`/vehicles/${vehicleId}/transfer`, { targetCompanyId: f.companies.B, expectedVersion: version, reason: 'Réorganisation du parc', plans: [], siteId: null, departmentId: null, sharedDocumentVersionIds: [], transferReading: { physicalKm: '10500' } })
      .set('Idempotency-Key', randomUUID());
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);

    t.clock.set(NOW);
    const [adminNow, chefANow, chefBNow] = await Promise.all([login(t.server, f.emails.admin, DEFAULT_PASSWORD), login(t.server, f.emails.chefA, DEFAULT_PASSWORD), login(t.server, f.emails.chefB, DEFAULT_PASSWORD)]);
    await reading(chefBNow, vehicleId, '11300', '2026-09-20T08:00:00Z');
    await expense(chefBNow, { vehicleId, occurredOn: '2026-09-15', category: 'ENTRETIEN_REPARATION', amount: '400.000' });

    const query = `?vehicleId=${vehicleId}&from=2026-09-01&to=2026-09-24`;
    const all = await adminNow.get(`/reports/couts-distances${query}`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.total).toBe(2);
    const [partA, partB] = all.body.items as Array<Record<string, unknown>>;
    // Société A : du relevé initial au relevé de transfert (10 000 → 10 500) et ses seuls coûts (200).
    expect(partA).toMatchObject({ company: 'A', companyId: f.companies.A, distanceKm: '500', endObservedAt: '2026-09-12T10:00:00.000Z', operatingCost: '200.000', costPerKm: '0.400', transferNote: expect.stringMatching(/^Jusqu’au transfert du 12\/09\/2026 11:00 \(relevé de transfert/) });
    // Société B : du relevé de transfert (borne commune) à son relevé (10 500 → 11 300) et ses seuls coûts (400).
    expect(partB).toMatchObject({ company: 'B', companyId: f.companies.B, distanceKm: '800', startObservedAt: '2026-09-12T10:00:00.000Z', operatingCost: '400.000', transferNote: expect.stringMatching(/^Depuis le transfert du 12\/09\/2026 11:00/) });

    // Chaque chef ne voit que la part de sa société : aucun kilomètre ni coût de l'autre.
    const seenByA = await chefANow.get(`/reports/couts-distances${query}`);
    expect(seenByA.status, JSON.stringify(seenByA.body)).toBe(200);
    expect(seenByA.body.items).toHaveLength(1);
    expect(seenByA.body.items[0]).toMatchObject({ company: 'A', distanceKm: '500', operatingCost: '200.000' });
    const seenByB = await chefBNow.get(`/reports/couts-distances${query}`);
    expect(seenByB.body.items).toHaveLength(1);
    expect(seenByB.body.items[0]).toMatchObject({ company: 'B', distanceKm: '800', operatingCost: '400.000' });
  });
});
