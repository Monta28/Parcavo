import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyService } from '../../src/common/idempotency.service.js';
import { seedFixture, type Fixture } from '../support/factories.js';
import { resetDatabase, startTestApp, type TestApp } from '../support/test-app.js';

/**
 * CDC 15.3 : « les clés d'idempotence sont liées à l'utilisateur, à l'organisation et à l'opération ».
 * Une même valeur de clé réutilisée pour une autre opération, par un autre utilisateur ou dans une autre
 * organisation est une requête indépendante : elle s'exécute, sans rejouer ni bloquer la première.
 */
describe('Idempotency-Key liée à l’utilisateur, à l’organisation et à l’opération (CDC 15.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let other: Fixture;

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
});
