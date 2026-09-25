import ExcelJS from 'exceljs';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Import assisté (CDC 12.1, 12.2 — T27)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;

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
  });

  function upload(agent: Agent, kind: string, content: string | Buffer, name: string) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    return request(t.server).post('/api/v1/imports').set('Cookie', agent.cookies).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', agent.csrf).field('kind', kind).attach('file', buffer, name);
  }

  async function uploadAndValidate(agent: Agent, kind: string, content: string | Buffer, name: string, mapping?: Record<string, string>) {
    const up = await upload(agent, kind, content, name);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const res = await agent.post(`/imports/${up.body.id}/validate`, { mapping: mapping ?? up.body.columnMapping, expectedVersion: up.body.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; status: string; errorCount: number; counts: { total: number; valid: number; errors: number; ignored: number; withNotes: number }; version: number; warnings: string[] };
  }

  function commit(agent: Agent, id: string, key = randomUUID()) {
    return agent.post(`/imports/${id}/commit`).set('Idempotency-Key', key);
  }

  async function rowsOf(agent: Agent, id: string) {
    const res = await agent.get(`/imports/${id}/rows?pageSize=100`);
    expect(res.status).toBe(200);
    return res.body.items as Array<{ rowNumber: number; status: string; errors: Array<{ column: string | null; message: string }>; notes: string[]; createdObjectId: string | null }>;
  }

  const VEHICLE_HEADER = 'company_code;vehicle_code;registration;make;model;category;energy;year';

  it('T27 — lot avec doublon et mauvaise société : aucune écriture ; lot corrigé confirmé deux fois : une seule importation', async () => {
    const before = await t.prisma.client.vehicle.count();
    const invalid = [VEHICLE_HEADER, 'A;IMP-001;111 TU 1001;Peugeot;208;VP;DIESEL;2022', 'A;IMP-001;111 TU 1002;Renault;Clio;VP;ESSENCE;2021', 'B;IMP-003;111 TU 1003;Kia;Picanto;VP;ESSENCE;2020', 'A;IMP-004;111 TU 1004;Dacia;Logan;VP;DIESEL;2019'].join('\n');
    const controlled = await uploadAndValidate(chefA, 'VEHICULES', invalid, 'vehicules.csv');
    expect(controlled.status).toBe('CONTROLE');
    expect(controlled.counts).toMatchObject({ total: 4, valid: 2, errors: 2 });
    const rows = await rowsOf(chefA, controlled.id);
    expect(rows.find((r) => r.rowNumber === 3)?.errors).toEqual([{ column: 'vehicle_code', message: 'Doublon dans le fichier : même valeur qu’à la ligne 2.' }]);
    expect(rows.find((r) => r.rowNumber === 4)?.errors).toEqual([{ column: 'company_code', message: 'Société « B » inconnue ou hors de votre périmètre d’import.' }]);
    // Le contrôle n'a rien écrit : il s'exécute dans une transaction annulée.
    expect(await t.prisma.client.vehicle.count()).toBe(before);

    const refused = await commit(chefA, controlled.id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('LOT_INVALIDE');
    expect(await t.prisma.client.vehicle.count()).toBe(before);
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'IMP-' } } })).toBe(0);

    const corrected = [VEHICLE_HEADER, 'A;IMP-001;111 TU 1001;Peugeot;208;VP;DIESEL;2022', 'A;IMP-002;111 TU 1002;Renault;Clio;VP;ESSENCE;2021', 'A;IMP-004;111 TU 1004;Dacia;Logan;VP;DIESEL;2019'].join('\n');
    const ok = await uploadAndValidate(chefA, 'VEHICULES', corrected, 'vehicules-corrige.csv');
    expect(ok.errorCount).toBe(0);
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'IMP-' } } })).toBe(0);

    // Deux confirmations simultanées (deux clics, clés différentes) : une seule importation.
    const [c1, c2] = await Promise.all([commit(chefA, ok.id), commit(chefA, ok.id)]);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c1.body.status).toBe('CONFIRME');
    expect(c2.body.status).toBe('CONFIRME');
    expect(c2.body.counts).toEqual(c1.body.counts);
    const again = await commit(chefA, ok.id);
    expect(again.status).toBe(200);
    expect(again.body.committedAt).toBe(c1.body.committedAt);
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'IMP-' } } })).toBe(3);
    const imported = await rowsOf(chefA, ok.id);
    expect(imported.map((r) => r.status)).toEqual(['IMPORTEE', 'IMPORTEE', 'IMPORTEE']);
    const v = await t.prisma.client.vehicle.findFirstOrThrow({ where: { code: 'IMP-001' } });
    expect(v.companyId).toBe(f.companies.A);
    expect(v.registrationNormalized).toBe('111TU1001');
    expect(imported[0]?.createdObjectId).toBe(v.id);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId: v.id } })).toBe(1);
    const audits = await t.prisma.client.auditEvent.findMany({ where: { objectId: ok.id }, orderBy: { id: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['import.televersement', 'import.controle', 'import.confirmation']);

    // Même fichier téléversé à nouveau : avertissement, doublons en base signalés, rien n'est réécrit.
    const replay = await uploadAndValidate(chefA, 'VEHICULES', corrected, 'vehicules-corrige.csv');
    expect(replay.warnings[0]).toMatch(/^Ce fichier a déjà été importé le 24\/09\/2026 à 11:00/);
    expect(replay.counts.errors).toBe(3);
    const dupRows = await rowsOf(chefA, replay.id);
    expect(dupRows[0]?.errors[0]).toEqual({ column: 'vehicle_code', message: 'Ce code interne existe déjà dans l’organisation. L’import crée de nouveaux dossiers et ne modifie jamais une fiche existante.' });
    expect((await commit(chefA, replay.id)).status).toBe(422);
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'IMP-' } } })).toBe(3);
  });

  it('confirmation refusée si les données ont changé depuis le contrôle : rollback complet et retour au contrôle', async () => {
    const csv = [VEHICLE_HEADER, 'A;CHG-001;222 TU 2001;Peugeot;208;VP;DIESEL;2022', 'A;CHG-002;222 TU 2002;Renault;Clio;VP;ESSENCE;2021'].join('\n');
    const ok = await uploadAndValidate(chefA, 'VEHICULES', csv, 'changement.csv');
    expect(ok.errorCount).toBe(0);
    // Entre le contrôle et la confirmation, un véhicule prend l'immatriculation de la ligne 3.
    await createVehicle(t.prisma, f, 'A', { code: 'AUTRE-1', registration: '222 TU 2002' });
    const res = await commit(chefA, ok.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOT_INVALIDE');
    expect(await t.prisma.client.vehicle.count({ where: { code: { startsWith: 'CHG-' } } })).toBe(0);
    const batch = (await chefA.get(`/imports/${ok.id}`)).body;
    expect(batch.status).toBe('CONTROLE');
    expect(batch.errorCount).toBe(1);
    const rows = await rowsOf(chefA, ok.id);
    expect(rows[1]?.errors[0]?.column).toBe('registration');
  });

  it('relevés : INITIAL puis COURANT, formats refusés, hausse implausible en attente, réimport idempotent', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'REL-1' });
    const header = 'company_code;vehicle_code;observed_at;physical_km;meter_reference;initial_cumulative_km;note';
    const bad = [header, 'A;REL-1;2026-09-01 08:00;45.230;INITIAL;;', 'A;REL-1;01/09/26 09:00;45300;COURANT;;', 'A;REL-1;2026-09-02 08:00;45400;REMPLACEMENT;;'].join('\n');
    const controlled = await uploadAndValidate(chefA, 'RELEVES', bad, 'releves.csv');
    const rows = await rowsOf(chefA, controlled.id);
    expect(rows[0]?.errors).toEqual([{ column: 'physical_km', message: 'Kilométrage ambigu : « 45.230 » (entier sans séparateur attendu, ex. 45230).' }]);
    expect(rows[1]?.errors).toEqual([{ column: 'observed_at', message: 'Horodatage non reconnu : « 01/09/26 09:00 » (AAAA-MM-JJ HH:mm, JJ/MM/AAAA HH:mm ou ISO avec décalage).' }]);
    expect(rows[2]?.errors).toEqual([{ column: 'meter_reference', message: 'Valeur « REMPLACEMENT » non reconnue : INITIAL ou COURANT.' }]);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(0);

    const good = [header, 'A;REL-1;2026-09-01 08:00;45230;INITIAL;;Reprise historique', 'A;REL-1;2026-09-10;45900;COURANT;;', 'A;REL-1;2026-09-11 08:00;60000;COURANT;;'].join('\n');
    const ok = await uploadAndValidate(chefA, 'RELEVES', good, 'releves-ok.csv');
    expect(ok.counts).toMatchObject({ total: 3, valid: 3, errors: 0, withNotes: 2 });
    const okRows = await rowsOf(chefA, ok.id);
    expect(okRows[1]?.notes).toEqual(['Horodatage : heure non fournie (00:00 heure locale).']);
    expect(okRows[2]?.notes[0]).toMatch(/^Relevé importé en attente de validation : /);
    expect((await commit(chefA, ok.id)).status).toBe(200);

    const readings = await t.prisma.client.odometerReading.findMany({ where: { vehicleId }, orderBy: { observedAt: 'asc' } });
    expect(readings.map((r) => [r.source, r.status, r.physicalKm?.toString(), r.importBatchId])).toEqual([
      ['IMPORT', 'ACCEPTE', '45230', ok.id],
      ['IMPORT', 'ACCEPTE', '45900', ok.id],
      ['IMPORT', 'EN_ATTENTE', '60000', ok.id],
    ]);
    // Date seule : 00:00 à Tunis (UTC+1).
    expect(readings[1]?.observedAt.toISOString()).toBe('2026-09-09T23:00:00.000Z');
    const segment = await t.prisma.client.odometerSegment.findFirstOrThrow({ where: { vehicleId } });
    expect(segment.startCumulativeKm.toString()).toBe('45230');

    // Même fichier à nouveau : relevés identiques ignorés, aucune écriture, aucun doublon.
    const replay = await uploadAndValidate(chefA, 'RELEVES', good, 'releves-ok.csv');
    expect(replay.counts).toMatchObject({ total: 3, errors: 0, ignored: 3 });
    const replayRows = await rowsOf(chefA, replay.id);
    expect(replayRows.map((r) => r.status)).toEqual(['IGNOREE', 'IGNOREE', 'IGNOREE']);
    expect((await commit(chefA, replay.id)).status).toBe(200);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId } })).toBe(3);
  });

  it('COURANT sans compteur initialisé et INITIAL sur compteur existant : erreurs, jamais d’initialisation ni de remplacement implicite', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'REL-2' });
    const header = 'company_code;vehicle_code;observed_at;physical_km;meter_reference';
    const first = await uploadAndValidate(chefA, 'RELEVES', [header, 'A;REL-2;2026-09-01 08:00;1000;COURANT'].join('\n'), 'courant.csv');
    expect((await rowsOf(chefA, first.id))[0]?.errors[0]).toEqual({ column: 'meter_reference', message: 'Le compteur de ce véhicule n’est pas initialisé : enregistrez d’abord la valeur initiale.' });
    const init = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '500', observedAt: '2026-08-01T08:00:00Z' });
    expect(init.status).toBe(201);
    const second = await uploadAndValidate(chefA, 'RELEVES', [header, 'A;REL-2;2026-09-01 08:00;0;INITIAL'].join('\n'), 'initial.csv');
    expect((await rowsOf(chefA, second.id))[0]?.errors[0]).toEqual({ column: 'meter_reference', message: 'Le compteur est déjà initialisé ; utilisez un remplacement de compteur.' });
    expect(await t.prisma.client.odometerSegment.count({ where: { vehicleId } })).toBe(1);
  });

  it('conducteurs : actif/inactif, e-mail invalide, association de colonnes personnalisée et obligatoires', async () => {
    const csv = ['Société,Matricule,Prénom,Nom,Actif,Courriel', 'A,IMP-D1,Salma,Ben Ali,oui,salma@exemple.tn', 'A,IMP-D2,Hédi,Trabelsi,non,', 'A,IMP-D3,Mouna,Gharbi,peut-être,pas-un-email'].join('\n');
    const up = await upload(chefA, 'CONDUCTEURS', csv, 'conducteurs.csv');
    expect(up.status).toBe(201);
    expect(up.body.headers).toEqual(['Société', 'Matricule', 'Prénom', 'Nom', 'Actif', 'Courriel']);
    expect(up.body.columnMapping).toEqual({});
    const incomplete = await chefA.post(`/imports/${up.body.id}/validate`, { mapping: { company_code: 'Société', driver_code: 'Matricule' }, expectedVersion: up.body.version });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.code).toBe('ASSOCIATION_INCOMPLETE');
    expect(Object.keys(incomplete.body.fieldErrors).sort()).toEqual(['active', 'first_name', 'last_name']);
    const mapping = { company_code: 'Société', driver_code: 'Matricule', first_name: 'Prénom', last_name: 'Nom', active: 'Actif', email: 'Courriel' };
    const res = await chefA.post(`/imports/${up.body.id}/validate`, { mapping, expectedVersion: up.body.version });
    expect(res.status).toBe(200);
    const rows = await rowsOf(chefA, up.body.id);
    expect(rows[2]?.errors).toEqual([
      { column: 'active', message: 'Valeur booléenne non reconnue : « peut-être » (oui/non, true/false, 1/0, actif/inactif).' },
    ]);
    // Correction de la ligne en erreur : nouveau fichier.
    const fixed = ['Société,Matricule,Prénom,Nom,Actif,Courriel', 'A,IMP-D1,Salma,Ben Ali,oui,salma@exemple.tn', 'A,IMP-D2,Hédi,Trabelsi,non,', 'A,IMP-D3,Mouna,Gharbi,oui,pas-un-email'].join('\n');
    const up2 = await upload(chefA, 'CONDUCTEURS', fixed, 'conducteurs.csv');
    const v2 = await chefA.post(`/imports/${up2.body.id}/validate`, { mapping, expectedVersion: up2.body.version });
    expect((await rowsOf(chefA, v2.body.id))[2]?.errors).toEqual([{ column: 'email', message: 'Une adresse e-mail valide est attendue.' }]);
    const final = ['Société,Matricule,Prénom,Nom,Actif,Courriel', 'A,IMP-D1,Salma,Ben Ali,oui,salma@exemple.tn', 'A,IMP-D2,Hédi,Trabelsi,non,'].join('\n');
    const up3 = await upload(chefA, 'CONDUCTEURS', final, 'conducteurs.csv');
    const v3 = await chefA.post(`/imports/${up3.body.id}/validate`, { mapping, expectedVersion: up3.body.version });
    expect(v3.body.errorCount).toBe(0);
    expect((await commit(chefA, up3.body.id)).status).toBe(200);
    const drivers = await t.prisma.client.driver.findMany({ where: { code: { startsWith: 'IMP-D' } }, orderBy: { code: 'asc' } });
    expect(drivers.map((d) => [d.code, d.status, d.email])).toEqual([
      ['IMP-D1', 'ACTIF', 'salma@exemple.tn'],
      ['IMP-D2', 'INACTIF', null],
    ]);
  });

  it('bases d’entretien : plan créé sans intervention ni dépense ; colonnes exigées selon le mode', async () => {
    const vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'ENT-1' });
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-09-01T08:00:00Z' })).status).toBe(201);
    expect((await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).status).toBe(201);
    const header = 'company_code;vehicle_code;maintenance_type;interval_km;interval_months;base_mode;base_km;base_date';
    const bad = await uploadAndValidate(chefA, 'BASES_ENTRETIEN', [header, 'A;ENT-1;VIDANGE;10000;;DERNIERE_OPERATION;;', 'A;ENT-1;PNEUS;10000;;AUCUNE;;'].join('\n'), 'bases.csv');
    const rows = await rowsOf(chefA, bad.id);
    expect(rows[0]?.errors).toEqual([{ column: 'base_km', message: 'Indiquez le kilométrage cumulé de la base.' }]);
    expect(rows[1]?.errors).toEqual([{ column: 'maintenance_type', message: 'Opération « PNEUS » absente du catalogue actif.' }]);

    const ok = await uploadAndValidate(chefA, 'BASES_ENTRETIEN', [header, 'A;ENT-1;VIDANGE;10000;12;DERNIERE_OPERATION;80000;2026-03-01'].join('\n'), 'bases-ok.csv');
    expect(ok.errorCount).toBe(0);
    expect((await commit(chefA, ok.id)).status).toBe(200);
    const plan = await t.prisma.client.vehicleMaintenancePlan.findFirstOrThrow({ where: { vehicleId } });
    expect(plan.baseMode).toBe('DERNIERE_OPERATION');
    expect(plan.nextDueKm?.toString()).toBe('90000');
    expect(await t.prisma.client.intervention.count({ where: { vehicleId } })).toBe(0);
    expect(await t.prisma.client.expense.count({ where: { vehicleId } })).toBe(0);
  });

  it('périmètre : import réservé au chef et à l’administrateur ; lot d’un autre chef introuvable', async () => {
    const csv = [VEHICLE_HEADER, 'A;PER-001;333 TU 3001;Peugeot;208;VP;DIESEL;2022'].join('\n');
    expect((await upload(operateurA, 'VEHICULES', csv, 'v.csv')).status).toBe(403);
    expect((await operateurA.get('/imports/models')).status).toBe(403);
    expect((await operateurA.get('/imports/templates/VEHICULES?format=csv')).status).toBe(403);
    expect((await operateurA.get('/imports')).status).toBe(403);
    const up = await upload(chefA, 'VEHICULES', csv, 'v.csv');
    expect(up.status).toBe(201);
    expect((await chefB.get(`/imports/${up.body.id}`)).status).toBe(404);
    expect((await chefB.post(`/imports/${up.body.id}/validate`, { mapping: up.body.columnMapping, expectedVersion: 1 })).status).toBe(404);
    // Chaque point d'accès du lot (lignes, rapport, confirmation, abandon) applique le même périmètre.
    const validated = await chefA.post(`/imports/${up.body.id}/validate`, { mapping: up.body.columnMapping, expectedVersion: 1 });
    expect(validated.status).toBe(200);
    expect((await chefB.get(`/imports/${up.body.id}/rows`)).status).toBe(404);
    expect((await chefB.get(`/imports/${up.body.id}/report`)).status).toBe(404);
    expect((await commit(chefB, up.body.id)).status).toBe(404);
    expect((await chefB.post(`/imports/${up.body.id}/abandon`, { expectedVersion: validated.body.version })).status).toBe(404);
    expect((await chefA.get(`/imports/${up.body.id}`)).body.status).toBe('CONTROLE');
    expect(await t.prisma.client.vehicle.count({ where: { code: 'PER-001' } })).toBe(0);
    expect((await admin.get(`/imports/${up.body.id}`)).status).toBe(200);
    const list = await chefB.get('/imports');
    expect(list.body.total).toBe(0);
    // Un chef de B ne peut pas importer dans A.
    const other = await uploadAndValidate(chefB, 'VEHICULES', csv, 'v.csv');
    expect(other.errorCount).toBe(1);
  });

  it('XLSX : feuille « Données », dates typées ; formule sans valeur et fichier maquillé refusés ; modèles et rapport', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Données');
    ws.addRow(['company_code', 'vehicle_code', 'registration', 'make', 'model', 'category', 'commissioning_date']);
    ws.addRow(['A', 'XL-001', '444 TU 4001', 'Toyota', 'Hilux', 'VP', new Date(Date.UTC(2023, 4, 15))]);
    const up = await upload(chefA, 'VEHICULES', Buffer.from(await wb.xlsx.writeBuffer()), 'parc.xlsx');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const v = await chefA.post(`/imports/${up.body.id}/validate`, { mapping: up.body.columnMapping, expectedVersion: up.body.version });
    expect(v.body.errorCount).toBe(0);
    expect((await commit(chefA, up.body.id)).status).toBe(200);
    const created = await t.prisma.client.vehicle.findFirstOrThrow({ where: { code: 'XL-001' } });
    expect(created.commissioningDate?.toISOString().slice(0, 10)).toBe('2023-05-15');

    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet('Données');
    ws2.addRow(['company_code', 'vehicle_code']);
    ws2.addRow(['A', { formula: 'CONCAT("X","Y")' }]);
    const formula = await upload(chefA, 'VEHICULES', Buffer.from(await wb2.xlsx.writeBuffer()), 'formule.xlsx');
    expect(formula.status).toBe(422);
    expect(formula.body.code).toBe('FORMULE_SANS_VALEUR');

    const fake = await upload(chefA, 'VEHICULES', 'company_code;vehicle_code\nA;X', 'faux.xlsx');
    expect(fake.status).toBe(422);
    expect(fake.body.code).toBe('FORMAT_IMPORT');

    const csvTemplate = await chefA.get('/imports/templates/RELEVES?format=csv');
    expect(csvTemplate.status).toBe(200);
    expect(csvTemplate.text).toBe('﻿company_code;vehicle_code;observed_at;physical_km;meter_reference;initial_cumulative_km;note\r\n');
    const xlsxTemplate = await chefA.get('/imports/templates/VEHICULES').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const template = new ExcelJS.Workbook();
    await template.xlsx.load(xlsxTemplate.body);
    expect(template.worksheets.map((w) => w.name)).toEqual(['Données', 'Aide']);
    expect(template.getWorksheet('Données')?.getRow(1).values).toEqual([undefined, 'company_code', 'vehicle_code', 'registration', 'make', 'model', 'category', 'vin', 'energy', 'site', 'year', 'commissioning_date', 'tank_capacity_liters']);

    const bad = await uploadAndValidate(chefA, 'VEHICULES', [VEHICLE_HEADER, 'A;RAP-1;555 TU 5001;Peugeot;208;=HYPERLINK("x");DIESEL;2022'].join('\n'), 'rapport.csv');
    const report = await chefA.get(`/imports/${bad.id}/report`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('text/csv');
    const lines = report.text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('ligne;statut;colonne;message;objet_cree');
    expect(lines[1]).toBe('2;ERREUR;category;"Catégorie « =HYPERLINK(""x"") » inconnue ou archivée.";');
  });

  it('abandon d’un lot non confirmé ; un lot abandonné ne peut plus être confirmé', async () => {
    const ok = await uploadAndValidate(chefA, 'VEHICULES', [VEHICLE_HEADER, 'A;ABD-001;666 TU 6001;Peugeot;208;VP;DIESEL;2022'].join('\n'), 'abandon.csv');
    const res = await chefA.post(`/imports/${ok.id}/abandon`, { reason: 'Mauvais fichier', expectedVersion: ok.version });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ABANDONNE');
    const c = await commit(chefA, ok.id);
    expect(c.status).toBe(409);
    expect(await t.prisma.client.vehicle.count({ where: { code: 'ABD-001' } })).toBe(0);
  });
});
