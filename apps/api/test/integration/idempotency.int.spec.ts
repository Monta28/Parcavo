import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyService } from '../../src/common/idempotency.service.js';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

/**
 * CDC 15.3 : « les clés d'idempotence sont liées à l'utilisateur, à l'organisation et à l'opération ».
 * Une même valeur de clé réutilisée pour une autre opération, par un autre utilisateur ou dans une autre
 * organisation est une requête indépendante : elle s'exécute, sans rejouer ni bloquer la première.
 */
describe('Idempotency-Key liée à l’utilisateur, à l’organisation et à l’opération (CDC 15.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let other: Fixture;
  let admin: Agent;
  let otherAdmin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set('2026-09-24T10:00:00.000Z');
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    other = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    otherAdmin = await login(t.server, other.emails.admin, DEFAULT_PASSWORD);
  });

  it('service : même clé et même corps rejoués dans la même portée ; autre opération, autre utilisateur, autre organisation exécutés indépendamment ; corps différent → 409', async () => {
    const idempotency = t.app.get(IdempotencyService);
    const key = 'cle-partagee-0001';
    const body = { montant: '12.500' };
    let executions = 0;
    const work = (label: string) => async () => {
      executions += 1;
      return { status: 201, body: { label, execution: executions } };
    };
    const scope = { organizationId: f.organizationId, userId: f.users.admin, operation: 'essai.creation', key };

    const first = await idempotency.run(scope, body, work('initial'));
    expect(first).toMatchObject({ replayed: false, status: 201, body: { label: 'initial', execution: 1 } });

    // Même portée, même corps : réponse initiale rejouée, aucune nouvelle exécution.
    const replay = await idempotency.run(scope, body, work('rejeu'));
    expect(replay).toMatchObject({ replayed: true, status: 201, body: { label: 'initial', execution: 1 } });
    expect(executions).toBe(1);

    // Même clé, même corps, autre opération : exécution indépendante.
    const otherOperation = await idempotency.run({ ...scope, operation: 'essai.validation' }, body, work('autre opération'));
    expect(otherOperation).toMatchObject({ replayed: false, body: { label: 'autre opération', execution: 2 } });

    // Même clé, même corps, autre utilisateur de la même organisation : exécution indépendante.
    const otherUser = await idempotency.run({ ...scope, userId: f.users.chefA }, body, work('autre utilisateur'));
    expect(otherUser).toMatchObject({ replayed: false, body: { label: 'autre utilisateur', execution: 3 } });

    // Même clé, même corps, même opération, autre organisation : exécution indépendante.
    const otherOrganization = await idempotency.run({ ...scope, organizationId: other.organizationId, userId: other.users.admin }, body, work('autre organisation'));
    expect(otherOrganization).toMatchObject({ replayed: false, body: { label: 'autre organisation', execution: 4 } });
    expect(executions).toBe(4);

    // Chaque portée garde sa propre réponse rejouée.
    expect((await idempotency.run({ ...scope, operation: 'essai.validation' }, body, work('x'))).body).toEqual({ label: 'autre opération', execution: 2 });
    expect((await idempotency.run({ ...scope, organizationId: other.organizationId, userId: other.users.admin }, body, work('x'))).body).toEqual({ label: 'autre organisation', execution: 4 });
    expect(executions).toBe(4);

    // Même portée, corps différent : conflit, sans exécution.
    await expect(idempotency.run(scope, { montant: '13.000' }, work('corps différent'))).rejects.toMatchObject({ code: 'IDEMPOTENCE_CORPS_DIFFERENT' });
    expect(executions).toBe(4);

    const records = await t.prisma.client.idempotencyRecord.findMany({ where: { key }, orderBy: { createdAt: 'asc' } });
    expect(records).toHaveLength(4);
    expect(new Set(records.map((r) => `${r.organizationId}|${r.userId}|${r.operation}`)).size).toBe(4);
    expect(records.every((r) => r.status === 'TERMINE')).toBe(true);
  });

  it('HTTP : la même Idempotency-Key sert à deux opérations différentes et dans une autre organisation, chacune exécutée ; le rejeu reste propre à chaque opération', async () => {
    const key = 'cle-http-partagee-42';

    // Opération 1 : catalogue initial des opérations d'entretien (corps vide).
    const maintenance = await admin.post('/maintenance-types/initial-catalog').set('Idempotency-Key', key);
    expect(maintenance.status).toBe(200);
    expect(maintenance.body.created.length).toBeGreaterThan(0);
    const maintenanceCount = await t.prisma.client.maintenanceType.count({ where: { organizationId: f.organizationId } });
    expect(maintenanceCount).toBe(maintenance.body.created.length);

    // Opération 2, même clé et même corps vide : exécutée (types de documents créés), pas le rejeu de l'opération 1.
    const documents = await admin.post('/document-types/initial-catalog').set('Idempotency-Key', key);
    expect(documents.status).toBe(200);
    expect(documents.body.created.length).toBeGreaterThan(0);
    expect(documents.body).not.toEqual(maintenance.body);
    expect(await t.prisma.client.documentType.count({ where: { organizationId: f.organizationId } })).toBe(documents.body.created.length);

    // Rejeu de l'opération 1 avec la même clé : réponse initiale, rien de recréé.
    const replay = await admin.post('/maintenance-types/initial-catalog').set('Idempotency-Key', key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(maintenance.body);
    expect(await t.prisma.client.maintenanceType.count({ where: { organizationId: f.organizationId } })).toBe(maintenanceCount);

    // Autre organisation, même clé, même opération : exécution indépendante dans sa propre organisation.
    const elsewhere = await otherAdmin.post('/maintenance-types/initial-catalog').set('Idempotency-Key', key);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.created.length).toBe(maintenance.body.created.length);
    expect(elsewhere.body.created.map((c: { id: string }) => c.id)).not.toEqual(maintenance.body.created.map((c: { id: string }) => c.id));
    expect(await t.prisma.client.maintenanceType.count({ where: { organizationId: other.organizationId } })).toBe(maintenanceCount);

    const records = await t.prisma.client.idempotencyRecord.findMany({ where: { key }, select: { organizationId: true, userId: true, operation: true } });
    expect(records).toHaveLength(3);
    expect(records).toEqual(
      expect.arrayContaining([
        { organizationId: f.organizationId, userId: f.users.admin, operation: 'type_entretien.catalogue_initial' },
        { organizationId: f.organizationId, userId: f.users.admin, operation: 'type_document.catalogue_initial' },
        { organizationId: other.organizationId, userId: other.users.admin, operation: 'type_entretien.catalogue_initial' },
      ]),
    );
  });
});
