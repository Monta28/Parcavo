import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../support/factories.js';
import { TEST_ORIGIN, resetDatabase, startTestApp, type TestApp } from '../support/test-app.js';

describe('Limitation de débit par adresse IP (CDC 16.1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ rateLimit: true });
    await resetDatabase(t.prisma);
    await seedFixture(t.prisma);
  });
  afterAll(async () => {
    await t.close();
  });

  it('renvoie 429 au-delà de dix tentatives de connexion par minute depuis la même adresse', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: `x${i}@test.local`, password: 'sans-importance' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const last = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'y@test.local', password: 'sans-importance' });
    expect(last.body.code).toBe('LIMITE_DEBIT');
    expect(last.headers['retry-after']).toBeTruthy();
  });
});
