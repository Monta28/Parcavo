import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { TEST_ORIGIN, anonymous, login, resetDatabase, startTestApp, type TestApp } from '../support/test-app.js';

describe('Authentification et sessions (CDC 16.1, T32)', () => {
  let t: TestApp;
  let f: Fixture;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
  });

  it('ouvre une session en cookie HttpOnly et renvoie le profil et les habilitations', async () => {
    const res = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefA, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(f.emails.chefA);
    expect(res.body.isAdmin).toBe(false);
    expect(res.body.grants).toHaveLength(1);
    expect(res.body.grants[0].role).toBe('CHEF_PARC');
    expect(res.body.grants[0].permissions).toContain('readings.approve');
    expect(res.body.companies.map((c: { code: string }) => c.code)).toEqual(['A']);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('pa_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(res.headers['x-request-id']).toBeTruthy();
    // aucun jeton dans le corps
    expect(JSON.stringify(res.body)).not.toMatch(/pa_session|tokenHash|passwordHash/);
  });

  it('refuse un mot de passe invalide avec un message non énumérant, identique pour un compte inconnu', async () => {
    const bad = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefA, password: 'faux-mot-de-passe' });
    const unknown = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'inconnu@test.local', password: 'faux-mot-de-passe' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.message).toBe(unknown.body.message);
    expect(bad.body.code).toBe('NON_AUTHENTIFIE');
  });

  it('bloque après cinq échecs consécutifs sur la même adresse (429) même avec le bon mot de passe', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefB, password: 'faux' });
    }
    const blocked = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefB, password: DEFAULT_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('LIMITE_DEBIT');
    // après la fenêtre de quinze minutes, la connexion redevient possible
    t.clock.advance(16 * 60 * 1000);
    const ok = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefB, password: DEFAULT_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('exige une session pour les routes protégées et la révoque à la déconnexion', async () => {
    expect((await anonymous(t.server).get('/auth/session')).status).toBe(401);
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await chef.get('/auth/session')).status).toBe(200);
    expect((await chef.post('/auth/logout')).status).toBe(200);
    const after = await chef.get('/auth/session');
    expect(after.status).toBe(401);
  });

  it('protège les mutations : jeton CSRF obligatoire et origine contrôlée', async () => {
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const noCsrf = await request(t.server).post('/api/v1/auth/logout').set('Cookie', chef.cookies).set('Origin', TEST_ORIGIN);
    expect(noCsrf.status).toBe(403);
    const badOrigin = await request(t.server).post('/api/v1/auth/logout').set('Cookie', chef.cookies).set('X-CSRF-Token', chef.csrf).set('Origin', 'https://attaquant.example');
    expect(badOrigin.status).toBe(403);
    const wrongToken = await request(t.server).post('/api/v1/auth/logout').set('Cookie', chef.cookies).set('X-CSRF-Token', 'faux').set('Origin', TEST_ORIGIN);
    expect(wrongToken.status).toBe(403);
    expect((await chef.get('/auth/session')).status).toBe(200);
  });

  it('T32 — un compte désactivé perd immédiatement sa session ; la mutation et la lecture sont refusées', async () => {
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    expect((await chef.get('/auth/session')).status).toBe(200);
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const disabled = await admin.post(`/users/${f.users.chefA}/disable`, { reason: 'départ de la société' });
    expect(disabled.status).toBe(200);
    expect((await chef.get('/auth/session')).status).toBe(401);
    expect((await chef.post('/auth/change-password', { currentPassword: DEFAULT_PASSWORD, newPassword: 'Nouveau-Mot-De-Passe-1' })).status).toBe(401);
    const relogin = await request(t.server).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefA, password: DEFAULT_PASSWORD });
    expect(relogin.status).toBe(401);
  });

  it('expire la session après la durée configurée (douze heures)', async () => {
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    t.clock.advance(11 * 3600 * 1000);
    expect((await chef.get('/auth/session')).status).toBe(200);
    t.clock.advance(2 * 3600 * 1000);
    expect((await chef.get('/auth/session')).status).toBe(401);
  });

  it('sans SMTP : aucune file d’envoi, réponse identique, lien d’accès à usage unique généré par l’administrateur (16.1, D-263)', async () => {
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const forgot = await request(t.server).post('/api/v1/auth/forgot-password').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefA });
    expect(forgot.status).toBe(200);
    const unknown = await request(t.server).post('/api/v1/auth/forgot-password').set('Origin', TEST_ORIGIN).send({ email: 'inconnu@test.local' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(forgot.body);
    expect(await t.prisma.client.notificationOutbox.count()).toBe(0);
    expect(await t.prisma.client.passwordResetToken.count()).toBe(0);
    expect((await chef.get('/auth/session')).body.emailChannelConfigured).toBe(false);

    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    expect((await admin.post(`/users/${f.users.chefA}/resend-invitation`)).body.code).toBe('CANAL_EMAIL_NON_CONFIGURE');
    expect((await chef.post(`/users/${f.users.chefA}/access-link`, { purpose: 'REINITIALISATION' })).status).toBe(403);
    const first = await admin.post(`/users/${f.users.chefA}/access-link`, { purpose: 'REINITIALISATION' });
    expect(first.status).toBe(201);
    const second = await admin.post(`/users/${f.users.chefA}/access-link`, { purpose: 'REINITIALISATION' });
    const tokenOf = (link: string) => /token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? '';
    // Le premier lien est invalidé par le second ; le jeton n'est stocké qu'en empreinte.
    expect((await request(t.server).post('/api/v1/auth/reset-password').set('Origin', TEST_ORIGIN).send({ token: tokenOf(first.body.link), newPassword: 'Nouveau-Mot-De-Passe-1' })).status).toBe(422);
    const stored = await t.prisma.client.passwordResetToken.findMany();
    expect(stored.every((r) => r.tokenHash !== tokenOf(second.body.link))).toBe(true);
    const audit = await t.prisma.client.auditEvent.findMany({ where: { action: 'users.lien_acces' } });
    expect(JSON.stringify(audit)).not.toContain(tokenOf(second.body.link));
    const reset = await request(t.server).post('/api/v1/auth/reset-password').set('Origin', TEST_ORIGIN).send({ token: tokenOf(second.body.link), newPassword: 'Nouveau-Mot-De-Passe-1' });
    expect(reset.status).toBe(200);
    expect((await chef.get('/auth/session')).status).toBe(401);
    expect((await (await login(t.server, f.emails.chefA, 'Nouveau-Mot-De-Passe-1')).get('/auth/session')).status).toBe(200);
  });

  it('un compte créé sans mot de passe et sans SMTP n’est pas mis en file : l’administrateur génère une invitation de 72 h', async () => {
    const admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    const created = await admin.post('/users', { email: 'nouveau@test.local', firstName: 'Nour', lastName: 'Nouveau', memberships: [{ companyId: f.companies.A, role: 'LECTEUR' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await t.prisma.client.notificationOutbox.count()).toBe(0);
    const link = await admin.post(`/users/${created.body.id}/access-link`, { purpose: 'INVITATION' });
    expect(link.status).toBe(201);
    expect(new Date(link.body.expiresAt).getTime() - t.clock.now().getTime()).toBe(72 * 3600 * 1000);
  });

  it('journalise les connexions sans mot de passe ni jeton', async () => {
    await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const events = await t.prisma.client.auditEvent.findMany({ where: { action: 'auth.login' } });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toMatch(new RegExp(DEFAULT_PASSWORD));
    expect(JSON.stringify(events[0])).not.toMatch(/pa_session/);
  });
});

describe('Réinitialisation par e-mail (SMTP configuré)', () => {
  let t: TestApp;
  let f: Fixture;

  beforeAll(async () => {
    t = await startTestApp({ now: '2026-09-24T10:00:00.000Z', smtp: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set('2026-09-24T10:00:00.000Z');
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
  });

  it('réinitialise le mot de passe par jeton à usage unique envoyé via l’outbox et révoque les sessions existantes', async () => {
    const chef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const forgot = await request(t.server).post('/api/v1/auth/forgot-password').set('Origin', TEST_ORIGIN).send({ email: f.emails.chefA });
    expect(forgot.status).toBe(200);
    const unknown = await request(t.server).post('/api/v1/auth/forgot-password').set('Origin', TEST_ORIGIN).send({ email: 'inconnu@test.local' });
    expect(unknown.status).toBe(200);
    const outbox = await t.prisma.client.notificationOutbox.findMany({ where: { kind: 'REINITIALISATION_MOT_DE_PASSE' } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.status).toBe('EN_ATTENTE');
    const token = /token=([A-Za-z0-9_-]+)/.exec(outbox[0]?.bodyText ?? '')?.[1];
    expect(token).toBeTruthy();
    const stored = await t.prisma.client.passwordResetToken.findFirst();
    expect(stored?.tokenHash).not.toBe(token);

    const weak = await request(t.server).post('/api/v1/auth/reset-password').set('Origin', TEST_ORIGIN).send({ token, newPassword: 'court' });
    expect(weak.status).toBe(422);
    const reset = await request(t.server).post('/api/v1/auth/reset-password').set('Origin', TEST_ORIGIN).send({ token, newPassword: 'Nouveau-Mot-De-Passe-1' });
    expect(reset.status).toBe(200);
    const reuse = await request(t.server).post('/api/v1/auth/reset-password').set('Origin', TEST_ORIGIN).send({ token, newPassword: 'Encore-Un-Autre-Mdp-2' });
    expect(reuse.status).toBe(422);
    expect((await chef.get('/auth/session')).status).toBe(401);
    const relogin = await login(t.server, f.emails.chefA, 'Nouveau-Mot-De-Passe-1');
    expect((await relogin.get('/auth/session')).status).toBe(200);
  });
});
