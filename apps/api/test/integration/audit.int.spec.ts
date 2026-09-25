import { randomUUID } from 'node:crypto';
import type { Prisma } from '@parc-auto/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/bootstrap.js';
import { REDACTED } from '../../src/common/secret-redaction.js';
import { COST_MASKED } from '../../src/domain/audit-cost-masking.js';
import { OTHER_COMPANY_AUTHOR } from '../../src/domain/vehicle-timeline.js';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import {
  TEST_ORIGIN,
  login,
  resetDatabase,
  startTestApp,
  type Agent,
  type TestApp,
} from '../support/test-app.js';

interface AuditItem {
  id: string;
  createdAt: string;
  companyId: string | null;
  companyCode: string | null;
  actorType: string;
  actorUserId: string | null;
  actorName: string;
  action: string;
  objectType: string;
  objectId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

interface TimelineItem {
  id: string;
  type: string;
  category: string;
  occurredAt: string;
  title: string;
  companyId: string | null;
  companyCode: string | null;
  access: 'COMPLET' | 'TECHNIQUE';
  actorName: string | null;
  objectType: string;
  objectId: string;
  objectAccessible: boolean;
  details: Array<{ label: string; value: string; kind: string }>;
}

const detail = (item: TimelineItem | undefined, label: string): string | undefined =>
  item?.details.find((d) => d.label === label)?.value;

describe('Journal d’audit et chronologie véhicule (CDC 16.1, 3.1 ; D-109, D-275, D-309)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;

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
    [admin, chefA, chefB, operateurA, lecteurA, conducteurA] = await Promise.all([
      login(t.server, f.emails.admin, DEFAULT_PASSWORD),
      login(t.server, f.emails.chefA, DEFAULT_PASSWORD),
      login(t.server, f.emails.chefB, DEFAULT_PASSWORD),
      login(t.server, f.emails.operateurA, DEFAULT_PASSWORD),
      login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD),
      login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD),
    ]);
  });

  async function auditEvent(
    data: Partial<Prisma.AuditEventUncheckedCreateInput> & { action: string },
  ): Promise<string> {
    const row = await t.prisma.client.auditEvent.create({
      data: {
        organizationId: f.organizationId,
        actorType: 'UTILISATEUR',
        objectType: 'Test',
        ...data,
      },
    });
    return row.id;
  }

  async function createVehicle(agent: Agent, company: 'A' | 'B', code: string): Promise<string> {
    const res = await agent.post('/vehicles', {
      companyId: f.companies[company],
      code,
      registration: `${code} TU 1`,
      make: 'Renault',
      model: 'Clio',
      categoryId: f.categoryId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function reading(
    agent: Agent,
    vehicleId: string,
    physicalKm: string,
    observedAt: string,
  ): Promise<string> {
    const res = await agent.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.reading.id as string;
  }

  async function timeline(
    agent: Agent,
    vehicleId: string,
    query = 'pageSize=100',
  ): Promise<{ status: number; items: TimelineItem[]; total: number; body: unknown }> {
    const res = await agent.get(`/vehicles/${vehicleId}/timeline?${query}`);
    return {
      status: res.status,
      items: (res.body.items ?? []) as TimelineItem[],
      total: res.body.total as number,
      body: res.body,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /audit
  // ---------------------------------------------------------------------------

  describe('GET /audit', () => {
    let eventA: string;
    let eventB: string;
    let eventOrg: string;

    beforeEach(async () => {
      eventA = await auditEvent({
        companyId: f.companies.A,
        actorUserId: f.users.chefA,
        action: 'releve.correction',
        objectType: 'OdometerReading',
        objectId: 'obj-a',
        reason: 'Erreur de saisie',
        createdAt: new Date('2026-09-10T23:30:00.000Z'),
        before: { physicalKm: '1000' },
        after: { physicalKm: '1100' },
      });
      eventB = await auditEvent({
        companyId: f.companies.B,
        actorUserId: f.users.chefB,
        action: 'releve.validation',
        objectType: 'OdometerReading',
        objectId: 'obj-b',
        createdAt: new Date('2026-09-12T08:00:00.000Z'),
      });
      eventOrg = await auditEvent({
        companyId: null,
        actorUserId: f.users.admin,
        action: 'parametre.modification',
        objectType: 'Setting',
        createdAt: new Date('2026-09-13T08:00:00.000Z'),
        before: { key: 'odometer.staleAfterDays', value: 7 },
        after: { key: 'odometer.staleAfterDays', value: 10 },
      });
      await auditEvent({
        companyId: null,
        actorType: 'SYSTEME',
        actorUserId: null,
        action: 'reservation.non_honoree',
        objectType: 'Reservation',
        objectId: 'obj-sys',
        createdAt: new Date('2026-09-14T08:00:00.000Z'),
      });
    });

    it('administrateur : toute l’organisation, y compris les événements sans société, du plus récent au plus ancien', async () => {
      // Un événement réel écrit par l'API (création de véhicule dans B) apparaît aussi.
      await createVehicle(admin, 'B', 'VB-1');
      const res = await admin.get('/audit?pageSize=100');
      expect(res.status).toBe(200);
      const items = res.body.items as AuditItem[];
      const ids = items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([eventA, eventB, eventOrg]));
      expect(
        items.some(
          (i) =>
            i.action === 'vehicule.creation' &&
            i.companyId === f.companies.B &&
            i.actorName === 'Alice Admin',
        ),
      ).toBe(true);
      const dates = items.map((i) => i.createdAt);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(res.body.total).toBe(items.length);
      const org = items.find((i) => i.id === eventOrg);
      expect(org).toMatchObject({
        companyId: null,
        companyCode: null,
        actorName: 'Alice Admin',
        before: { key: 'odometer.staleAfterDays', value: 7 },
        after: { key: 'odometer.staleAfterDays', value: 10 },
      });
      expect(items.find((i) => i.action === 'reservation.non_honoree')).toMatchObject({
        actorType: 'SYSTEME',
        actorName: 'Système',
      });
      expect(items.find((i) => i.id === eventA)).toMatchObject({
        companyCode: 'A',
        actorName: 'Chaima Chef-A',
        reason: 'Erreur de saisie',
      });
    });

    it('chef de parc : uniquement ses sociétés de rôle CHEF_PARC, jamais B ni les événements sans société', async () => {
      await createVehicle(chefA, 'A', 'VA-1');
      const res = await chefA.get('/audit?pageSize=100');
      expect(res.status).toBe(200);
      const items = res.body.items as AuditItem[];
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.every((i) => i.companyId === f.companies.A)).toBe(true);
      expect(items.map((i) => i.id)).toContain(eventA);
      expect(items.map((i) => i.id)).not.toContain(eventB);
      expect(items.map((i) => i.id)).not.toContain(eventOrg);
      expect(res.body.total).toBe(items.length);
      // Filtre explicite sur B : hors périmètre, 404 sans révéler son existence ; même par identifiant d'objet.
      expect((await chefA.get(`/audit?companyId=${f.companies.B}`)).status).toBe(404);
      expect((await chefA.get('/audit?objectId=obj-b')).body.total).toBe(0);
      // Les listes de valeurs des filtres suivent le même périmètre.
      const actions = (await chefA.get('/audit/actions')).body as Array<{
        action: string;
        count: number;
      }>;
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['releve.correction', 'vehicule.creation']),
      );
      expect(actions.map((a) => a.action)).not.toContain('releve.validation');
      expect(actions.map((a) => a.action)).not.toContain('parametre.modification');
      const actors = (await chefA.get('/audit/actors')).body as Array<{ actorName: string }>;
      expect(actors.map((a) => a.actorName)).not.toContain('Bilel Chef-B');
      const types = (await chefA.get('/audit/object-types')).body as Array<{ objectType: string }>;
      expect(types.map((x) => x.objectType)).not.toContain('Setting');
      // Le chef B ne voit pas A.
      const b = (await chefB.get('/audit?pageSize=100')).body.items as AuditItem[];
      expect(b.map((i) => i.id)).toEqual([eventB]);
    });

    it('opérateur, lecteur et conducteur : 403 sur le journal et ses listes de valeurs', async () => {
      for (const agent of [operateurA, lecteurA, conducteurA]) {
        for (const path of ['/audit', '/audit/actions', '/audit/actors', '/audit/object-types']) {
          const res = await agent.get(path);
          expect(res.status, path).toBe(403);
          expect(res.body.code).toBe('ACTION_INTERDITE');
        }
      }
    });

    it('ne renvoie jamais de secret : clés sensibles masquées à la lecture, même écrites par un autre chemin', async () => {
      const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
      const id = await auditEvent({
        companyId: f.companies.A,
        actorUserId: f.users.admin,
        action: 'test.secret',
        reason: 'Réinitialisation password=Hunter2-Secret',
        before: { password: 'Ancien-Secret-1', passwordHash: hash, status: 'ACTIF' },
        after: {
          token: 'jeton-tres-secret-123',
          nested: {
            apiKey: 'cle-api-987654',
            authorization: 'Bearer abcdefghijkl',
            kept: 'visible',
            list: [{ secret: 'dans-une-liste' }],
          },
          note: hash,
          baseUrl: 'https://user:mdp-url-secret@gps.example.com/api',
        },
      });
      for (const agent of [admin, chefA]) {
        const res = await agent.get(`/audit?objectType=Test&action=test.`);
        expect(res.status).toBe(200);
        const item = (res.body.items as AuditItem[]).find((i) => i.id === id);
        expect(item).toBeDefined();
        const raw = JSON.stringify(res.body);
        for (const secret of [
          'Ancien-Secret-1',
          hash,
          'jeton-tres-secret-123',
          'cle-api-987654',
          'abcdefghijkl',
          'dans-une-liste',
          'mdp-url-secret',
          'Hunter2-Secret',
        ]) {
          expect(raw, secret).not.toContain(secret);
        }
        expect(item?.before).toEqual({
          password: REDACTED,
          passwordHash: REDACTED,
          status: 'ACTIF',
        });
        expect(item?.after).toMatchObject({
          token: REDACTED,
          nested: {
            apiKey: REDACTED,
            authorization: REDACTED,
            kept: 'visible',
            list: [{ secret: REDACTED }],
          },
          note: REDACTED,
        });
      }
    });

    it('montants masqués pour un chef de parc sans costs.read sur la société de l’événement (D-266)', async () => {
      const id = await auditEvent({
        companyId: f.companies.A,
        actorUserId: f.users.chefA,
        action: 'depense.correction',
        objectType: 'Expense',
        objectId: 'exp-a',
        reason: 'Erreur de saisie',
        before: { status: 'VALIDEE', amount: '120.500', category: 'PEAGE', amountMismatch: false },
        after: {
          amount: '98.250',
          lines: [{ label: 'Plaquettes', unitPrice: '45.125' }],
          costStatus: 'SAISI',
        },
      });
      // Avec costs.read (défaut du chef) : montants lisibles.
      const withCosts = ((await chefA.get('/audit?objectType=Expense')).body.items as AuditItem[]).find(
        (i) => i.id === id,
      );
      expect(withCosts?.before).toMatchObject({ amount: '120.500' });
      // Permission retirée sur A : l'événement reste visible, sans aucun montant.
      await t.prisma.client.membership.updateMany({
        where: { userId: f.users.chefA, companyId: f.companies.A },
        data: { revokedPermissions: ['COSTS_READ', 'COSTS_WRITE'] },
      });
      const res = await chefA.get('/audit?objectType=Expense');
      expect(res.status).toBe(200);
      const item = (res.body.items as AuditItem[]).find((i) => i.id === id);
      expect(item?.before).toEqual({
        status: 'VALIDEE',
        amount: COST_MASKED,
        category: 'PEAGE',
        amountMismatch: false,
      });
      expect(item?.after).toEqual({
        amount: COST_MASKED,
        lines: [{ label: 'Plaquettes', unitPrice: COST_MASKED }],
        costStatus: 'SAISI',
      });
      const raw = JSON.stringify(res.body);
      for (const amount of ['120.5', '98.25', '45.125']) expect(raw, amount).not.toContain(amount);
      // L'administrateur garde les montants.
      const adminItem = (
        (await admin.get('/audit?objectType=Expense')).body.items as AuditItem[]
      ).find((i) => i.id === id);
      expect(adminItem?.after).toMatchObject({ amount: '98.250' });
    });

    it('filtres : période en jours civils locaux, acteur, préfixe d’action, type et identifiant d’objet, pagination', async () => {
      // 2026-09-10T23:30Z = 11/09 à 00:30 à Tunis : l'événement appartient au 11 septembre local.
      const day11 = (await admin.get('/audit?from=2026-09-11&to=2026-09-11')).body
        .items as AuditItem[];
      expect(day11.map((i) => i.id)).toEqual([eventA]);
      expect((await admin.get('/audit?from=2026-09-10&to=2026-09-10')).body.total).toBe(0);
      expect(
        ((await admin.get('/audit?from=2026-09-12')).body.items as AuditItem[]).map((i) => i.id),
      ).not.toContain(eventA);
      expect(
        ((await admin.get('/audit?to=2026-09-11')).body.items as AuditItem[]).map((i) => i.id),
      ).toEqual([eventA]);

      const byActor = (await admin.get(`/audit?actorUserId=${f.users.chefB}`)).body
        .items as AuditItem[];
      expect(byActor.map((i) => i.id)).toEqual([eventB]);
      // Les connexions sont aussi des événements système (auth.login) : on isole ici le type Reservation.
      const system = (await admin.get('/audit?actorType=SYSTEME&objectType=Reservation')).body
        .items as AuditItem[];
      expect(system.map((i) => i.action)).toEqual(['reservation.non_honoree']);
      expect(
        (await admin.get('/audit?actorType=UTILISATEUR&objectType=Reservation')).body.total,
      ).toBe(0);

      const releve = (await admin.get('/audit?action=releve.')).body.items as AuditItem[];
      expect(releve.map((i) => i.id)).toEqual([eventB, eventA]);
      expect(
        ((await admin.get('/audit?action=releve.correction')).body.items as AuditItem[]).map(
          (i) => i.id,
        ),
      ).toEqual([eventA]);
      // Le préfixe est littéral : « _ » n'est pas un joker (« releve_ » ne désigne pas « releve. »)…
      expect((await admin.get('/audit?action=releve_')).body.total).toBe(0);
      // … mais une action qui contient « _ » se retrouve par son nom exact ou son préfixe.
      expect(
        ((await admin.get('/audit?action=reservation.non_honoree')).body.items as AuditItem[]).map(
          (i) => i.objectId,
        ),
      ).toEqual(['obj-sys']);
      expect((await admin.get('/audit?action=reservation.non_')).body.total).toBe(1);
      expect(
        ((await admin.get('/audit?objectType=Setting')).body.items as AuditItem[]).map((i) => i.id),
      ).toEqual([eventOrg]);
      expect(
        ((await admin.get('/audit?objectId=obj-b')).body.items as AuditItem[]).map((i) => i.id),
      ).toEqual([eventB]);
      expect(
        ((await admin.get(`/audit?companyId=${f.companies.B}`)).body.items as AuditItem[]).map(
          (i) => i.id,
        ),
      ).toEqual([eventB]);

      const page1 = await admin.get('/audit?action=releve.&pageSize=1&page=1');
      const page2 = await admin.get('/audit?action=releve.&pageSize=1&page=2');
      expect(page1.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect([...page1.body.items, ...page2.body.items].map((i: AuditItem) => i.id)).toEqual([
        eventB,
        eventA,
      ]);
      expect((await admin.get('/audit?action=releve.&pageSize=1&page=3')).body.items).toEqual([]);

      const facets = (await admin.get(`/audit/actions?companyId=${f.companies.A}`)).body as Array<{
        action: string;
        count: number;
      }>;
      expect(facets).toEqual([{ action: 'releve.correction', count: 1 }]);
      const periodFacets = (await admin.get('/audit/object-types?from=2026-09-12&to=2026-09-14'))
        .body as Array<{ objectType: string; count: number }>;
      expect(periodFacets).toEqual([
        { objectType: 'OdometerReading', count: 1 },
        { objectType: 'Reservation', count: 1 },
        { objectType: 'Setting', count: 1 },
      ]);
    });

    it('valide les filtres (messages en français) et refuse une période inversée', async () => {
      const badDate = await admin.get('/audit?from=2026-02-30');
      expect(badDate.status).toBe(422);
      expect(badDate.body.code).toBe('PERIODE_INVALIDE');
      const reversed = await admin.get('/audit?from=2026-09-20&to=2026-09-01');
      expect(reversed.status).toBe(422);
      expect(reversed.body.fieldErrors.to).toBeDefined();
      const malformed = await admin.get(
        '/audit?from=24/09/2026&actorUserId=abc&action=a%25b&pageSize=500',
      );
      expect(malformed.status).toBe(422);
      expect(malformed.body.fieldErrors.from).toEqual(['Date attendue au format AAAA-MM-JJ.']);
      expect(malformed.body.fieldErrors.actorUserId).toEqual([
        'Identifiant d’utilisateur invalide.',
      ]);
      expect(malformed.body.fieldErrors.action[0]).toContain('Préfixe d’action invalide');
      expect(malformed.body.fieldErrors.pageSize[0]).toContain('Au plus 100');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /vehicles/:id/timeline
  // ---------------------------------------------------------------------------

  describe('GET /vehicles/:id/timeline', () => {
    it('trie par date (décroissante par défaut), pagine sans perte et filtre par catégorie', async () => {
      t.clock.set('2026-01-05T08:00:00.000Z');
      const vehicleId = await createVehicle(chefA, 'A', 'VA-ORD');
      t.clock.set('2026-09-24T10:00:00.000Z');
      await reading(chefA, vehicleId, '10000', '2026-02-01T08:00:00Z');
      await reading(chefA, vehicleId, '11000', '2026-03-01T08:00:00Z');
      await t.prisma.client.vehicleUsage.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a2,
          status: 'TERMINEE',
          purpose: 'Mission Sfax',
          checkedOutAt: new Date('2026-02-10T08:00:00Z'),
          expectedReturnAt: new Date('2026-02-11T18:00:00Z'),
          returnedAt: new Date('2026-02-11T17:00:00Z'),
          distanceStatus: 'VALIDEE',
          distanceKm: '420',
          checkedOutById: f.users.chefA,
          returnedById: f.users.chefA,
        },
      });
      await t.prisma.client.vehicleResponsibleAssignment.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a2,
          startsAt: new Date('2026-01-20T08:00:00Z'),
          endsAt: new Date('2026-12-31T08:00:00Z'),
          createdById: f.users.chefA,
        },
      });

      const all = await timeline(chefA, vehicleId);
      expect(all.status).toBe(200);
      // Création, 2 relevés, initialisation du compteur, remise, retour, début d'affectation (la fin future est exclue).
      expect(all.items.map((i) => i.type).sort()).toEqual(
        [
          'AFFECTATION_DEBUT',
          'COMPTEUR_INITIALISE',
          'RELEVE',
          'RELEVE',
          'UTILISATION_REMISE',
          'UTILISATION_RETOUR',
          'VEHICULE_CREE',
        ].sort(),
      );
      expect(all.total).toBe(7);
      const dates = all.items.map((i) => i.occurredAt);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(all.items[all.items.length - 1]).toMatchObject({
        type: 'VEHICULE_CREE',
        occurredAt: '2026-01-05T08:00:00.000Z',
        companyCode: 'A',
        actorName: 'Chaima Chef-A',
        access: 'COMPLET',
      });
      const retour = all.items.find((i) => i.type === 'UTILISATION_RETOUR');
      expect(retour).toMatchObject({
        title: 'Retour du véhicule',
        actorName: 'Chaima Chef-A',
        objectType: 'VehicleUsage',
        objectAccessible: true,
        category: 'UTILISATIONS',
        categoryLabel: 'Utilisations',
      });
      expect(retour?.details).toEqual(
        expect.arrayContaining([
          { label: 'Conducteur', value: 'Sami Deux', kind: 'TEXTE' },
          { label: 'Distance', value: '420.000', kind: 'KM' },
        ]),
      );

      const asc = await timeline(chefA, vehicleId, 'pageSize=100&order=asc');
      expect(asc.items.map((i) => i.id)).toEqual([...all.items.map((i) => i.id)].reverse());

      const paged: TimelineItem[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await timeline(chefA, vehicleId, `pageSize=3&page=${page}`);
        expect(res.total).toBe(7);
        paged.push(...res.items);
      }
      expect(paged.map((i) => i.id)).toEqual(all.items.map((i) => i.id));

      const km = await timeline(chefA, vehicleId, 'category=KILOMETRAGE');
      expect(km.items.map((i) => i.type)).toEqual(['RELEVE', 'RELEVE', 'COMPTEUR_INITIALISE']);
      expect(km.total).toBe(3);
      expect(km.items[0]).toMatchObject({ title: 'Relevé accepté', actorName: 'Chaima Chef-A' });
      expect(detail(km.items[0], 'Compteur')).toBe('11000.000');

      const invalid = await chefA.get(`/vehicles/${vehicleId}/timeline?category=INCONNUE&order=up`);
      expect(invalid.status).toBe(422);
      expect(invalid.body.fieldErrors.category).toEqual(['Catégorie inconnue.']);
    });

    it('404 hors périmètre (autre société, identifiant inconnu) ; lecteur sans costs.read : aucun montant', async () => {
      const vehicleId = await createVehicle(chefA, 'A', 'VA-SCOPE');
      const supplier = await t.prisma.client.supplier.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          name: 'Garage Alpha',
          category: 'GARAGE',
        },
      });
      await t.prisma.client.intervention.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          reference: 'INT-2026-900010',
          kind: 'CORRECTIF',
          status: 'TERMINEE',
          supplierId: supplier.id,
          completedAt: new Date('2026-09-01T15:00:00Z'),
          performedOn: new Date('2026-09-01T00:00:00Z'),
          totalAmount: '987.650',
          costStatus: 'SAISI',
          tasks: { create: [{ label: 'Remplacement plaquettes', completed: true }] },
        },
      });
      expect((await timeline(chefB, vehicleId)).status).toBe(404);
      expect((await timeline(chefA, randomUUID())).status).toBe(404);
      expect((await timeline(conducteurA, vehicleId)).status).toBe(404);

      const chef = (await timeline(chefA, vehicleId)).items.find(
        (i) => i.type === 'INTERVENTION_TERMINEE',
      );
      expect(chef).toMatchObject({ access: 'COMPLET', objectAccessible: true });
      expect(detail(chef, 'Montant')).toBe('987.650');
      expect(detail(chef, 'Fournisseur')).toBe('Garage Alpha');
      expect(detail(chef, 'Référence')).toBe('INT-2026-900010');

      const reader = await timeline(lecteurA, vehicleId);
      expect(reader.status).toBe(200);
      const readerItem = reader.items.find((i) => i.type === 'INTERVENTION_TERMINEE');
      expect(readerItem).toBeDefined();
      expect(detail(readerItem, 'Montant')).toBeUndefined();
      expect(JSON.stringify(reader.body)).not.toContain('987.65');
    });

    it('conducteur : seulement ses propres utilisations, soumissions et incidents, sans nommer d’autres utilisateurs', async () => {
      const vehicleId = await createVehicle(chefA, 'A', 'VA-DRV');
      await reading(chefA, vehicleId, '20000', '2026-08-01T08:00:00Z');
      const segment = await t.prisma.client.odometerSegment.findFirstOrThrow({
        where: { vehicleId },
      });
      // Responsable habituel actif : le dossier lui est accessible (règle de VehiclesService.load).
      await t.prisma.client.vehicleResponsibleAssignment.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a1,
          startsAt: new Date('2026-08-01T08:00:00Z'),
          createdById: f.users.chefA,
        },
      });
      const own = await t.prisma.client.vehicleUsage.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a1,
          status: 'TERMINEE',
          purpose: 'Livraison',
          checkedOutAt: new Date('2026-08-05T08:00:00Z'),
          expectedReturnAt: new Date('2026-08-05T18:00:00Z'),
          returnedAt: new Date('2026-08-05T17:00:00Z'),
          checkedOutById: f.users.chefA,
          returnedById: f.users.chefA,
        },
      });
      const other = await t.prisma.client.vehicleUsage.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a2,
          status: 'TERMINEE',
          purpose: 'Visite client',
          checkedOutAt: new Date('2026-08-06T08:00:00Z'),
          expectedReturnAt: new Date('2026-08-06T18:00:00Z'),
          returnedAt: new Date('2026-08-06T17:00:00Z'),
          checkedOutById: f.users.chefA,
        },
      });
      const submitted = await t.prisma.client.odometerReading.create({
        data: {
          organizationId: f.organizationId,
          companyId: f.companies.A,
          vehicleId,
          segmentId: segment.id,
          source: 'MANUAL',
          context: 'RELEVE_LIBRE',
          status: 'EN_ATTENTE',
          physicalKm: '20500',
          observedAt: new Date('2026-08-05T16:55:00Z'),
          statusReason: 'Hausse à confirmer',
          createdById: f.users.conducteurA,
        },
      });
      const mine = await t.prisma.client.incident.create({
        data: {
          organizationId: f.organizationId,
          reference: 'INC-2026-900001',
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a1,
          type: 'CREVAISON',
          severity: 'FAIBLE',
          occurredAt: new Date('2026-08-05T12:00:00Z'),
          description: 'Pneu avant droit',
          reportedById: f.users.chefA,
        },
      });
      await t.prisma.client.incident.create({
        data: {
          organizationId: f.organizationId,
          reference: 'INC-2026-900002',
          companyId: f.companies.A,
          vehicleId,
          driverId: f.drivers.a2,
          type: 'DOMMAGE',
          severity: 'MOYENNE',
          occurredAt: new Date('2026-08-06T12:00:00Z'),
          description: 'Rayure portière',
          reportedById: f.users.chefA,
        },
      });

      const res = await timeline(conducteurA, vehicleId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.items.map((i) => `${i.type}:${i.objectId}`).sort()).toEqual(
        [
          `INCIDENT_DECLARE:${mine.id}`,
          `RELEVE:${submitted.id}`,
          `UTILISATION_REMISE:${own.id}`,
          `UTILISATION_RETOUR:${own.id}`,
        ].sort(),
      );
      expect(res.total).toBe(4);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(other.id);
      expect(raw).not.toContain('Sami');
      expect(raw).not.toContain('Chaima');
      expect(res.items.find((i) => i.type === 'RELEVE')).toMatchObject({
        title: 'Relevé en attente de validation',
        actorName: 'Karim Conducteur-A',
      });
      expect(res.items.find((i) => i.type === 'UTILISATION_REMISE')?.actorName).toBeNull();
      // Pas de catégorie étrangère à ses utilisations et soumissions.
      expect((await timeline(conducteurA, vehicleId, 'category=AFFECTATIONS')).total).toBe(0);
      expect((await timeline(conducteurA, vehicleId, 'category=DOSSIER')).total).toBe(0);
    });

    it('après transfert (D-275) : la société courante voit relevés, plans et interventions terminées en vue technique, jamais les utilisations ni montants antérieurs', async () => {
      t.clock.set('2026-01-05T08:00:00.000Z');
      const vehicleId = await createVehicle(admin, 'A', 'VA-TRF');
      t.clock.set('2026-09-24T10:00:00.000Z');
      const readingA = await reading(chefA, vehicleId, '10000', '2026-02-01T08:00:00Z');
      const org = f.organizationId;
      const A = f.companies.A;
      const B = f.companies.B;
      const usage = await t.prisma.client.vehicleUsage.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          driverId: f.drivers.a2,
          status: 'TERMINEE',
          purpose: 'Tournée confidentielle',
          checkedOutAt: new Date('2026-03-01T08:00:00Z'),
          expectedReturnAt: new Date('2026-03-02T18:00:00Z'),
          returnedAt: new Date('2026-03-02T17:00:00Z'),
          checkedOutById: f.users.chefA,
        },
      });
      const incident = await t.prisma.client.incident.create({
        data: {
          organizationId: org,
          reference: 'INC-2026-900100',
          companyId: A,
          vehicleId,
          driverId: f.drivers.a2,
          type: 'ACCIDENT',
          severity: 'ELEVEE',
          occurredAt: new Date('2026-03-05T09:00:00Z'),
          description: 'Accrochage',
          reportedById: f.users.chefA,
        },
      });
      const reservation = await t.prisma.client.reservation.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          driverId: f.drivers.a2,
          startAt: new Date('2026-03-20T08:00:00Z'),
          endAt: new Date('2026-03-21T08:00:00Z'),
          purpose: 'Salon',
          status: 'ANNULEE',
          cancelledAt: new Date('2026-03-12T08:00:00Z'),
          cancelReason: 'Salon reporté',
          createdById: f.users.chefA,
          createdAt: new Date('2026-03-10T08:00:00Z'),
        },
      });
      const assignment = await t.prisma.client.vehicleResponsibleAssignment.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          driverId: f.drivers.a2,
          startsAt: new Date('2026-02-10T08:00:00Z'),
          endsAt: new Date('2026-05-01T08:00:00Z'),
          createdById: f.users.chefA,
        },
      });
      const immobilization = await t.prisma.client.immobilization.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          status: 'TERMINEE',
          startedAt: new Date('2026-04-01T08:00:00Z'),
          endedAt: new Date('2026-04-10T08:00:00Z'),
          createdById: f.users.chefA,
        },
      });
      const supplier = await t.prisma.client.supplier.create({
        data: { organizationId: org, companyId: A, name: 'Garage Secret', category: 'GARAGE' },
      });
      const done = await t.prisma.client.intervention.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          reference: 'INT-2026-900100',
          kind: 'PREVENTIF',
          status: 'TERMINEE',
          supplierId: supplier.id,
          diagnosis: 'Diagnostic interne',
          completedAt: new Date('2026-04-10T15:00:00Z'),
          performedOn: new Date('2026-04-10T00:00:00Z'),
          performedKm: '12000',
          totalAmount: '1234.500',
          costStatus: 'SAISI',
          createdById: f.users.chefA,
          createdAt: new Date('2026-04-09T08:00:00Z'),
          tasks: { create: [{ label: 'Vidange moteur', completed: true }] },
        },
      });
      const cancelled = await t.prisma.client.intervention.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          reference: 'INT-2026-900101',
          kind: 'CORRECTIF',
          status: 'ANNULEE',
          cancelledAt: new Date('2026-04-12T08:00:00Z'),
          cancelReason: 'Doublon',
          createdById: f.users.chefA,
          createdAt: new Date('2026-04-11T08:00:00Z'),
        },
      });
      const type = await t.prisma.client.maintenanceType.create({
        data: { organizationId: org, code: 'VIDANGE', label: 'Vidange' },
      });
      const plan = await t.prisma.client.vehicleMaintenancePlan.create({
        data: {
          organizationId: org,
          companyId: A,
          vehicleId,
          maintenanceTypeId: type.id,
          intervalKm: '10000',
          baseMode: 'AUCUNE',
          createdById: f.users.chefA,
          createdAt: new Date('2026-02-02T08:00:00Z'),
        },
      });
      const docType = await t.prisma.client.documentType.create({
        data: { organizationId: org, code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE' },
      });
      const privateDoc = await t.prisma.client.documentVersion.create({
        data: {
          organizationId: org,
          companyId: A,
          documentTypeId: docType.id,
          ownerType: 'VEHICULE',
          vehicleId,
          number: 'POL-PRIVEE',
          validTo: new Date('2026-12-31T00:00:00Z'),
          createdById: f.users.chefA,
          createdAt: new Date('2026-02-03T08:00:00Z'),
        },
      });
      const sharedDoc = await t.prisma.client.documentVersion.create({
        data: {
          organizationId: org,
          companyId: A,
          documentTypeId: docType.id,
          ownerType: 'VEHICULE',
          vehicleId,
          number: 'POL-PARTAGEE',
          validFrom: new Date('2026-06-01T00:00:00Z'),
          validTo: new Date('2027-05-31T00:00:00Z'),
          previousVersionId: privateDoc.id,
          createdById: f.users.chefA,
          createdAt: new Date('2026-05-20T08:00:00Z'),
        },
      });

      // Transfert A → B (écrit directement : société courante, historique, documents partagés).
      const transferAt = new Date('2026-06-01T08:00:00Z');
      await t.prisma.client.$transaction([
        t.prisma.client.vehicle.update({
          where: { id: vehicleId },
          data: { companyId: B, version: { increment: 1 } },
        }),
        t.prisma.client.vehicleCompanyHistory.create({
          data: {
            organizationId: org,
            vehicleId,
            fromCompanyId: A,
            toCompanyId: B,
            effectiveAt: transferAt,
            reason: 'Réorganisation régionale',
            sharedDocumentIds: [sharedDoc.id],
            createdById: f.users.admin,
          },
        }),
        t.prisma.client.documentVersion.update({
          where: { id: sharedDoc.id },
          data: { sharedWithCompanyIds: { push: B } },
        }),
      ]);
      const readingB = await reading(chefB, vehicleId, '15000', '2026-07-01T08:00:00Z');

      // L'ancienne société n'a plus accès à la fiche courante (D-275) : 404.
      expect((await timeline(chefA, vehicleId)).status).toBe(404);

      const b = await timeline(chefB, vehicleId);
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      const byId = (id: string, typeName: string) =>
        b.items.find((i) => i.objectId === id && i.type === typeName);
      // Relevé de A : visible, auteur masqué, vue technique ; relevé de B : complet et nommé.
      expect(byId(readingA, 'RELEVE')).toMatchObject({
        access: 'TECHNIQUE',
        actorName: OTHER_COMPANY_AUTHOR,
        companyCode: 'A',
        objectAccessible: false,
      });
      expect(detail(byId(readingA, 'RELEVE'), 'Compteur')).toBe('10000.000');
      expect(byId(readingB, 'RELEVE')).toMatchObject({
        access: 'COMPLET',
        actorName: 'Bilel Chef-B',
        companyCode: 'B',
      });
      // Compteur initialisé chez A : technique, auteur masqué.
      expect(b.items.find((i) => i.type === 'COMPTEUR_INITIALISE')).toMatchObject({
        access: 'TECHNIQUE',
        actorName: OTHER_COMPANY_AUTHOR,
      });
      // Plan de A : visible en vue technique.
      expect(byId(plan.id, 'PLAN_CREE')).toMatchObject({
        access: 'TECHNIQUE',
        actorName: OTHER_COMPANY_AUTHOR,
      });
      // Intervention TERMINEE de A : date, km, opérations ; sans montant, fournisseur ni référence.
      const technical = byId(done.id, 'INTERVENTION_TERMINEE');
      expect(technical).toMatchObject({
        access: 'TECHNIQUE',
        actorName: OTHER_COMPANY_AUTHOR,
        objectAccessible: false,
      });
      expect(detail(technical, 'Opérations')).toBe('Vidange moteur');
      expect(detail(technical, 'Kilométrage')).toBe('12000.000');
      expect(detail(technical, 'Réalisée le')).toBe('2026-04-10');
      expect(detail(technical, 'Montant')).toBeUndefined();
      expect(detail(technical, 'Fournisseur')).toBeUndefined();
      expect(detail(technical, 'Référence')).toBeUndefined();
      // Création et annulation d'interventions de A : invisibles.
      expect(byId(done.id, 'INTERVENTION_CREEE')).toBeUndefined();
      expect(b.items.some((i) => i.objectId === cancelled.id)).toBe(false);
      // Documents : seule la version partagée est visible.
      expect(byId(sharedDoc.id, 'DOCUMENT_RENOUVELE')).toMatchObject({ access: 'TECHNIQUE' });
      expect(b.items.some((i) => i.objectId === privateDoc.id)).toBe(false);
      // Jamais les utilisations, incidents, réservations, immobilisations ni affectations antérieurs de A.
      for (const id of [usage.id, incident.id, reservation.id, assignment.id, immobilization.id]) {
        expect(
          b.items.some((i) => i.objectId === id),
          id,
        ).toBe(false);
      }
      expect(
        b.items.some((i) =>
          ['UTILISATIONS', 'INCIDENTS', 'RESERVATIONS', 'IMMOBILISATIONS', 'AFFECTATIONS'].includes(
            i.category,
          ),
        ),
      ).toBe(false);
      // Transfert et création du dossier.
      const transfer = b.items.find((i) => i.type === 'SOCIETE_TRANSFERT');
      expect(transfer).toMatchObject({
        access: 'COMPLET',
        actorName: 'Alice Admin',
        occurredAt: transferAt.toISOString(),
      });
      expect(detail(transfer, 'Société précédente')).toBe('A');
      expect(detail(transfer, 'Nouvelle société')).toBe('B');
      expect(b.items.find((i) => i.type === 'VEHICULE_CREE')).toMatchObject({
        access: 'TECHNIQUE',
        actorName: OTHER_COMPANY_AUTHOR,
        companyCode: 'A',
      });
      // Aucune fuite dans le corps : ni personne, ni montant, ni texte libre de A.
      const raw = JSON.stringify(b.body);
      for (const leak of [
        'Sami',
        'Chaima',
        'Tournée confidentielle',
        '1234.5',
        'Garage Secret',
        'Diagnostic interne',
        'POL-PRIVEE',
        'Salon',
        'INT-2026-900100',
      ]) {
        expect(raw, leak).not.toContain(leak);
      }
      expect(b.total).toBe(b.items.length);

      // L'administrateur conserve la vue complète (2.4), montants compris.
      const all = await timeline(admin, vehicleId);
      for (const id of [
        usage.id,
        incident.id,
        reservation.id,
        assignment.id,
        immobilization.id,
        cancelled.id,
        privateDoc.id,
      ]) {
        expect(
          all.items.some((i) => i.objectId === id),
          id,
        ).toBe(true);
      }
      const full = all.items.find(
        (i) => i.objectId === done.id && i.type === 'INTERVENTION_TERMINEE',
      );
      expect(full).toMatchObject({ access: 'COMPLET' });
      expect(detail(full, 'Montant')).toBe('1234.500');
      expect(all.items.find((i) => i.objectId === readingA)).toMatchObject({
        access: 'COMPLET',
        actorName: 'Chaima Chef-A',
      });
    });
  });
  it('routes documentées dans OpenAPI et refusées sans session (401)', async () => {
    const openapi = buildOpenApiDocument(t.app);
    for (const path of [
      '/api/v1/audit',
      '/api/v1/audit/actions',
      '/api/v1/audit/actors',
      '/api/v1/audit/object-types',
    ]) {
      expect(openapi.paths[path]?.get?.tags, path).toEqual(['audit']);
      expect(openapi.paths[path]?.get?.summary, path).toBeTruthy();
      expect(openapi.paths[path]?.get?.responses?.['200'], path).toBeDefined();
    }
    const timelinePath = openapi.paths['/api/v1/vehicles/{id}/timeline']?.get;
    expect(timelinePath?.tags).toEqual(['vehicles']);
    expect(timelinePath?.summary).toBeTruthy();
    expect(timelinePath?.responses?.['200']).toBeDefined();
    for (const path of ['/api/v1/audit', `/api/v1/vehicles/${randomUUID()}/timeline`]) {
      expect((await request(t.server).get(path).set('Origin', TEST_ORIGIN)).status, path).toBe(401);
    }
  });
});
