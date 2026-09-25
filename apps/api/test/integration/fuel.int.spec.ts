import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

describe('Pleins, soumissions conducteur et consommation (CDC 8.2, 8.3 — T24, T25)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;
  let vehicleId: string;
  let supplierId: string;

  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(NOW);
    await resetDatabase(t.prisma);
    f = await seedFixture(t.prisma);
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    vehicleId = await prepareVehicle({ energy: 'DIESEL', tankCapacityLiters: '60' });
    const supplier = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Station du Lac', category: 'STATION' });
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    supplierId = supplier.body.id as string;
  });

  /** Véhicule de la société A, énergie et capacité renseignées par l'API, compteur initialisé à 9 000 km. */
  async function prepareVehicle(fields: { energy: string; tankCapacityLiters?: string }, initKm: string | null = '9000'): Promise<string> {
    const id = await createVehicle(t.prisma, f, 'A');
    const patched = await chefA.patch(`/vehicles/${id}`, { ...fields, expectedVersion: 1 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    if (initKm) {
      const init = await chefA.post(`/vehicles/${id}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: initKm });
      expect(init.status, JSON.stringify(init.body)).toBe(201);
    }
    return id;
  }

  const body = (overrides: Record<string, unknown> = {}) => ({ vehicleId, filledAt: '2026-09-23T08:00:00Z', liters: '40', unitPrice: '2.525', totalAmount: '101.000', isFullTank: true, ...overrides });

  function fuel(agent: Agent, payload: Record<string, unknown>, key: string = randomUUID()) {
    return agent.post('/fuel-entries', payload).set('Idempotency-Key', key);
  }

  async function created(agent: Agent, payload: Record<string, unknown>): Promise<{ id: string; version: number; expenseId: string | null; status: string }> {
    const res = await fuel(agent, payload);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; expenseId: string | null; status: string };
  }

  /** Utilisation EN_COURS du conducteur A1 (compte conducteurA) sur le véhicule, remise à 08:00. */
  async function checkoutDriver(vId: string, km = '9100'): Promise<{ id: string; version: number }> {
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: `P-${randomUUID().slice(0, 6)}`, categories: ['B'], expiresOn: new Date('2030-01-01T00:00:00Z') } });
    const out = await chefA
      .post('/usages/checkout', { vehicleId: vId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T08:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Tournée clients', reading: { physicalKm: km }, location: { placeLabel: 'Dépôt' }, fuelGauge: 'DEMI', checklist: [{ label: 'Clés', present: true }] })
      .set('Idempotency-Key', randomUUID());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    return out.body as { id: string; version: number };
  }

  async function expensesOf(sourceId: string) {
    return t.prisma.client.expense.findMany({ where: { sourceType: 'PLEIN', sourceId }, orderBy: { createdAt: 'asc' } });
  }

  it('saisie directe : plein VALIDE, relevé CARBURANT accepté et dépense de synthèse dans la même transaction', async () => {
    // 23:30 UTC = 00:30 à Tunis le 24 : la dépense prend la date civile locale du plein (D-223).
    const res = await fuel(chefA, body({ filledAt: '2026-09-23T23:30:00Z', odometerKm: '10000', supplierId, driverId: f.drivers.a2, notes: 'Plein avant mission' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'VALIDE', liters: '40.000', unitPrice: '2.525', totalAmount: '101.000', energy: 'DIESEL', isFullTank: true, readingStatus: 'ACCEPTE', consumptionEligibility: 'ADMISSIBLE', amountMismatch: false, supplierName: 'Station du Lac', driverId: f.drivers.a2, companyId: f.companies.A });
    const reading = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: res.body.readingId } });
    expect(reading).toMatchObject({ source: 'MANUAL', context: 'CARBURANT', status: 'ACCEPTE', vehicleId });
    expect(reading.observedAt.toISOString()).toBe('2026-09-23T23:30:00.000Z');
    const [expense] = await expensesOf(res.body.id);
    expect(expense).toMatchObject({ id: res.body.expenseId, category: 'CARBURANT', status: 'VALIDEE', companyId: f.companies.A, vehicleId, supplierId, sourceType: 'PLEIN' });
    expect(expense?.amount.toFixed(3)).toBe('101.000');
    expect(expense?.occurredOn.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'plein.saisie', objectId: res.body.id } })).toBe(1);

    // Même clé, même corps : réponse rejouée, aucune seconde dépense.
    const key = randomUUID();
    const first = await fuel(operateurA, body({ filledAt: '2026-09-24T07:00:00Z' }), key);
    expect(first.status).toBe(201);
    const replay = await fuel(operateurA, body({ filledAt: '2026-09-24T07:00:00Z' }), key);
    expect(replay.body.id).toBe(first.body.id);
    const reused = await fuel(operateurA, body({ filledAt: '2026-09-24T07:00:00Z', liters: '41' }), key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect(await t.prisma.client.expense.count({ where: { vehicleId } })).toBe(2);
    // L'opérateur (costs.write sans costs.read) saisit mais ne voit pas les montants.
    expect(first.body).toMatchObject({ status: 'VALIDE', totalAmount: null, unitPrice: null, expenseId: null, liters: '40.000' });
    // Le lecteur ne saisit pas de plein.
    expect((await fuel(lecteurA, body())).status).toBe(403);
    // Clé d'idempotence obligatoire.
    const noKey = await chefA.post('/fuel-entries', body());
    expect(noKey.status).toBe(422);
    expect(noKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');

    // Même transaction : un échec après l'écriture du plein (ticket déjà rattaché à un autre plein) n'en
    // laisse rien — ni plein, ni relevé, ni dépense.
    const used = await uploadPdf(chefA, t.server, f.companies.A, 'ticket-utilise.pdf');
    await created(chefA, body({ filledAt: '2026-09-24T07:30:00Z', ticketAttachmentId: used }));
    const before = { entries: await t.prisma.client.fuelEntry.count(), readings: await t.prisma.client.odometerReading.count(), expenses: await t.prisma.client.expense.count() };
    const reuse = await fuel(chefA, body({ filledAt: '2026-09-24T07:45:00Z', odometerKm: '10100', ticketAttachmentId: used }));
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(422);
    expect(reuse.body.code).toBe('PIECE_JOINTE_DEJA_RATTACHEE');
    expect({ entries: await t.prisma.client.fuelEntry.count(), readings: await t.prisma.client.odometerReading.count(), expenses: await t.prisma.client.expense.count() }).toEqual(before);
  });

  it('refuse les valeurs nulles ou négatives, la date future et les énergies incompatibles (D-223, D-225)', async () => {
    const zero = await fuel(chefA, body({ liters: '0', totalAmount: '-5', unitPrice: '0' }));
    expect(zero.status).toBe(422);
    expect(zero.body.code).toBe('VALIDATION');
    expect(Object.keys(zero.body.fieldErrors).sort()).toEqual(['liters', 'totalAmount', 'unitPrice']);
    const noFlag = await fuel(chefA, body({ isFullTank: undefined }));
    expect(noFlag.body.fieldErrors.isFullTank).toBeDefined();
    // D-223 : date et heure avec fuseau explicite ; une date seule ou une heure sans fuseau n'est pas devinée.
    for (const filledAt of ['2026-09-23', '2026-09-23T08:00:00']) {
      const partial = await fuel(chefA, body({ filledAt }));
      expect(partial.status, filledAt).toBe(422);
      expect(partial.body.code).toBe('VALIDATION');
      expect(Object.keys(partial.body.fieldErrors)).toEqual(['filledAt']);
    }
    const future = await fuel(chefA, body({ filledAt: '2026-09-24T10:06:00Z' }));
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('DATE_FUTURE');
    const wrongFuel = await fuel(chefA, body({ energy: 'ESSENCE' }));
    expect(wrongFuel.status).toBe(422);
    expect(wrongFuel.body.code).toBe('ENERGIE_INCOMPATIBLE');
    const electric = await prepareVehicle({ energy: 'ELECTRIQUE' }, null);
    const kwh = await fuel(chefA, body({ vehicleId: electric }));
    expect(kwh.status).toBe(422);
    expect(kwh.body.code).toBe('VEHICULE_ELECTRIQUE');
    const hybrid = await prepareVehicle({ energy: 'HYBRIDE' }, null);
    expect((await fuel(chefA, body({ vehicleId: hybrid }))).body.code).toBe('ENERGIE_REQUISE');
    expect((await fuel(chefA, body({ vehicleId: hybrid, energy: 'GPL' }))).body.code).toBe('ENERGIE_INCOMPATIBLE');
    const ok = await fuel(chefA, body({ vehicleId: hybrid, energy: 'ESSENCE' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ energy: 'ESSENCE', readingId: null, consumptionEligibility: 'COMPTEUR_NON_VALIDE' });
    // Aucune écriture pour les saisies refusées.
    expect(await t.prisma.client.fuelEntry.count({ where: { vehicleId } })).toBe(0);
  });

  it('signale un écart litres × prix / total au-delà de la tolérance sans corriger le total (D-224)', async () => {
    const wrong = await created(chefA, body({ totalAmount: '110.000' }));
    const view = (await chefA.get(`/fuel-entries/${wrong.id}`)).body;
    expect(view).toMatchObject({ amountMismatch: true, amountMismatchValue: '9.000', totalAmount: '110.000' });
    const within = await created(chefA, body({ filledAt: '2026-09-23T12:00:00Z', totalAmount: '101.050' }));
    expect((await chefA.get(`/fuel-entries/${within.id}`)).body.amountMismatch).toBe(false);
    const noPrice = await created(chefA, body({ filledAt: '2026-09-23T13:00:00Z', unitPrice: undefined, totalAmount: '500' }));
    expect((await chefA.get(`/fuel-entries/${noPrice.id}`)).body).toMatchObject({ amountMismatch: false, amountMismatchValue: null, unitPrice: null });
    const filtered = await chefA.get('/fuel-entries?amountMismatch=true');
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.map((i: { id: string }) => i.id)).toEqual([wrong.id]);
    // Période en dates civiles locales, conducteur et statut.
    expect((await chefA.get('/fuel-entries?from=2026-09-23&to=2026-09-23&status=VALIDE')).body.total).toBe(3);
    expect((await chefA.get('/fuel-entries?from=2026-09-24')).body.total).toBe(0);
    expect((await chefA.get(`/fuel-entries?vehicleId=${vehicleId}&driverId=${f.drivers.a1}`)).body.total).toBe(0);
    // La dépense reprend le total saisi, jamais recalculé.
    expect((await expensesOf(wrong.id))[0]?.amount.toFixed(3)).toBe('110.000');
  });

  it('T25 — deux pleins complets, partiel intermédiaire 20 L, dernier 30 L, 400 km : 12,5 L/100 km', async () => {
    const a = await created(chefA, body({ filledAt: '2026-09-10T08:00:00Z', liters: '45', totalAmount: '113.625', odometerKm: '10000' }));
    const mid = await created(chefA, body({ filledAt: '2026-09-15T08:00:00Z', liters: '20', totalAmount: '50.500', isFullTank: false, odometerKm: '10200' }));
    const b = await created(chefA, body({ filledAt: '2026-09-20T08:00:00Z', liters: '30', totalAmount: '75.750', odometerKm: '10400' }));
    const res = await lecteurA.get(`/vehicles/${vehicleId}/consumption?from=2026-09-01&to=2026-09-30`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ vehicleId, unit: 'L/100 km', available: true, reasons: [] });
    expect(res.body.nature).toContain('Estimation');
    expect(res.body.totals).toEqual([{ energy: 'DIESEL', available: true, liters: '50.000', distanceKm: '400.000', litersPer100Km: '12.5', litersPer100KmExact: '12.5', reasons: [], retainedIntervals: 1, excludedIntervals: 1 }]);
    const [first, second] = res.body.intervals;
    expect(first).toMatchObject({ endFuelEntryId: a.id, startFuelEntryId: null, retained: false, litersPer100Km: null });
    expect(first.reasons.map((r: { code: string }) => r.code)).toEqual(['PAS_DE_PLEIN_DE_REFERENCE']);
    expect(second).toMatchObject({ startFuelEntryId: a.id, endFuelEntryId: b.id, startKm: '10000.000', endKm: '10400.000', distanceKm: '400.000', liters: '50.000', fuelEntryIds: [mid.id, b.id], retained: true, litersPer100Km: '12.5' });

    // Historique insuffisant : un seul plein complet, ou aucun plein → N/D motivé, jamais 0.
    const lonely = await prepareVehicle({ energy: 'DIESEL' });
    await created(chefA, body({ vehicleId: lonely, filledAt: '2026-09-10T08:00:00Z', odometerKm: '9500' }));
    const nd = (await chefA.get(`/vehicles/${lonely}/consumption`)).body;
    expect(nd).toMatchObject({ available: false, totals: [{ available: false, litersPer100Km: null, liters: null }] });
    expect(nd.reasons.map((r: { code: string }) => r.code)).toEqual(['PAS_DE_PLEIN_DE_REFERENCE']);
    const empty = await prepareVehicle({ energy: 'DIESEL' });
    const none = (await chefA.get(`/vehicles/${empty}/consumption`)).body;
    expect(none).toMatchObject({ available: false, totals: [], intervals: [] });
    expect(none.reasons[0].code).toBe('HISTORIQUE_INSUFFISANT');
    // Distance nulle entre deux pleins complets.
    const still = await prepareVehicle({ energy: 'DIESEL' });
    await created(chefA, body({ vehicleId: still, filledAt: '2026-09-10T08:00:00Z', odometerKm: '9500' }));
    await created(chefA, body({ vehicleId: still, filledAt: '2026-09-11T08:00:00Z', liters: '5', totalAmount: '12.625', odometerKm: '9500' }));
    const zero = (await chefA.get(`/vehicles/${still}/consumption`)).body;
    expect(zero.available).toBe(false);
    expect(zero.intervals.at(-1).reasons.map((r: { code: string }) => r.code)).toEqual(['DISTANCE_NULLE']);
    // Période hors des pleins B : aucun intervalle.
    expect((await chefA.get(`/vehicles/${vehicleId}/consumption?from=2026-08-01&to=2026-08-31`)).body.reasons[0].code).toBe('HISTORIQUE_INSUFFISANT');
    const inverted = await chefA.get(`/vehicles/${vehicleId}/consumption?from=2026-09-30&to=2026-09-01`);
    expect(inverted.status).toBe(422);
    // Date calendaire inexistante : refus motivé (422), jamais une erreur serveur.
    const impossible = await chefA.get(`/vehicles/${vehicleId}/consumption?from=2026-02-30`);
    expect(impossible.status).toBe(422);
    expect(impossible.body.fieldErrors.from).toBeDefined();
    expect((await chefA.get('/fuel-entries?to=2026-02-30')).status).toBe(422);
  });

  it('N/D motivés par l’API : période « achats incomplets », capacité dépassée non confirmée puis confirmée', async () => {
    await created(chefA, body({ filledAt: '2026-09-10T08:00:00Z', liters: '45', totalAmount: '113.625', odometerKm: '10000' }));
    const b = await created(chefA, body({ filledAt: '2026-09-20T08:00:00Z', liters: '70', totalAmount: '176.750', odometerKm: '10500' }));
    const view = (await chefA.get(`/fuel-entries/${b.id}`)).body;
    expect(view).toMatchObject({ tankCapacityExceeded: true, capacityConfirmedAt: null, consumptionEligibility: 'CAPACITE_NON_CONFIRMEE', status: 'VALIDE' });
    let c = (await chefA.get(`/vehicles/${vehicleId}/consumption`)).body;
    expect(c.intervals.at(-1).reasons.map((r: { code: string }) => r.code)).toEqual(['CAPACITE_NON_CONFIRMEE']);
    expect((await operateurA.post(`/fuel-entries/${b.id}/confirm-capacity`, { expectedVersion: view.version })).status).toBe(403);
    const confirmed = await chefA.post(`/fuel-entries/${b.id}/confirm-capacity`, { expectedVersion: view.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.capacityConfirmedAt).toBe(NOW);
    c = (await chefA.get(`/vehicles/${vehicleId}/consumption`)).body;
    expect(c.totals[0]).toMatchObject({ available: true, litersPer100Km: '14.0', distanceKm: '500.000', liters: '70.000' });

    const denied = await operateurA.post(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-16T00:00:00Z', reason: 'Carte carburant perdue' });
    expect(denied.status).toBe(403);
    const invalid = await chefA.post(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { startsAt: '2026-09-16T00:00:00Z', endsAt: '2026-09-15T00:00:00Z', reason: 'Carte carburant perdue' });
    expect(invalid.status).toBe(422);
    const blank = await chefA.post(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-16T00:00:00Z', reason: '     ' });
    expect(blank.status).toBe(422);
    expect(blank.body.fieldErrors.reason).toBeDefined();
    const gap = await chefA.post(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-16T00:00:00Z', reason: 'Carte carburant perdue' });
    expect(gap.status, JSON.stringify(gap.body)).toBe(201);
    const gaps = await lecteurA.get(`/vehicles/${vehicleId}/fuel-purchase-gaps`);
    expect(gaps.body).toHaveLength(1);
    expect(gaps.body[0]).toMatchObject({ reason: 'Carte carburant perdue', companyId: f.companies.A });
    c = (await chefA.get(`/vehicles/${vehicleId}/consumption`)).body;
    expect(c.available).toBe(false);
    expect(c.intervals.at(-1).reasons.map((r: { code: string }) => r.code)).toEqual(['PERIODE_ACHATS_INCOMPLETS']);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'plein.periode_achats_incomplets' } })).toBe(1);
  });

  it('soumission conducteur : fenêtre d’utilisation, photo obligatoire, ni dépense ni relevé accepté (D-222, D-226)', async () => {
    await checkoutDriver(vehicleId);
    const other = await prepareVehicle({ energy: 'DIESEL' });
    const ticket = await uploadPdf(conducteurA, t.server, f.companies.A, 'ticket.pdf');
    const submission = { vehicleId, filledAt: '2026-09-24T09:30:00Z', liters: '30', unitPrice: '2.525', totalAmount: '75.750', isFullTank: true, odometerKm: '9150' };

    const noPhoto = await fuel(conducteurA, submission);
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.code).toBe('TICKET_REQUIS');
    const early = await fuel(conducteurA, { ...submission, filledAt: '2026-09-24T06:59:00Z', ticketAttachmentId: ticket });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('HORS_UTILISATION');
    expect((await fuel(conducteurA, { ...submission, vehicleId: other, ticketAttachmentId: ticket })).status).toBe(404);
    // Aucun oracle : hors droits, le véhicule est introuvable AVANT toute règle métier (ticket, énergie,
    // véhicule électrique) — même réponse qu'un identifiant inexistant.
    const unknown = await fuel(conducteurA, { ...submission, vehicleId: randomUUID(), ticketAttachmentId: ticket });
    expect(unknown.status).toBe(404);
    const electric = await prepareVehicle({ energy: 'ELECTRIQUE' }, null);
    for (const probe of [{ ...submission, vehicleId: other }, { ...submission, vehicleId: other, energy: 'ESSENCE', ticketAttachmentId: ticket }, { ...submission, vehicleId: electric, ticketAttachmentId: ticket }]) {
      const res = await fuel(conducteurA, probe);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect({ code: res.body.code, message: res.body.message }).toEqual({ code: unknown.body.code, message: unknown.body.message });
    }

    const res = await fuel(conducteurA, { ...submission, ticketAttachmentId: ticket, driverId: f.drivers.a2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Le serveur impose le conducteur du compte ; le conducteur voit ses valeurs, jamais la dépense.
    expect(res.body).toMatchObject({ status: 'SOUMIS', driverId: f.drivers.a1, totalAmount: '75.750', expenseId: null, readingStatus: 'EN_ATTENTE', consumptionEligibility: 'NON_VALIDE', ticketAttachmentId: ticket, decidedAt: null });
    expect(await expensesOf(res.body.id)).toHaveLength(0);
    const reading = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: res.body.readingId } });
    expect(reading).toMatchObject({ status: 'EN_ATTENTE', context: 'CARBURANT', source: 'MANUAL', anomalyCode: 'SOUMISSION_CONDUCTEUR', createdById: f.users.conducteurA });
    const attachment = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: ticket } });
    expect(attachment).toMatchObject({ ownerType: 'PLEIN', ownerId: res.body.id });

    // Le conducteur ne voit que ses propres soumissions : ni les pleins des autres, ni un plein saisi par le
    // personnel à son nom avec la facture de la station (2.3 : pas de facture ni de montant d'achat).
    const staffEntry = await created(chefA, body({ vehicleId: other, filledAt: '2026-09-23T08:00:00Z' }));
    const invoice = await uploadPdf(chefA, t.server, f.companies.A, 'facture-station.pdf');
    const forHim = await created(chefA, body({ vehicleId: other, filledAt: '2026-09-23T09:00:00Z', driverId: f.drivers.a1, ticketAttachmentId: invoice }));
    const mine = await conducteurA.get('/fuel-entries');
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([res.body.id]);
    expect(mine.body.total).toBe(1);
    expect((await conducteurA.get(`/fuel-entries/${staffEntry.id}`)).status).toBe(404);
    expect((await conducteurA.get(`/fuel-entries/${forHim.id}`)).status).toBe(404);
    expect((await conducteurA.post(`/fuel-entries/${forHim.id}/cancel`, { expectedVersion: forHim.version })).status).toBe(404);
    expect((await conducteurA.get(`/attachments/${invoice}/download`)).status).toBe(404);
    expect((await chefA.get(`/attachments/${invoice}/download`)).status).toBe(200);
    // Son propre ticket reste accessible.
    expect((await conducteurA.get(`/attachments/${ticket}/download`)).status).toBe(200);
    expect((await conducteurA.get(`/vehicles/${vehicleId}/consumption`)).status).toBe(403);

    // Rejet motivé visible par le conducteur ; retrait d'une autre soumission tant qu'elle est SOUMIS.
    const blankReason = await chefA.post(`/fuel-entries/${res.body.id}/reject`, { reason: '    ', expectedVersion: res.body.version });
    expect(blankReason.status).toBe(422);
    expect(blankReason.body.fieldErrors.reason).toBeDefined();
    const rejected = await chefA.post(`/fuel-entries/${res.body.id}/reject`, { reason: 'Ticket illisible', expectedVersion: res.body.version });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await conducteurA.get(`/fuel-entries/${res.body.id}`)).body).toMatchObject({ status: 'REJETE', decisionReason: 'Ticket illisible', expenseId: null });
    const ticket2 = await uploadPdf(conducteurA, t.server, f.companies.A, 'ticket2.pdf');
    const second = await fuel(conducteurA, { ...submission, filledAt: '2026-09-24T09:45:00Z', odometerKm: undefined, ticketAttachmentId: ticket2 });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await conducteurA.post(`/fuel-entries/${second.body.id}/validate`, { expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).status).toBe(403);
    const withdrawn = await conducteurA.post(`/fuel-entries/${second.body.id}/cancel`, { expectedVersion: second.body.version });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.status).toBe('ANNULE');
    expect((await conducteurA.post(`/fuel-entries/${second.body.id}/cancel`, { expectedVersion: withdrawn.body.version })).status).toBe(409);
    expect(await t.prisma.client.expense.count({ where: { vehicleId } })).toBe(0);
  });

  it('ticket oublié : soumission après restitution dans le délai paramétré, refusée au-delà (D-226)', async () => {
    const usage = await checkoutDriver(vehicleId);
    const back = await chefA.post(`/usages/${usage.id}/return`, { returnedAt: '2026-09-24T09:30:00Z', reading: { physicalKm: '9180' }, location: { placeLabel: 'Dépôt' }, expectedVersion: usage.version }).set('Idempotency-Key', randomUUID());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const late = { vehicleId, filledAt: '2026-09-24T10:15:00Z', liters: '20', totalAmount: '50.500', isFullTank: false };
    // Horloge avancée : la session précédente a expiré, le conducteur se reconnecte.
    t.clock.set('2026-09-27T10:00:00Z');
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const ticket = await uploadPdf(conducteurA, t.server, f.companies.A);
    const ok = await fuel(conducteurA, { ...late, ticketAttachmentId: ticket });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const outside = await fuel(conducteurA, { ...late, filledAt: '2026-09-24T10:31:00Z', ticketAttachmentId: await uploadPdf(conducteurA, t.server, f.companies.A) });
    expect(outside.body.code).toBe('HORS_UTILISATION');
    t.clock.set('2026-10-01T09:30:01Z');
    conducteurA = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    const tooLate = await fuel(conducteurA, { ...late, ticketAttachmentId: await uploadPdf(conducteurA, t.server, f.companies.A) });
    expect(tooLate.status).toBe(404);
  });

  it('D-268 — responsable habituel sans utilisation : ticket refusé (404) tant que le paramètre est désactivé, accepté une fois activé ; ancien ticket refusé (422)', async () => {
    const assignment = await chefA.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a1, startsAt: '2026-09-01T08:00:00Z' });
    expect(assignment.status, JSON.stringify(assignment.body)).toBe(201);
    const ticketFor = async () => uploadPdf(conducteurA, t.server, f.companies.A);
    const payload = { vehicleId, filledAt: '2026-09-24T07:30:00Z', liters: '25', totalAmount: '63.125', isFullTank: false };
    const off = await fuel(conducteurA, { ...payload, ticketAttachmentId: await ticketFor() });
    expect(off.status, JSON.stringify(off.body)).toBe(404);
    expect((await admin.put('/settings/drivers.allowHabitualVehicleSubmissions', { value: true, reason: 'véhicules de fonction' })).status).toBe(200);
    const on = await fuel(conducteurA, { ...payload, ticketAttachmentId: await ticketFor() });
    expect(on.status, JSON.stringify(on.body)).toBe(201);
    expect(on.body).toMatchObject({ status: 'SOUMIS', vehicleId });
    const old = await fuel(conducteurA, { ...payload, filledAt: '2026-09-10T07:30:00Z', ticketAttachmentId: await ticketFor() });
    expect(old.status, JSON.stringify(old.body)).toBe(422);
    expect(old.body.code).toBe('HORS_UTILISATION');
  });

  it('T24 — plein validé deux fois : même clé → réponse rejouée, autre clé → 409 DEJA_VALIDE, une seule dépense', async () => {
    await checkoutDriver(vehicleId);
    const submit = async (filledAt: string, totalAmount = '75.750') => {
      const res = await fuel(conducteurA, { vehicleId, filledAt, liters: '30', unitPrice: '2.525', totalAmount, isFullTank: true, ticketAttachmentId: await uploadPdf(conducteurA, t.server, f.companies.A) });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as { id: string; version: number };
    };
    const s = await submit('2026-09-24T09:00:00Z');
    const key = randomUUID();
    const first = await chefA.post(`/fuel-entries/${s.id}/validate`, { expectedVersion: s.version, supplierId }).set('Idempotency-Key', key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'VALIDE', supplierId });
    expect(first.body.expenseId).toBeTruthy();
    const replay = await chefA.post(`/fuel-entries/${s.id}/validate`, { expectedVersion: s.version, supplierId }).set('Idempotency-Key', key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const again = await chefA.post(`/fuel-entries/${s.id}/validate`, { expectedVersion: s.version, supplierId }).set('Idempotency-Key', randomUUID());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DEJA_VALIDE');
    // Un plein saisi directement (déjà VALIDE avec sa dépense) ne se « revalide » pas non plus.
    const direct = await created(chefA, body({ filledAt: '2026-09-24T09:50:00Z' }));
    const revalidate = await chefA.post(`/fuel-entries/${direct.id}/validate`, { expectedVersion: direct.version }).set('Idempotency-Key', randomUUID());
    expect(revalidate.status).toBe(409);
    expect(revalidate.body.code).toBe('DEJA_VALIDE');
    expect(await expensesOf(direct.id)).toHaveLength(1);
    const expenses = await expensesOf(s.id);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ status: 'VALIDEE', companyId: f.companies.A, category: 'CARBURANT', supplierId });
    expect(expenses[0]?.occurredOn.toISOString().slice(0, 10)).toBe('2026-09-24');

    // Validations concurrentes avec deux clés : une seule réussit, une seule dépense.
    const s2 = await submit('2026-09-24T09:20:00Z');
    const results = await Promise.all([
      chefA.post(`/fuel-entries/${s2.id}/validate`, { expectedVersion: s2.version }).set('Idempotency-Key', randomUUID()),
      admin.post(`/fuel-entries/${s2.id}/validate`, { expectedVersion: s2.version }).set('Idempotency-Key', randomUUID()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await expensesOf(s2.id)).toHaveLength(1);

    // Écart signalé : la validation exige une confirmation explicite.
    const s3 = await submit('2026-09-24T09:40:00Z', '90.000');
    const unconfirmed = await chefA.post(`/fuel-entries/${s3.id}/validate`, { expectedVersion: s3.version }).set('Idempotency-Key', randomUUID());
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.code).toBe('CONFIRMATION_ECART_REQUISE');
    const confirmed = await chefA.post(`/fuel-entries/${s3.id}/validate`, { expectedVersion: s3.version, confirmAmountMismatch: true }).set('Idempotency-Key', randomUUID());
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ amountMismatch: true, amountMismatchValue: '14.250', totalAmount: '90.000' });
    // Le lecteur ne valide pas ; un plein validé ne se rejette plus.
    expect((await lecteurA.post(`/fuel-entries/${s3.id}/reject`, { reason: 'Doublon', expectedVersion: confirmed.body.version })).status).toBe(403);
    expect((await chefA.post(`/fuel-entries/${s3.id}/reject`, { reason: 'Doublon', expectedVersion: confirmed.body.version })).status).toBe(409);
  });

  it('compteur non validé : coût compté, plein exclu de la consommation jusqu’à régularisation (8.2, D-222)', async () => {
    await checkoutDriver(vehicleId);
    const sub = await fuel(conducteurA, { vehicleId, filledAt: '2026-09-24T09:00:00Z', liters: '30', totalAmount: '75.750', isFullTank: true, odometerKm: '9150', ticketAttachmentId: await uploadPdf(conducteurA, t.server, f.companies.A) });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const validated = await chefA.post(`/fuel-entries/${sub.body.id}/validate`, { expectedVersion: sub.body.version }).set('Idempotency-Key', randomUUID());
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    // La validation du coût n'approuve pas le relevé proposé par le conducteur.
    expect(validated.body).toMatchObject({ status: 'VALIDE', readingStatus: 'EN_ATTENTE', consumptionEligibility: 'COMPTEUR_NON_VALIDE' });
    expect(await expensesOf(sub.body.id)).toHaveLength(1);
    const pending = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: sub.body.readingId } });
    const approved = await chefA.post(`/readings/${pending.id}/approve`, { expectedVersion: pending.version });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await chefA.get(`/fuel-entries/${sub.body.id}`)).body).toMatchObject({ readingStatus: 'ACCEPTE', consumptionEligibility: 'ADMISSIBLE' });

    // Saisie sans compteur, régularisée par un relevé accepté observé à l'heure du plein.
    const direct = await created(chefA, body({ filledAt: '2026-09-24T09:40:00Z' }));
    expect((await chefA.get(`/fuel-entries/${direct.id}`)).body.consumptionEligibility).toBe('COMPTEUR_NON_VALIDE');
    const reading = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '9170', observedAt: '2026-09-24T09:40:00Z' });
    expect(reading.status, JSON.stringify(reading.body)).toBe(201);
    expect((await chefA.get(`/fuel-entries/${direct.id}`)).body.consumptionEligibility).toBe('ADMISSIBLE');
    const c = (await chefA.get(`/vehicles/${vehicleId}/consumption`)).body;
    expect(c.intervals.at(-1)).toMatchObject({ retained: true, distanceKm: '20.000', liters: '40.000', litersPer100Km: '200.0' });
  });

  it('correction d’un plein validé : nouvelle ligne, dépense remplacée dans la même transaction, puis annulation traçable (D-229)', async () => {
    const original = await created(chefA, body({ odometerKm: '10000', supplierId }));
    const oldExpenseId = original.expenseId as string;
    const correction = { reason: 'Erreur de saisie du ticket', expectedVersion: original.version, liters: '41.5', totalAmount: '104.788' };
    expect((await operateurA.post(`/fuel-entries/${original.id}/correct`, correction).set('Idempotency-Key', randomUUID())).status).toBe(403);
    const blank = await chefA.post(`/fuel-entries/${original.id}/correct`, { ...correction, reason: '   ' }).set('Idempotency-Key', randomUUID());
    expect(blank.status).toBe(422);
    expect(blank.body.fieldErrors.reason).toBeDefined();
    const res = await chefA.post(`/fuel-entries/${original.id}/correct`, correction).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'VALIDE', replacesFuelEntryId: original.id, liters: '41.500', totalAmount: '104.788', unitPrice: '2.525', supplierId, readingStatus: 'ACCEPTE', amountMismatch: false });
    expect(res.body.id).not.toBe(original.id);
    const old = (await chefA.get(`/fuel-entries/${original.id}`)).body;
    expect(old).toMatchObject({ status: 'REMPLACE', replacedByFuelEntryId: res.body.id, decisionReason: 'Erreur de saisie du ticket', expenseId: null });
    const oldExpense = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: oldExpenseId } });
    expect(oldExpense.status).toBe('REMPLACEE');
    const newExpense = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: res.body.expenseId } });
    expect(newExpense).toMatchObject({ status: 'VALIDEE', replacesExpenseId: oldExpenseId, sourceId: res.body.id, companyId: f.companies.A, occurredOn: oldExpense.occurredOn });
    expect(newExpense.amount.toFixed(3)).toBe('104.788');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'plein.correction', objectId: original.id } });
    expect(audit.reason).toBe('Erreur de saisie du ticket');
    // Une seule dépense active pour le plein corrigé.
    expect(await t.prisma.client.expense.count({ where: { vehicleId, status: 'VALIDEE' } })).toBe(1);

    const twice = await chefA.post(`/fuel-entries/${original.id}/correct`, { ...correction, expectedVersion: old.version }).set('Idempotency-Key', randomUUID());
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('DEJA_CORRIGE');
    const noop = await chefA.post(`/fuel-entries/${res.body.id}/correct`, { reason: 'Aucune', expectedVersion: res.body.version, liters: '41.5' }).set('Idempotency-Key', randomUUID());
    expect(noop.status).toBe(422);
    expect(noop.body.code).toBe('AUCUNE_MODIFICATION');

    const noReason = await chefA.post(`/fuel-entries/${res.body.id}/cancel`, { expectedVersion: res.body.version });
    expect(noReason.status).toBe(422);
    expect((await operateurA.post(`/fuel-entries/${res.body.id}/cancel`, { expectedVersion: res.body.version, reason: 'Doublon' })).status).toBe(403);
    const cancelled = await chefA.post(`/fuel-entries/${res.body.id}/cancel`, { expectedVersion: res.body.version, reason: 'Plein saisi sur le mauvais véhicule' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'ANNULE', expenseId: null });
    const cancelledExpense = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: newExpense.id } });
    expect(cancelledExpense).toMatchObject({ status: 'ANNULEE', cancelledById: f.users.chefA });
    expect(cancelledExpense.cancelReason).toContain('Plein saisi sur le mauvais véhicule');
    expect(await t.prisma.client.expense.count({ where: { vehicleId, status: 'VALIDEE' } })).toBe(0);
    const stale = await chefA.post(`/fuel-entries/${res.body.id}/cancel`, { expectedVersion: res.body.version, reason: 'Encore' });
    expect(stale.status).toBe(409);
  });

  it('cloisonnement : chef B ne voit rien de A (404), lecteur sans costs.read sans montants', async () => {
    const ticket = await uploadPdf(chefA, t.server, f.companies.A, 'ticket-a.pdf');
    const e = await created(chefA, body({ totalAmount: '110.000', ticketAttachmentId: ticket }));
    expect((await chefB.get(`/fuel-entries/${e.id}`)).status).toBe(404);
    const listB = await chefB.get('/fuel-entries');
    expect(listB.body.total).toBe(0);
    expect((await chefB.get(`/fuel-entries?companyId=${f.companies.A}`)).status).toBe(404);
    expect((await fuel(chefB, body())).status).toBe(404);
    expect((await chefB.post(`/fuel-entries/${e.id}/cancel`, { expectedVersion: e.version, reason: 'Intrusion' })).status).toBe(404);
    // Aucune décision de B sur un plein de A : introuvable avant tout contrôle d'état.
    expect((await chefB.post(`/fuel-entries/${e.id}/validate`, { expectedVersion: e.version }).set('Idempotency-Key', randomUUID())).status).toBe(404);
    expect((await chefB.post(`/fuel-entries/${e.id}/reject`, { expectedVersion: e.version, reason: 'Intrusion' })).status).toBe(404);
    expect((await chefB.post(`/fuel-entries/${e.id}/correct`, { expectedVersion: e.version, reason: 'Intrusion', liters: '1' }).set('Idempotency-Key', randomUUID())).status).toBe(404);
    expect((await chefB.post(`/fuel-entries/${e.id}/confirm-capacity`, { expectedVersion: e.version })).status).toBe(404);
    expect((await chefB.post(`/vehicles/${vehicleId}/fuel-purchase-gaps`, { startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-16T00:00:00Z', reason: 'Intrusion' })).status).toBe(404);
    expect((await chefB.get(`/attachments/${ticket}/download`)).status).toBe(404);
    // Rien n'a changé côté A.
    expect((await chefA.get(`/fuel-entries/${e.id}`)).body).toMatchObject({ status: 'VALIDE', version: e.version, liters: '40.000' });
    expect(await t.prisma.client.fuelPurchaseGap.count()).toBe(0);
    expect((await chefB.get(`/vehicles/${vehicleId}/consumption`)).status).toBe(404);
    expect((await chefB.get(`/vehicles/${vehicleId}/fuel-purchase-gaps`)).status).toBe(404);

    const reader = await lecteurA.get(`/fuel-entries/${e.id}`);
    expect(reader.status).toBe(200);
    expect(reader.body).toMatchObject({ liters: '40.000', totalAmount: null, unitPrice: null, amountMismatchValue: null, expenseId: null, amountMismatch: true });
    const readerList = await lecteurA.get('/fuel-entries');
    expect(readerList.body.items[0]).toMatchObject({ id: e.id, totalAmount: null });
    // Le ticket porte les montants : il n'est pas ouvert au lecteur sans costs.read.
    expect((await lecteurA.get(`/attachments/${ticket}/download`)).status).toBe(404);
    expect((await admin.get(`/attachments/${ticket}/download`)).status).toBe(200);
    const adminView = await admin.get(`/fuel-entries/${e.id}`);
    expect(adminView.body).toMatchObject({ totalAmount: '110.000', amountMismatchValue: '9.000', expenseId: e.expenseId });
    // Un fournisseur d'une autre société est introuvable pour ce véhicule.
    const supplierB = await chefB.post('/suppliers', { companyId: f.companies.B, name: 'Station B', category: 'STATION' });
    expect((await fuel(chefA, body({ supplierId: supplierB.body.id }))).status).toBe(404);
  });
});
