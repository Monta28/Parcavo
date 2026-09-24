import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_PDF, login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

type Row = { id: string; reference: string; version: number; status: string; tasks: Array<{ id: string }> };

/**
 * Interventions : liste (tri, période civile, fournisseur, chargement en lot), kilomètres tronqués,
 * cohérence statut/dates au PATCH, coût après réouverture, facture sur un total nul, incident source
 * clôturé, relevé d'exécution et pièces jointes exposés (CDC 6.3, 6.4, 10.1, 13.1, 15.1, 15.3).
 */
describe('Interventions — liste, cohérence et fiche (CDC 6.3, 6.4, 13.1, 15.1, 15.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
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
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-B' });
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-06-01T08:00:00Z' })).status).toBe(201);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function create(extra: Record<string, unknown> = {}, vehicle = vehicleId): Promise<Row> {
    const res = await chefA.post('/interventions', { vehicleId: vehicle, kind: 'CORRECTIF', tasks: [{ label: 'Contrôle freins' }], ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Row;
  }

  function complete(i: Row, body: Record<string, unknown>) {
    return chefA.post(`/interventions/${i.id}/complete`, { completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version, ...body }).set('Idempotency-Key', randomUUID());
  }

  async function references(query: string): Promise<string[]> {
    const res = await chefA.get(`/interventions${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as Array<{ reference: string }>).map((x) => x.reference);
  }

  it('tri sur liste autorisée : référence, véhicule, statut, dates prévues et réelles ; tri inconnu refusé', async () => {
    const other = await createVehicle(t.prisma, f, 'A', { code: 'V-A' });
    const i1 = await create({ plannedStartAt: '2026-10-05T08:00:00+01:00' });
    const i2 = await create({}, other);
    const i3 = await create({ plannedStartAt: '2026-10-01T08:00:00+01:00' }, other);
    expect([i1.status, i2.status, i3.status]).toEqual(['PLANIFIEE', 'BROUILLON', 'PLANIFIEE']);
    const done = await complete(i2, { performedOn: '2026-09-20' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [r1, r2, r3] = [i1.reference, i2.reference, i3.reference];

    // Sans tri : création la plus récente d'abord.
    expect(await references('')).toEqual([r3, r2, r1]);
    expect(await references('?sort=reference&order=asc')).toEqual([r1, r2, r3]);
    expect(await references('?sort=reference&order=desc')).toEqual([r3, r2, r1]);
    // Véhicule (code), départagé par la référence.
    expect(await references('?sort=vehicleCode&order=asc')).toEqual([r2, r3, r1]);
    expect(await references('?sort=vehicleCode&order=desc')).toEqual([r1, r3, r2]);
    // Statut dans l'ordre du cycle de vie : PLANIFIEE avant TERMINEE.
    expect(await references('?sort=status&order=asc')).toEqual([r1, r3, r2]);
    // Dates prévues : dates absentes en dernier, dans les deux sens.
    expect(await references('?sort=plannedStartAt&order=asc')).toEqual([r3, r1, r2]);
    expect(await references('?sort=plannedStartAt&order=desc')).toEqual([r1, r3, r2]);
    // Date réelle (date effective) : seule i2 est réalisée ; les autres suivent, départagées par la référence.
    expect(await references('?sort=performedOn&order=desc')).toEqual([r2, r3, r1]);
    expect(await references('?sort=performedOn&order=asc')).toEqual([r2, r1, r3]);

    const unknown = await chefA.get('/interventions?sort=diagnosis');
    expect(unknown.status).toBe(422);
    expect(unknown.body.fieldErrors.sort).toBeDefined();
  });

  it('période en dates civiles du fuseau de l’organisation (Africa/Tunis) : date effective, sinon début réel, sinon début prévu', async () => {
    const a = await create({ plannedStartAt: '2026-10-01T23:30:00Z' }); // 2 octobre 00:30 à Tunis
    const b = await create({ plannedStartAt: '2026-10-02T23:30:00Z' }); // 3 octobre 00:30 à Tunis
    const c = await create({ plannedStartAt: '2026-10-01T22:30:00Z' }); // 1er octobre 23:30 à Tunis
    const d = await create(); // brouillon démarré sans date prévue
    const started = await chefA.post(`/interventions/${d.id}/start`, { startedAt: '2026-09-24T08:00:00Z', expectedVersion: d.version });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const e = await create({ plannedStartAt: '2026-10-02T10:00:00Z' }); // prévue le 2, réalisée le 23 septembre
    expect((await complete(e, { performedOn: '2026-09-23' })).status).toBe(200);

    expect(await references('?from=2026-10-02&to=2026-10-02')).toEqual([a.reference]);
    expect((await references('?to=2026-10-01')).sort()).toEqual([c.reference, d.reference, e.reference].sort());
    expect(await references('?from=2026-10-03')).toEqual([b.reference]);
    expect(await references('?from=2026-09-24&to=2026-09-24')).toEqual([d.reference]);
    expect(await references('?from=2026-09-23&to=2026-09-23')).toEqual([e.reference]);
    expect((await chefA.get('/interventions?from=2026-10-2')).status).toBe(422);
    const inverted = await chefA.get('/interventions?from=2026-10-03&to=2026-10-02');
    expect(inverted.status).toBe(422);
    expect(inverted.body).toMatchObject({ code: 'PERIODE_INVALIDE', fieldErrors: { to: [expect.any(String)] } });
  });

  it('historique d’un fournisseur : filtre supplierId, y compris après archivage', async () => {
    const s1 = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE' });
    const s2 = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage du Port', category: 'GARAGE' });
    expect(s1.status).toBe(201);
    const i1 = await create({ supplierId: s1.body.id });
    await create({ supplierId: s2.body.id });
    await create();
    expect(await references(`?supplierId=${s1.body.id}`)).toEqual([i1.reference]);
    expect((await chefA.post(`/suppliers/${s1.body.id}/archive`, { expectedVersion: s1.body.version })).status).toBe(200);
    const history = await chefA.get(`/interventions?supplierId=${s1.body.id}`);
    expect(history.body).toMatchObject({ total: 1, items: [{ id: i1.id, supplierName: 'Garage Central' }] });
    const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    expect((await chefB.get(`/interventions?supplierId=${s1.body.id}`)).body.total).toBe(0);
  });

  it('fiche : relevé d’exécution et kilomètres tronqués (jamais arrondis), pièces jointes avec métadonnées', async () => {
    const i = await create();
    const bon = await uploadPdf(chefA, t.server, f.companies.A, 'bon-travaux.pdf');
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'compteur.pdf');
    const done = await complete(i, { performedOn: '2026-09-24', newReading: { physicalKm: '90300.6', observedAt: '2026-09-24T09:00:00Z', attachmentId: photo }, attachmentIds: [bon] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.performedKm).toBe('90300');
    const view = (await chefA.get(`/interventions/${i.id}`)).body;
    expect(view.performedKm).toBe('90300');
    expect(view.executionReading).toEqual({
      id: view.performedReadingId,
      physicalKm: '90300',
      cumulativeKm: '90300',
      observedAt: '2026-09-24T09:00:00.000Z',
      source: 'MANUAL',
      measurementKind: 'COMPTEUR_AFFICHE',
      context: 'ENTRETIEN',
      status: 'ACCEPTE',
      isEstimate: false,
    });
    expect(view.attachments).toEqual([
      { id: bon, kind: 'INTERVENTION', originalName: 'bon-travaux.pdf', mimeType: 'application/pdf', sizeBytes: TEST_PDF.length, downloadPath: `/api/v1/attachments/${bon}/download` },
      { id: photo, kind: 'RELEVE', originalName: 'compteur.pdf', mimeType: 'application/pdf', sizeBytes: TEST_PDF.length, downloadPath: `/api/v1/attachments/${photo}/download` },
    ]);
    // La photo du compteur appartient au relevé lui-même (et non à l'intervention).
    expect(await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: photo } })).toMatchObject({ ownerType: 'RELEVE', ownerId: view.performedReadingId });
    expect((await chefA.get(`/attachments/${photo}/download`)).status).toBe(200);
    // La liste expose les mêmes informations.
    const listed = (await chefA.get('/interventions')).body.items[0];
    expect(listed.executionReading.physicalKm).toBe('90300');
    expect(listed.attachments).toHaveLength(2);
  });

  it('liste : dépenses et pièces jointes chargées en lot (aucune requête par intervention)', async () => {
    const rows: Row[] = [];
    for (let n = 0; n < 4; n += 1) rows.push(await create());
    const files: string[] = [];
    for (const [n, i] of rows.slice(0, 3).entries()) {
      const file = await uploadPdf(chefA, t.server, f.companies.A, `facture-${n}.pdf`);
      files.push(file);
      const res = await complete(i, { performedOn: '2026-09-24', totalAmount: `${100 + n}`, attachmentIds: [file] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const expenseFindFirst = vi.spyOn(t.prisma.client.expense, 'findFirst');
    const expenseFindMany = vi.spyOn(t.prisma.client.expense, 'findMany');
    const attachmentFindMany = vi.spyOn(t.prisma.client.attachment, 'findMany');
    const res = await chefA.get('/interventions?sort=reference&order=asc');
    expect(res.status).toBe(200);
    expect(expenseFindFirst).not.toHaveBeenCalled();
    expect(expenseFindMany).toHaveBeenCalledTimes(1);
    expect(attachmentFindMany).toHaveBeenCalledTimes(1);
    const expenses = await t.prisma.client.expense.findMany({ where: { sourceType: 'INTERVENTION' } });
    const items = res.body.items as Array<{ id: string; expenseId: string | null; attachments: Array<{ id: string }> }>;
    expect(items).toHaveLength(4);
    for (const [n, item] of items.entries()) {
      expect(item.expenseId).toBe(expenses.find((e) => e.sourceId === item.id)?.id ?? null);
      expect(item.attachments.map((a) => a.id)).toEqual(n < 3 ? [files[n]] : []);
    }
  });

  it('PATCH : effacer le début prévu d’une intervention planifiée est refusé ; des dates sur un brouillon ne le planifient pas', async () => {
    const planned = await create({ plannedStartAt: '2026-10-05T08:00:00+01:00' });
    const cleared = await chefA.patch(`/interventions/${planned.id}`, { plannedStartAt: null, expectedVersion: planned.version });
    expect(cleared.status).toBe(422);
    expect(cleared.body.code).toBe('DATE_PREVUE_REQUISE');
    expect(cleared.body.fieldErrors.plannedStartAt).toHaveLength(1);
    const unchanged = (await chefA.get(`/interventions/${planned.id}`)).body;
    expect(unchanged).toMatchObject({ status: 'PLANIFIEE', plannedStartAt: '2026-10-05T07:00:00.000Z', version: planned.version });
    // Changer la date d'une intervention planifiée reste possible (elle reste planifiée).
    const moved = await chefA.patch(`/interventions/${planned.id}`, { plannedStartAt: '2026-10-06T08:00:00+01:00', expectedVersion: planned.version });
    expect(moved.body).toMatchObject({ status: 'PLANIFIEE', plannedStartAt: '2026-10-06T07:00:00.000Z' });

    // Brouillon : les dates renseignées par PATCH ne changent pas le statut sans l'action « Planifier ».
    const draft = await create();
    const dated = await chefA.patch(`/interventions/${draft.id}`, { plannedStartAt: '2026-10-07T08:00:00+01:00', plannedEndAt: '2026-10-07T12:00:00+01:00', expectedVersion: draft.version });
    expect(dated.status, JSON.stringify(dated.body)).toBe(200);
    expect(dated.body).toMatchObject({ status: 'BROUILLON', plannedStartAt: '2026-10-07T07:00:00.000Z', plannedEndAt: '2026-10-07T11:00:00.000Z' });
    const plannedNow = await chefA.post(`/interventions/${draft.id}/plan`, { plannedStartAt: '2026-10-07T08:00:00+01:00', expectedVersion: dated.body.version });
    expect(plannedNow.body.status).toBe('PLANIFIEE');

    // En cours : les dates prévues restent facultatives.
    const running = await chefA.post(`/interventions/${planned.id}/start`, { expectedVersion: moved.body.version });
    expect(running.body.status).toBe('EN_COURS');
    const clearedRunning = await chefA.patch(`/interventions/${planned.id}`, { plannedStartAt: null, expectedVersion: running.body.version });
    expect(clearedRunning.body).toMatchObject({ status: 'EN_COURS', plannedStartAt: null });
  });

  it('réouverture : lignes de coût et total annulés ensemble, tracés dans l’audit ; jamais de lignes sans total', async () => {
    const i = await create();
    const done = await complete(i, { performedOn: '2026-09-24', lines: [{ kind: 'PIECE', label: 'Plaquettes', quantity: '2', unitPrice: '45.500' }, { kind: 'MAIN_OEUVRE', label: 'Pose', quantity: '1', unitPrice: '30' }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ costStatus: 'SAISI', totalAmount: '121.000' });
    expect(done.body.lines).toHaveLength(2);
    const reopened = await chefA.post(`/interventions/${i.id}/reopen`, { reason: 'Mauvaise date effective', expectedVersion: done.body.version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'EN_COURS', costStatus: 'A_SAISIR', totalAmount: null, expenseId: null, lines: [] });
    expect(await t.prisma.client.interventionLine.count({ where: { interventionId: i.id } })).toBe(0);
    const expense = await t.prisma.client.expense.findFirstOrThrow({ where: { sourceId: i.id } });
    expect(expense.status).toBe('ANNULEE');
    expect(expense.amount.toFixed(3)).toBe('121.000');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'intervention.reouverture', objectId: i.id } });
    expect(audit.before).toMatchObject({ costStatus: 'SAISI', total: '121.000', lines: [{ label: 'Plaquettes', amount: '91.000' }, { label: 'Pose', amount: '30.000' }] });
    expect(audit.after).toMatchObject({ costStatus: 'A_SAISIR', total: null, linesCancelled: 2, expenseCancelled: expense.id });
    // Nouvelle clôture : le coût est ressaisi, une seule dépense active.
    const again = await complete(reopened.body, { performedOn: '2026-09-23', totalAmount: '121' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ costStatus: 'SAISI', totalAmount: '121.000', lines: [] });
    expect(await t.prisma.client.expense.count({ where: { sourceId: i.id, status: 'VALIDEE' } })).toBe(1);
  });

  it('saisie du coût : une facture jointe à un total nul ou « sans coût » est refusée (422), jamais ignorée', async () => {
    const i = await create();
    const done = await complete(i, { performedOn: '2026-09-24' });
    expect(done.body.costStatus).toBe('A_SAISIR');
    const invoice = await uploadPdf(chefA, t.server, f.companies.A, 'facture-garantie.pdf');
    const zero = await chefA.post(`/interventions/${i.id}/cost`, { totalAmount: '0', invoiceAttachmentId: invoice, expectedVersion: done.body.version });
    expect(zero.status).toBe(422);
    expect(zero.body.code).toBe('FACTURE_SANS_COUT');
    expect(zero.body.fieldErrors.invoiceAttachmentId).toHaveLength(1);
    const zeroLines = await chefA.post(`/interventions/${i.id}/cost`, { lines: [{ kind: 'PIECE', label: 'Pièce sous garantie', quantity: '1', unitPrice: '0' }], invoiceAttachmentId: invoice, expectedVersion: done.body.version });
    expect(zeroLines.body.code).toBe('FACTURE_SANS_COUT');
    const noCost = await chefA.post(`/interventions/${i.id}/cost`, { noCost: true, invoiceAttachmentId: invoice, expectedVersion: done.body.version });
    expect(noCost.body.code).toBe('FACTURE_SANS_COUT');
    // Rien n'a changé : coût toujours à saisir, facture non rattachée, aucune dépense.
    expect((await chefA.get(`/interventions/${i.id}`)).body).toMatchObject({ costStatus: 'A_SAISIR', version: done.body.version, lines: [] });
    expect(await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: invoice } })).toMatchObject({ ownerId: null });
    // Avec un montant : dépense créée et facture visible sur la fiche.
    const paid = await chefA.post(`/interventions/${i.id}/cost`, { totalAmount: '80', invoiceAttachmentId: invoice, expectedVersion: done.body.version });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ costStatus: 'SAISI', totalAmount: '80.000' });
    expect(paid.body.attachments).toEqual([expect.objectContaining({ id: invoice, kind: 'FACTURE', originalName: 'facture-garantie.pdf' })]);
    expect(await t.prisma.client.expense.findFirstOrThrow({ where: { sourceId: i.id } })).toMatchObject({ attachmentId: invoice, status: 'VALIDEE' });
  });

  it('incident source clôturé : même refus sur POST /interventions et POST /incidents/:id/intervention', async () => {
    const incident = await chefA.post('/incidents', { vehicleId, type: 'PANNE', description: 'Bruit au freinage' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    // Ouvert : les deux chemins acceptent.
    await create({ incidentId: incident.body.id });
    const second = await chefA.post('/incidents', { vehicleId, type: 'DOMMAGE', description: 'Rayure portière arrière' });
    const closed = await chefA.post(`/incidents/${second.body.id}/transition`, { to: 'CLOTURE', note: 'Sans suite : doublon', expectedVersion: second.body.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('CLOTURE');
    const closedIncident = closed.body as { id: string; reference: string };
    const direct = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Réparation' }], incidentId: closedIncident.id });
    const fromIncident = await chefA.post(`/incidents/${closedIncident.id}/intervention`, { diagnosis: 'Réparation' });
    expect(direct.status).toBe(409);
    expect(fromIncident.status).toBe(409);
    expect(direct.body.code).toBe('ETAT_INVALIDE');
    expect(fromIncident.body.code).toBe('ETAT_INVALIDE');
    expect(direct.body.message).toBe(fromIncident.body.message);
    expect(direct.body.message).toContain(closedIncident.reference);
    expect(await t.prisma.client.intervention.count({ where: { incidentId: closedIncident.id } })).toBe(0);
  });
});
