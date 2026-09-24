import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF_MIN = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1');

function upload(agent: Agent, server: TestApp['server'], buffer: Buffer, name: string, companyId?: string) {
  const req = request(server).post('/api/v1/attachments').set('Cookie', agent.cookies).set('X-CSRF-Token', agent.csrf).set('Origin', TEST_ORIGIN);
  if (companyId) req.field('companyId', companyId);
  return req.attach('file', buffer, name);
}

describe('Pièces jointes privées (CDC 16.2, T28)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;
  let chefB: Agent;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
  });

  it('accepte un PNG et un PDF, vérifie le type réel et renvoie un nom interne aléatoire', async () => {
    const png = await upload(chefA, t.server, PNG_1x1, 'photo.png', f.companies.A);
    expect(png.status).toBe(201);
    expect(png.body.mimeType).toBe('image/png');
    expect(png.body.sizeBytes).toBe(PNG_1x1.length);
    expect(png.body.downloadPath).toMatch(/^\/api\/v1\/attachments\/.+\/download$/);
    const pdf = await upload(chefA, t.server, PDF_MIN, 'facture.pdf', f.companies.A);
    expect(pdf.status).toBe(201);
    expect(pdf.body.mimeType).toBe('application/pdf');
    const pdfDownload = await chefA.get(`/attachments/${pdf.body.id}/download`);
    expect(pdfDownload.headers['content-disposition']).toMatch(/^attachment/);
    const stored = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: png.body.id } });
    expect(stored.storageKey).toMatch(/^[a-f0-9]{48}$/);
    expect(stored.storageKey).not.toContain('photo');
  });

  it('refuse un fichier HTML déguisé en image, un SVG et un fichier trop volumineux', async () => {
    const html = await upload(chefA, t.server, Buffer.from('<html><script>alert(1)</script></html>'), 'image.png', f.companies.A);
    expect(html.status).toBe(422);
    expect(html.body.code).toBe('TYPE_FICHIER_INTERDIT');
    const svg = await upload(chefA, t.server, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', f.companies.A);
    expect(svg.status).toBe(422);
    const activePdf = await upload(chefA, t.server, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1'), 'piege.pdf', f.companies.A);
    expect(activePdf.status).toBe(422);
    expect(activePdf.body.code).toBe('FICHIER_CONTENU_ACTIF');
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(10 * 1024 * 1024 + 1, 0)]);
    const tooBig = await upload(chefA, t.server, big, 'grand.png', f.companies.A);
    expect([413, 422]).toContain(tooBig.status);
    expect(await t.prisma.client.attachment.count()).toBe(0);
  });

  it('T28 — le fichier privé de la société B est inaccessible au chef de A, sans session et par son seul identifiant', async () => {
    const uploaded = await upload(chefB, t.server, PNG_1x1, 'prive-b.png', f.companies.B);
    expect(uploaded.status).toBe(201);
    const id = uploaded.body.id as string;
    const own = await chefB.get(`/attachments/${id}/download`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['cache-control']).toContain('no-store');
    const foreign = await chefA.get(`/attachments/${id}/download`);
    expect(foreign.status).toBe(404);
    const anonymousRead = await request(t.server).get(`/api/v1/attachments/${id}/download`);
    expect(anonymousRead.status).toBe(401);
    const stored = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id } });
    const direct = await request(t.server).get(`/storage/objects/${stored.storageKey}`);
    expect(direct.status).toBe(404);
  });

  it('refuse un téléversement hors périmètre (société B par le chef de A)', async () => {
    const res = await upload(chefA, t.server, PNG_1x1, 'x.png', f.companies.B);
    expect(res.status).toBe(404);
  });

  it('supprime logiquement un fichier avec motif et journalise la suppression', async () => {
    const uploaded = await upload(chefA, t.server, PNG_1x1, 'a.png', f.companies.A);
    const del = await chefA.delete(`/attachments/${uploaded.body.id}`).send({ reason: 'doublon' });
    expect(del.status).toBe(200);
    expect((await chefA.get(`/attachments/${uploaded.body.id}/download`)).status).toBe(404);
    const audit = await t.prisma.client.auditEvent.findFirst({ where: { action: 'piece_jointe.suppression' } });
    expect(audit?.reason).toBe('doublon');
  });
});
