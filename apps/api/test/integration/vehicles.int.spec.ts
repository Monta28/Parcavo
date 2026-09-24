import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

describe('Dossiers véhicules (CDC 3.1, 3.2, 3.4)', () => {
  let t: TestApp;
  let f: Fixture;
  let chefA: Agent;

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
  });

  const base = () => ({ companyId: f.companies.A, code: 'VH-1', registration: '123 TU 4567', make: 'Peugeot', model: '308', categoryId: f.categoryId });

  it('crée un véhicule avec un kilométrage inconnu (NULL), un statut DISPONIBLE et un historique de société', async () => {
    const res = await chefA.post('/vehicles', base());
    expect(res.status).toBe(201);
    expect(res.body.lifecycleStatus).toBe('ACTIF');
    expect(res.body.operationalStatus).toBe('DISPONIBLE');
    const synthesis = await chefA.get(`/vehicles/${res.body.id}/synthesis`);
    expect(synthesis.status).toBe(200);
    expect(synthesis.body.odometer).toBeNull();
    expect(synthesis.body.freshness).toBe('INCONNU');
    expect(synthesis.body.responsible).toBeNull();
    expect(synthesis.body.lastLocation).toBeNull();
    const history = await t.prisma.client.vehicleCompanyHistory.findMany({ where: { vehicleId: res.body.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.toCompanyId).toBe(f.companies.A);
  });

  it('contrôle les doublons d’immatriculation après normalisation, de code et de VIN, sans détruire l’affichage', async () => {
    const first = await chefA.post('/vehicles', { ...base(), vin: 'vf1abc12345678901' });
    expect(first.status).toBe(201);
    expect(first.body.registration).toBe('123 TU 4567');
    expect(first.body.vin).toBe('VF1ABC12345678901');
    const sameRegistration = await chefA.post('/vehicles', { ...base(), code: 'VH-2', registration: '123-tu-4567' });
    expect(sameRegistration.status).toBe(409);
    expect(sameRegistration.body.code).toBe('IMMATRICULATION_EXISTANTE');
    const sameCode = await chefA.post('/vehicles', { ...base(), registration: '124 TU 4567' });
    expect(sameCode.status).toBe(409);
    expect(sameCode.body.code).toBe('CODE_VEHICULE_EXISTANT');
    const sameVin = await chefA.post('/vehicles', { ...base(), code: 'VH-3', registration: '125 TU 4567', vin: 'VF1ABC12345678901' });
    expect(sameVin.status).toBe(409);
    expect(sameVin.body.code).toBe('VIN_EXISTANT');
    const provisional = await chefA.post('/vehicles', { ...base(), code: 'VH-4', registration: 'PROV/2026/001', provisionalRegistration: true });
    expect(provisional.status).toBe(201);
    const found = await chefA.get('/vehicles?q=123tu');
    expect(found.body.total).toBe(1);
  });

  it('valide les champs obligatoires et renvoie des erreurs par champ en français', async () => {
    const res = await chefA.post('/vehicles', { companyId: f.companies.A, code: 'VH-1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION');
    expect(Object.keys(res.body.fieldErrors)).toEqual(expect.arrayContaining(['registration', 'make', 'model', 'categoryId']));
    const unknownProperty = await chefA.post('/vehicles', { ...base(), companyId: f.companies.A, kilometrage: 12 });
    expect(unknownProperty.status).toBe(422);
  });

  it('applique le verrou optimiste par version', async () => {
    const created = await chefA.post('/vehicles', base());
    const ok = await chefA.patch(`/vehicles/${created.body.id}`, { notes: 'v2', expectedVersion: created.body.version });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(created.body.version + 1);
    const stale = await chefA.patch(`/vehicles/${created.body.id}`, { notes: 'v3', expectedVersion: created.body.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');
  });

  it('déclare une localisation « dernière localisation déclarée » avec date et auteur, jamais une position', async () => {
    const created = await chefA.post('/vehicles', base());
    const site = await chefA.post('/sites', { companyId: f.companies.A, name: 'Dépôt central' });
    expect(site.status).toBe(201);
    const future = await chefA.post(`/vehicles/${created.body.id}/location-reports`, { siteId: site.body.id, observedAt: '2026-09-30T10:00:00Z' });
    expect(future.status).toBe(422);
    const declared = await chefA.post(`/vehicles/${created.body.id}/location-reports`, { siteId: site.body.id, observedAt: '2026-09-24T09:00:00Z', comment: 'garé au dépôt' });
    expect(declared.status).toBe(201);
    expect(declared.body.siteName).toBe('Dépôt central');
    expect(declared.body.createdByName).toContain('Chaima');
    const synthesis = await chefA.get(`/vehicles/${created.body.id}/synthesis`);
    expect(synthesis.body.lastLocation.observedAt).toBe('2026-09-24T09:00:00.000Z');
    expect(JSON.stringify(synthesis.body)).not.toMatch(/latitude|longitude|position/i);
  });

  it('refuse l’archivage tant que des opérations sont ouvertes et conserve les dossiers', async () => {
    const created = await chefA.post('/vehicles', base());
    await t.prisma.client.vehicleUsage.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId: created.body.id, driverId: f.drivers.a1, purpose: 'mission', checkedOutAt: new Date('2026-09-24T08:00:00Z'), expectedReturnAt: new Date('2026-09-24T18:00:00Z'), checkoutWithoutReading: true, checkoutExceptionReason: 'test' } });
    const inUse = await chefA.get(`/vehicles/${created.body.id}`);
    expect(inUse.body.operationalStatus).toBe('EN_UTILISATION');
    expect(inUse.body.currentUsage.driverId).toBe(f.drivers.a1);
    const archive = await chefA.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin', expectedVersion: created.body.version });
    expect(archive.status).toBe(422);
    expect(archive.body.code).toBe('OPERATIONS_OUVERTES');
    // hors service pendant une utilisation : l'utilisation reste visible
    const hs = await chefA.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'HORS_SERVICE', reason: 'panne moteur', expectedVersion: created.body.version });
    expect(hs.status).toBe(200);
    expect(hs.body.operationalStatus).toBeNull();
    expect(hs.body.currentUsage).not.toBeNull();
    await t.prisma.client.vehicleUsage.updateMany({ where: { vehicleId: created.body.id }, data: { status: 'TERMINEE', returnedAt: new Date('2026-09-24T09:00:00Z'), returnWithoutReading: true } });
    const archived = await chefA.post(`/vehicles/${created.body.id}/lifecycle`, { lifecycleStatus: 'ARCHIVE', reason: 'fin de vie', expectedVersion: hs.body.version });
    expect(archived.status).toBe(200);
    expect((await chefA.get('/vehicles')).body.total).toBe(0);
    expect((await chefA.get('/vehicles?includeInactive=true')).body.total).toBe(1);
    const audit = await t.prisma.client.auditEvent.findMany({ where: { action: 'vehicule.cycle_de_vie' } });
    expect(audit).toHaveLength(2);
    expect(audit[1]?.reason).toBe('fin de vie');
  });

  it('résout un QR code interne uniquement dans le périmètre et après authentification', async () => {
    const created = await chefA.post('/vehicles', base());
    const synthesis = await chefA.get(`/vehicles/${created.body.id}/synthesis`);
    const token = synthesis.body.qrToken as string;
    expect((await chefA.get(`/vehicles/qr/${token}`)).body.vehicleId).toBe(created.body.id);
    const chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    expect((await chefB.get(`/vehicles/qr/${token}`)).status).toBe(404);
  });
});
