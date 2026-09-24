import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

type Row = { id: string; reference: string; version: number; status: string; tasks: Array<{ id: string }> };
type AttachmentRow = { id: string; kind: string; downloadPath: string };

/**
 * Interventions — compléments de relecture : période civile inexistante refusée (422, jamais 500) et
 * pièces jointes de la fiche limitées à celles que l'utilisateur peut télécharger (même décision que
 * GET /attachments/:id/download, CDC 2.2, 16.2).
 */
describe('Interventions — période civile valide et pièces jointes autorisées (CDC 2.2, 15.1, 16.2)', () => {
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
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'V-R' });
    expect((await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-06-01T08:00:00Z' })).status).toBe(201);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function create(): Promise<Row> {
    const res = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Contrôle freins' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Row;
  }

  it('période : une date civile inexistante est refusée en 422 sur le champ, jamais en erreur serveur', async () => {
    await create();
    for (const [query, field] of [
      ['from=2026-02-30', 'from'],
      ['to=2026-02-29', 'to'],
      ['from=2026-13-01&to=2026-13-02', 'from'],
    ] as const) {
      const res = await chefA.get(`/interventions?${query}`);
      expect(res.status, `${query} : ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.code).toBe('VALIDATION');
      expect(res.body.fieldErrors[field]).toEqual(expect.arrayContaining([expect.stringMatching(/date/i)]));
    }
    // Une date bissextile réelle reste acceptée.
    expect((await chefA.get('/interventions?from=2028-02-29')).status).toBe(200);
  });

  it('clôture : une date effective inexistante est refusée en 422 sur le champ, sans rien modifier', async () => {
    const i = await create();
    const res = await chefA
      .post(`/interventions/${i.id}/complete`, { performedOn: '2026-02-30', completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version })
      .set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('VALIDATION');
    expect(res.body.fieldErrors.performedOn).toEqual(expect.arrayContaining([expect.stringMatching(/date/i)]));
    expect((await chefA.get(`/interventions/${i.id}`)).body).toMatchObject({ status: 'BROUILLON', performedOn: null, version: i.version });
  });

  it('fiche et liste : seules les pièces jointes téléchargeables par l’utilisateur sont exposées (lecteur sans costs.read)', async () => {
    const i = await create();
    const bon = await uploadPdf(chefA, t.server, f.companies.A, 'bon-travaux.pdf');
    const photo = await uploadPdf(chefA, t.server, f.companies.A, 'compteur.pdf');
    const done = await chefA
      .post(`/interventions/${i.id}/complete`, {
        performedOn: '2026-09-24',
        completedTaskIds: i.tasks.map((x) => x.id),
        newReading: { physicalKm: '90300.6', observedAt: '2026-09-24T09:00:00Z', attachmentId: photo },
        attachmentIds: [bon],
        totalAmount: '120',
        expectedVersion: i.version,
      })
      .set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // Chef de parc : bon de travaux et photo du relevé, tous deux téléchargeables.
    const chefView = (await chefA.get(`/interventions/${i.id}`)).body as { attachments: AttachmentRow[] };
    expect(chefView.attachments.map((a) => [a.id, a.kind])).toEqual([
      [bon, 'INTERVENTION'],
      [photo, 'RELEVE'],
    ]);

    // Lecteur sans costs.read : le bon de travaux (propriétaire INTERVENTION) ne lui est pas téléchargeable
    // (GET /attachments/:id/download → 404) ; il ne doit donc pas apparaître, même comme simple métadonnée.
    const lecteur = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    expect((await lecteur.get(`/attachments/${bon}/download`)).status).toBe(404);
    const readerView = await lecteur.get(`/interventions/${i.id}`);
    expect(readerView.status).toBe(200);
    const readerAttachments = readerView.body.attachments as AttachmentRow[];
    expect(readerAttachments.map((a) => [a.id, a.kind])).toEqual([[photo, 'RELEVE']]);
    for (const a of readerAttachments) expect((await lecteur.get(`/attachments/${a.id}/download`)).status).toBe(200);
    expect(readerView.body).toMatchObject({ totalAmount: null, expenseId: null, lines: [] });

    // Même règle sur la liste.
    const listed = await lecteur.get('/interventions');
    expect(listed.status).toBe(200);
    expect((listed.body.items[0].attachments as AttachmentRow[]).map((a) => a.id)).toEqual([photo]);
  });

  it('incident clôturé pendant la création : l’état est relu sous verrou dans la transaction (409, aucune intervention)', async () => {
    const incident = await chefA.post('/incidents', { vehicleId, type: 'PANNE', description: 'Bruit au freinage' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const incidentId = incident.body.id as string;
    // Clôture validée par une autre connexion juste après le contrôle initial (hors transaction) de
    // POST /interventions : le contrôle a lu OUVERT, la base porte désormais CLOTURE.
    const findFirst = t.prisma.client.incident.findFirst.bind(t.prisma.client.incident);
    vi.spyOn(t.prisma.client.incident, 'findFirst').mockImplementation((async (args: Parameters<typeof findFirst>[0]) => {
      const result = await findFirst(args);
      if (args?.where?.id === incidentId) await t.prisma.client.incident.update({ where: { id: incidentId }, data: { status: 'CLOTURE', closedAt: new Date('2026-09-24T09:59:00Z'), closureNote: 'Sans suite' } });
      return result;
    }) as never);
    const res = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Réparation' }], incidentId });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ETAT_INVALIDE');
    expect(res.body.message).toContain(incident.body.reference);
    expect(await t.prisma.client.intervention.count({ where: { incidentId } })).toBe(0);
  });
});
