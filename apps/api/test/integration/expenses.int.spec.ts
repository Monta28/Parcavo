import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

describe('Registre unique des dépenses (CDC 8.4 — D-206, D-217, D-229 à D-233 ; T24, T26)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let vehicleA: string;
  let vehicleB: string;
  let garageA: string;
  let assureurA: string;

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
    admin = await login(t.server, f.emails.admin, DEFAULT_PASSWORD);
    chefA = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    chefB = await login(t.server, f.emails.chefB, DEFAULT_PASSWORD);
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    lecteurA = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    vehicleA = await createVehicle(t.prisma, f, 'A');
    vehicleB = await createVehicle(t.prisma, f, 'B');
    const garage = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Garage Central', category: 'GARAGE' });
    const assureur = await chefA.post('/suppliers', { companyId: f.companies.A, name: 'Assurances du Cap', category: 'ASSURANCE' });
    expect(garage.status, JSON.stringify(garage.body)).toBe(201);
    expect(assureur.status, JSON.stringify(assureur.body)).toBe(201);
    garageA = garage.body.id as string;
    assureurA = assureur.body.id as string;
  });

  function post(agent: Agent, body: Record<string, unknown>, key: string = randomUUID()) {
    return agent.post('/expenses', body).set('Idempotency-Key', key);
  }

  async function expense(agent: Agent, body: Record<string, unknown>) {
    const res = await post(agent, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; companyId: string; amount: string; status: string };
  }

  async function summary(agent: Agent, query = '') {
    const res = await agent.get(`/expenses/summary${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  it('création manuelle idempotente : même clé → même réponse ; autre corps → 409 ; clé obligatoire', async () => {
    const body = { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'PEAGE', amount: '12.5', reference: 'TICKET-778' };
    const noKey = await chefA.post('/expenses', body);
    expect(noKey.status).toBe(422);
    expect(noKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');

    const key = randomUUID();
    const first = await post(chefA, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ companyId: f.companies.A, vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'PEAGE', categoryLabel: 'Péage', kind: 'DEPENSE', amount: '12.500', signedAmount: '12.500', currency: 'TND', status: 'VALIDEE', sourceType: null, unallocated: false, excludedFromOperatingCost: false, version: 1 });
    const replay = await post(chefA, body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const other = await post(chefA, { ...body, amount: '13' }, key);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect(await t.prisma.client.expense.count()).toBe(1);

    // Justificatif rattaché (pièce jointe DEPENSE) ; montant exact en base.
    const attachmentId = await uploadPdf(chefA, t.server, f.companies.A, 'facture.pdf');
    const withProof = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-21', category: 'STATIONNEMENT', amount: '3.250', attachmentId, notes: '  Parking aéroport  ' });
    expect(withProof).toMatchObject({ attachmentId, notes: 'Parking aéroport' });
    const attachment = await t.prisma.client.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment).toMatchObject({ ownerType: 'DEPENSE', ownerId: withProof.id, companyId: f.companies.A });
    const stored = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: withProof.id } });
    expect(stored.amount.toFixed(3)).toBe('3.250');
    expect(stored.occurredOn.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'depense.creation', objectId: withProof.id } })).toBe(1);

    // Montants et dates : décimal exact positif, trois décimales, jamais dans le futur ni inexistante.
    for (const amount of ['0', '0.000', '12.3456', '-5', '1e3']) {
      const bad = await post(chefA, { ...body, reference: undefined, amount });
      expect(bad.status, amount).toBe(422);
      expect(bad.body.code, amount).toBe('MONTANT_INVALIDE');
    }
    expect((await post(chefA, { ...body, reference: undefined, amount: 12.5 })).body.code).toBe('VALIDATION');
    expect((await post(chefA, { ...body, reference: undefined, occurredOn: '2026-09-25' })).body.code).toBe('DATE_FUTURE');
    expect((await post(chefA, { ...body, reference: undefined, occurredOn: '2026-02-30' })).body.code).toBe('DATE_INVALIDE');
  });

  it('D-232 — référence fournisseur en double → 409 DEPENSE_REFERENCE_EXISTANTE, casse ignorée, y compris en concurrence', async () => {
    const base = { vehicleId: vehicleA, occurredOn: '2026-09-15', category: 'ENTRETIEN_REPARATION', supplierId: garageA, amount: '300' };
    const first = await expense(chefA, { ...base, reference: 'FAC-2026-001' });
    const dup = await post(chefA, { ...base, reference: '  fac-2026-001 ', amount: '310' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DEPENSE_REFERENCE_EXISTANTE');
    expect(dup.body.details.existingExpenseId).toBe(first.id);
    // Même référence chez un autre fournisseur (ou sans fournisseur) : autre facture.
    expect((await post(chefA, { ...base, supplierId: undefined, reference: 'FAC-2026-001' })).status).toBe(201);

    // Saisies simultanées de la même facture avec des clés différentes : une seule réussit, les autres
    // reçoivent un conflit (référence existante après reprise sérialisable), jamais une erreur interne.
    const racing = await Promise.all([chefA, operateurA, chefA, operateurA].map((agent) => post(agent, { ...base, reference: 'FAC-2026-002' })));
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(racing.map((r) => r.body.code)).toContain('DEPENSE_REFERENCE_EXISTANTE');
    expect(await t.prisma.client.expense.count({ where: { reference: 'FAC-2026-002' } })).toBe(1);

    // Une dépense annulée libère sa référence (seules les validées comptent).
    expect((await chefA.post(`/expenses/${first.id}/cancel`, { reason: 'Saisie en double', expectedVersion: first.version })).status).toBe(200);
    expect((await post(chefA, { ...base, reference: 'FAC-2026-001' })).status).toBe(201);
  });

  it('D-230 — dépense sans véhicule limitée à assurance, taxes, location et autre ; ligne « Non ventilé »', async () => {
    const fleet = await post(chefA, { companyId: f.companies.A, occurredOn: '2026-09-01', category: 'ASSURANCE', supplierId: assureurA, reference: 'POLICE-FLOTTE-2026', amount: '1200' });
    expect(fleet.status, JSON.stringify(fleet.body)).toBe(201);
    expect(fleet.body).toMatchObject({ vehicleId: null, companyId: f.companies.A, allocationLabel: 'Dépense société non affectée', unallocated: true, supplierName: 'Assurances du Cap' });
    for (const category of ['TAXES', 'LOCATION', 'AUTRE']) expect((await post(chefA, { companyId: f.companies.A, occurredOn: '2026-09-02', category, amount: '10' })).status, category).toBe(201);
    for (const category of ['CARBURANT', 'ENTRETIEN_REPARATION', 'PEAGE', 'STATIONNEMENT', 'ACHAT_VEHICULE']) {
      const refused = await post(chefA, { companyId: f.companies.A, occurredOn: '2026-09-02', category, amount: '10' });
      expect(refused.status, category).toBe(422);
      expect(refused.body.code, category).toBe('VEHICULE_REQUIS');
    }
    expect((await post(chefA, { occurredOn: '2026-09-02', category: 'TAXES', amount: '10' })).body.code).toBe('SOCIETE_REQUISE');
    expect((await post(chefA, { companyId: f.companies.B, occurredOn: '2026-09-02', category: 'TAXES', amount: '10' })).status).toBe(404);
    // Fournisseur d'une autre société : introuvable.
    expect((await post(chefB, { companyId: f.companies.B, occurredOn: '2026-09-02', category: 'ASSURANCE', supplierId: assureurA, amount: '10' })).status).toBe(404);
    // La contrainte SQL expense_vehicle_required_by_category protège aussi la base.
    await expect(t.prisma.client.expense.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, occurredOn: new Date('2026-09-02T00:00:00Z'), category: 'CARBURANT', amount: '5' } })).rejects.toThrow();

    await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-03', category: 'ASSURANCE', amount: '100' });
    const s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.byCategory).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'ASSURANCE', label: 'Assurance', net: '1300.000', count: 2 })]));
    expect(s.unallocated).toMatchObject({ label: 'Non ventilé', net: '1230.000', count: 4 });
    expect(s.operating).toMatchObject({ net: '1330.000', count: 5 });
    const onlyUnallocated = await chefA.get('/expenses?unallocated=true');
    expect(onlyUnallocated.body.total).toBe(4);
  });

  it('D-229 — avoir : montant positif soustrait, rattachement facultatif, net négatif affiché tel quel', async () => {
    const invoice = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-05', category: 'ENTRETIEN_REPARATION', supplierId: garageA, reference: 'FAC-50', amount: '500' });
    const credit = await post(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'ENTRETIEN_REPARATION', supplierId: garageA, reference: 'AV-7', amount: '120', relatedExpenseId: invoice.id });
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    expect(credit.body).toMatchObject({ kind: 'AVOIR', amount: '120.000', signedAmount: '-120.000', relatedExpenseId: invoice.id });
    expect((await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'ENTRETIEN_REPARATION', amount: '10', relatedExpenseId: invoice.id })).body.code).toBe('AVOIR_SEULEMENT');
    expect((await post(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'ENTRETIEN_REPARATION', amount: '10', relatedExpenseId: credit.body.id })).body.code).toBe('AVOIR_SUR_AVOIR');
    const other = await expense(chefB, { vehicleId: vehicleB, occurredOn: '2026-09-12', category: 'PEAGE', amount: '4' });
    expect((await post(admin, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'PEAGE', amount: '1', relatedExpenseId: other.id })).body.code).toBe('AVOIR_AUTRE_SOCIETE');
    expect((await post(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'PEAGE', amount: '1', relatedExpenseId: other.id })).status).toBe(404);
    // Avoir sans dépense d'origine : la catégorie peut passer en négatif, affichée telle quelle.
    await expense(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-13', category: 'LOCATION', amount: '50' });

    const s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.byCategory).toEqual([
      { category: 'ENTRETIEN_REPARATION', label: 'Entretien / réparation', expenses: '500.000', credits: '120.000', net: '380.000', count: 2 },
      { category: 'LOCATION', label: 'Location', expenses: '0.000', credits: '50.000', net: '-50.000', count: 1 },
    ]);
    expect(s.operating).toMatchObject({ expenses: '500.000', credits: '170.000', net: '330.000' });
    expect((await chefA.get('/expenses?kind=AVOIR')).body.total).toBe(2);
    // Une dépense qui porte des avoirs validés ne s'annule pas avant eux.
    const blocked = await chefA.post(`/expenses/${invoice.id}/cancel`, { reason: 'Facture contestée', expectedVersion: invoice.version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('AVOIRS_LIES');
    // Après correction de la dépense d'origine, l'avoir reste lié à sa chaîne de versions.
    const corrected = await chefA.post(`/expenses/${invoice.id}/correct`, { amount: '520', reason: 'Montant rectifié', expectedVersion: invoice.version }).set('Idempotency-Key', randomUUID());
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect((await chefA.post(`/expenses/${corrected.body.id}/cancel`, { reason: 'Facture contestée', expectedVersion: 1 })).body.code).toBe('AVOIRS_LIES');
    expect((await chefA.post(`/expenses/${credit.body.id}/cancel`, { reason: 'Avoir annulé par le garage', expectedVersion: 1 })).status).toBe(200);
    expect((await chefA.post(`/expenses/${corrected.body.id}/cancel`, { reason: 'Facture contestée', expectedVersion: 1 })).status).toBe(200);
    expect((await summary(chefA, '?from=2026-09-01&to=2026-09-30')).operating.net).toBe('-50.000');
  });

  it('D-229 — correction : nouvelle dépense VALIDEE, ancienne REMPLACEE, total non compté en double, audit avant/après', async () => {
    const original = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-10', category: 'ENTRETIEN_REPARATION', supplierId: garageA, reference: 'FAC-10', amount: '100' });
    expect((await operateurA.post(`/expenses/${original.id}/correct`, { amount: '120', reason: 'Erreur de montant', expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).status).toBe(403);
    expect((await chefA.post(`/expenses/${original.id}/correct`, { amount: '120', expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).body.code).toBe('VALIDATION');
    expect((await chefA.post(`/expenses/${original.id}/correct`, { amount: '100', reason: 'Rien ne change', expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).body.code).toBe('CORRECTION_SANS_EFFET');
    expect((await chefA.post(`/expenses/${original.id}/correct`, { amount: '120', reason: 'Erreur de montant', expectedVersion: 7 }).set('Idempotency-Key', randomUUID())).body.code).toBe('VERSION_OBSOLETE');

    // Correction idempotente (clé liée à l'utilisateur, à l'organisation et à l'opération) : obligatoire.
    const noKey = await chefA.post(`/expenses/${original.id}/correct`, { amount: '120', reason: 'Erreur de saisie du montant', expectedVersion: 1 });
    expect(noKey.status).toBe(422);
    expect(noKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');
    const correctionKey = randomUUID();
    const correctionBody = { amount: '120', reason: 'Erreur de saisie du montant', expectedVersion: 1 };
    const corrected = await chefA.post(`/expenses/${original.id}/correct`, correctionBody).set('Idempotency-Key', correctionKey);
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    // Relance après une réponse perdue : même réponse, aucune seconde version, pas d'échec « version obsolète ».
    const replayed = await chefA.post(`/expenses/${original.id}/correct`, correctionBody).set('Idempotency-Key', correctionKey);
    expect(replayed.status).toBe(201);
    expect(replayed.body).toEqual(corrected.body);
    const otherBody = await chefA.post(`/expenses/${original.id}/correct`, { ...correctionBody, amount: '125' }).set('Idempotency-Key', correctionKey);
    expect(otherBody.status).toBe(409);
    expect(otherBody.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect(await t.prisma.client.expense.count()).toBe(2);
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'depense.correction', objectId: original.id } })).toBe(1);
    expect(corrected.body).toMatchObject({ status: 'VALIDEE', replacesExpenseId: original.id, companyId: f.companies.A, amount: '120.000', reference: 'FAC-10', supplierId: garageA, occurredOn: '2026-09-10', sourceType: null, version: 1 });
    const old = (await chefA.get(`/expenses/${original.id}`)).body;
    expect(old).toMatchObject({ status: 'REMPLACEE', replacedByExpenseId: corrected.body.id, amount: '100.000', version: 2 });

    expect((await chefA.get('/expenses')).body.items.map((e: { id: string }) => e.id)).toEqual([corrected.body.id]);
    expect((await chefA.get('/expenses?status=TOUS')).body.total).toBe(2);
    expect((await chefA.get('/expenses?status=REMPLACEE')).body.items[0].id).toBe(original.id);
    const s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.operating).toMatchObject({ net: '120.000', count: 1 });

    // L'ancienne version ne se corrige plus ; la nouvelle se corrige à son tour (chaîne de versions).
    expect((await chefA.post(`/expenses/${original.id}/correct`, { amount: '130', reason: 'Nouvelle erreur', expectedVersion: 2 }).set('Idempotency-Key', randomUUID())).body.code).toBe('ETAT_INVALIDE');
    const again = await chefA.post(`/expenses/${corrected.body.id}/correct`, { occurredOn: '2026-09-11', notes: 'Date de facture', reason: 'Date erronée', expectedVersion: 1 }).set('Idempotency-Key', randomUUID());
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({ occurredOn: '2026-09-11', amount: '120.000', notes: 'Date de facture' });
    expect((await summary(chefA, '?from=2026-09-01&to=2026-09-30')).operating.net).toBe('120.000');

    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'depense.correction', objectId: original.id } });
    expect(audit.reason).toBe('Erreur de saisie du montant');
    expect(audit.before).toMatchObject({ amount: '100.000' });
    expect(audit.after).toMatchObject({ amount: '120.000', newExpenseId: corrected.body.id });
    expect(audit.actorUserId).toBe(f.users.chefA);
  });

  it('D-229 — annulation motivée : le coût disparaît de sa période d’origine, sans écriture sur la période courante', async () => {
    const august = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-08-10', category: 'PEAGE', amount: '200' });
    expect((await summary(chefA, '?from=2026-08-01&to=2026-08-31')).operating.net).toBe('200.000');
    expect((await operateurA.post(`/expenses/${august.id}/cancel`, { reason: 'Doublon', expectedVersion: 1 })).status).toBe(403);
    const cancelled = await chefA.post(`/expenses/${august.id}/cancel`, { reason: 'Ticket saisi deux fois', expectedVersion: 1 });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'ANNULEE', cancelReason: 'Ticket saisi deux fois', occurredOn: '2026-08-10', version: 2 });
    expect(cancelled.body.cancelledAt).toBe('2026-09-24T10:00:00.000Z');
    expect(await summary(chefA, '?from=2026-08-01&to=2026-08-31')).toMatchObject({ operating: { net: '0.000', count: 0 }, byCategory: [] });
    expect((await summary(chefA, '?from=2026-09-01&to=2026-09-30')).operating).toMatchObject({ net: '0.000', count: 0 });
    expect((await chefA.get('/expenses')).body.total).toBe(0);
    expect((await chefA.get('/expenses?status=ANNULEE')).body.items[0].id).toBe(august.id);
    expect((await chefA.post(`/expenses/${august.id}/cancel`, { reason: 'Encore', expectedVersion: 2 })).body.code).toBe('ETAT_INVALIDE');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'depense.annulation', objectId: august.id } });
    expect(audit.reason).toBe('Ticket saisi deux fois');
  });

  it('T24 — la dépense de synthèse d’une intervention apparaît une seule fois ; elle se corrige par sa source', async () => {
    const created = await chefA.post('/interventions', { vehicleId: vehicleA, kind: 'CORRECTIF', supplierId: garageA, tasks: [{ label: 'Remplacement des plaquettes' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const i = created.body as { id: string; reference: string; version: number; tasks: Array<{ id: string }> };
    const body = { performedOn: '2026-09-23', completedTaskIds: i.tasks.map((x) => x.id), expectedVersion: i.version, lines: [{ kind: 'PIECE', label: 'Plaquettes', quantity: '4.5', unitPrice: '32.500' }, { kind: 'MAIN_OEUVRE', label: 'Main-d’œuvre', quantity: '1', unitPrice: '45' }] };
    const key = randomUUID();
    const done = await chefA.post(`/interventions/${i.id}/complete`, body).set('Idempotency-Key', key);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await chefA.post(`/interventions/${i.id}/complete`, body).set('Idempotency-Key', key)).status).toBe(200);
    expect((await chefA.post(`/interventions/${i.id}/complete`, body).set('Idempotency-Key', randomUUID())).status).toBe(409);

    const list = await chefA.get(`/expenses?vehicleId=${vehicleA}`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ sourceType: 'INTERVENTION', sourceId: i.id, reference: i.reference, category: 'ENTRETIEN_REPARATION', amount: '191.250', companyId: f.companies.A, occurredOn: '2026-09-23', supplierName: 'Garage Central', status: 'VALIDEE' });
    expect((await chefA.get('/expenses?sourceType=INTERVENTION')).body.total).toBe(1);
    expect((await chefA.get('/expenses?sourceType=MANUELLE')).body.total).toBe(0);
    // Les lignes (pièces, main-d'œuvre) ne sont pas recomptées : le registre seul fait foi.
    const s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.byCategory).toEqual([{ category: 'ENTRETIEN_REPARATION', label: 'Entretien / réparation', expenses: '191.250', credits: '0.000', net: '191.250', count: 1 }]);
    expect(s.operating.net).toBe('191.250');

    const expenseId = list.body.items[0].id as string;
    const correct = await chefA.post(`/expenses/${expenseId}/correct`, { amount: '200', reason: 'Facture différente', expectedVersion: 1 }).set('Idempotency-Key', randomUUID());
    expect(correct.status).toBe(422);
    expect(correct.body.code).toBe('CORRECTION_PAR_LA_SOURCE');
    expect(correct.body.message).toMatch(/rouvrez l’intervention/);
    expect((await chefA.post(`/expenses/${expenseId}/cancel`, { reason: 'Erreur', expectedVersion: 1 })).body.code).toBe('CORRECTION_PAR_LA_SOURCE');
    // Réouverture de l'intervention : la dépense liée est retirée du registre dans la même transaction.
    const reopened = await chefA.post(`/interventions/${i.id}/reopen`, { reason: 'Facture à reprendre', expectedVersion: done.body.version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect((await summary(chefA, '?from=2026-09-01&to=2026-09-30')).operating).toMatchObject({ net: '0.000', count: 0 });
    expect((await chefA.get(`/expenses?vehicleId=${vehicleA}`)).body.total).toBe(0);
  });

  it('permissions : lecteur sans costs.read 403 ; opérateur saisit mais ne corrige ni n’annule ; conducteur exclu', async () => {
    const created = await expense(operateurA, { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'CARBURANT', amount: '80' });
    expect(created.companyId).toBe(f.companies.A);
    for (const path of ['/expenses', '/expenses/summary', `/expenses/${created.id}`]) {
      const res = await lecteurA.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('ACTION_INTERDITE');
    }
    // L'opérateur a costs.write mais pas costs.read par défaut.
    expect((await operateurA.get('/expenses')).status).toBe(403);
    expect((await operateurA.post(`/expenses/${created.id}/correct`, { amount: '81', reason: 'Correction', expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).status).toBe(403);
    expect((await operateurA.post(`/expenses/${created.id}/cancel`, { reason: 'Annulation', expectedVersion: 1 })).status).toBe(403);
    expect((await post(lecteurA, { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'CARBURANT', amount: '80' })).status).toBe(403);
    const conducteur = await login(t.server, f.emails.conducteurA, DEFAULT_PASSWORD);
    expect((await conducteur.get('/expenses')).status).toBe(403);
    expect((await conducteur.get(`/expenses/${created.id}`)).status).toBe(404);
    expect((await post(conducteur, { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'CARBURANT', amount: '80' })).status).toBe(403);

    // Un lecteur à qui costs.read est accordé explicitement consulte, sans pouvoir saisir.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.lecteurA }, data: { grantedPermissions: ['COSTS_READ'] } });
    const reader = await login(t.server, f.emails.lecteurA, DEFAULT_PASSWORD);
    expect((await reader.get('/expenses')).body.total).toBe(1);
    expect((await reader.get(`/expenses/${created.id}`)).body.amount).toBe('80.000');
    expect((await post(reader, { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'CARBURANT', amount: '80' })).status).toBe(403);

    // Un chef privé de costs.read ne corrige, n'annule ni ne bascule : chaque réponse montrerait la dépense.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.chefA }, data: { revokedPermissions: ['COSTS_READ'] } });
    const blindChef = await login(t.server, f.emails.chefA, DEFAULT_PASSWORD);
    const attempts = [
      await blindChef.post(`/expenses/${created.id}/correct`, { amount: '81', reason: 'Correction', expectedVersion: 1 }).set('Idempotency-Key', randomUUID()),
      await blindChef.post(`/expenses/${created.id}/cancel`, { reason: 'Annulation', expectedVersion: 1 }),
      await blindChef.patch(`/expenses/${created.id}/operating-cost`, { excludedFromOperatingCost: false, expectedVersion: 1 }),
      await blindChef.get(`/expenses/${created.id}`),
    ];
    for (const res of attempts) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('80.000');
    }
    expect(await t.prisma.client.expense.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ status: 'VALIDEE', version: 1 });
    expect(await t.prisma.client.expense.count()).toBe(1);
  });

  it('cloisonnement : le chef B ne voit rien de A, ni dans la liste, ni dans les totaux, ni par identifiant', async () => {
    const a = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-18', category: 'ENTRETIEN_REPARATION', amount: '100' });
    const fleetA = await expense(chefA, { companyId: f.companies.A, occurredOn: '2026-09-18', category: 'TAXES', amount: '60' });
    const b = await expense(chefB, { vehicleId: vehicleB, occurredOn: '2026-09-18', category: 'PEAGE', amount: '40' });
    expect(b.companyId).toBe(f.companies.B);

    const listB = await chefB.get('/expenses');
    expect(listB.body.total).toBe(1);
    expect(listB.body.items[0].id).toBe(b.id);
    expect((await chefB.get(`/expenses?vehicleId=${vehicleA}`)).body.total).toBe(0);
    expect((await chefB.get(`/expenses?companyId=${f.companies.A}`)).status).toBe(404);
    expect((await chefB.get(`/expenses/summary?companyId=${f.companies.A}`)).status).toBe(404);
    const sB = await summary(chefB);
    expect(sB.operating).toMatchObject({ net: '40.000', count: 1 });
    expect(sB.unallocated).toMatchObject({ net: '0.000', count: 0 });
    for (const id of [a.id, fleetA.id]) {
      expect((await chefB.get(`/expenses/${id}`)).status).toBe(404);
      expect((await chefB.post(`/expenses/${id}/correct`, { amount: '1', reason: 'Tentative', expectedVersion: 1 }).set('Idempotency-Key', randomUUID())).status).toBe(404);
      expect((await chefB.post(`/expenses/${id}/cancel`, { reason: 'Tentative', expectedVersion: 1 })).status).toBe(404);
      expect((await chefB.patch(`/expenses/${id}/operating-cost`, { excludedFromOperatingCost: true, expectedVersion: 1 })).status).toBe(404);
    }
    expect((await post(chefB, { vehicleId: vehicleA, occurredOn: '2026-09-18', category: 'PEAGE', amount: '1' })).status).toBe(404);
    expect((await summary(chefA)).operating).toMatchObject({ net: '160.000', count: 2 });
    expect((await summary(admin)).operating).toMatchObject({ net: '200.000', count: 3 });
    expect((await summary(admin, `?companyId=${f.companies.B}`)).operating.net).toBe('40.000');
  });

  it('D-233 — achat de véhicule conservé à titre informatif, exclu du coût d’exploitation par défaut ; bascule auditée (costs.write + costs.read)', async () => {
    const purchase = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-01', category: 'ACHAT_VEHICULE', amount: '45000' });
    expect(purchase).toMatchObject({ excludedFromOperatingCost: true });
    await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-02', category: 'CARBURANT', amount: '90.500' });
    let s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.operating).toMatchObject({ net: '90.500', count: 1 });
    expect(s.byCategory.map((c: { category: string }) => c.category)).toEqual(['CARBURANT']);
    expect(s.excludedFromOperatingCost).toMatchObject({ net: '45000.000', count: 1, byCategory: [expect.objectContaining({ category: 'ACHAT_VEHICULE', net: '45000.000' })] });

    expect((await lecteurA.patch(`/expenses/${purchase.id}/operating-cost`, { excludedFromOperatingCost: false, expectedVersion: 1 })).status).toBe(403);
    // L'opérateur (costs.write sans costs.read) ne peut pas se servir de la bascule, même sans effet, pour
    // lire une dépense que la consultation lui refuse : 403, aucun montant renvoyé, rien de modifié.
    for (const excludedFromOperatingCost of [true, false]) {
      const denied = await operateurA.patch(`/expenses/${purchase.id}/operating-cost`, { excludedFromOperatingCost, expectedVersion: 1 });
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body.code).toBe('ACTION_INTERDITE');
      expect(JSON.stringify(denied.body)).not.toContain('45000');
    }
    expect(await t.prisma.client.expense.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({ excludedFromOperatingCost: true, version: 1 });
    // Titulaire de costs.write qui consulte aussi les coûts (permission accordée explicitement) : bascule auditée.
    await t.prisma.client.membership.updateMany({ where: { userId: f.users.operateurA }, data: { grantedPermissions: ['COSTS_READ'] } });
    const operator = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    const toggled = await operator.patch(`/expenses/${purchase.id}/operating-cost`, { excludedFromOperatingCost: false, reason: 'Location-achat comptée en exploitation', expectedVersion: 1 });
    expect(toggled.status, JSON.stringify(toggled.body)).toBe(200);
    expect(toggled.body).toMatchObject({ excludedFromOperatingCost: false, version: 2, status: 'VALIDEE' });
    expect((await operator.patch(`/expenses/${purchase.id}/operating-cost`, { excludedFromOperatingCost: true, expectedVersion: 1 })).body.code).toBe('VERSION_OBSOLETE');
    s = await summary(chefA, '?from=2026-09-01&to=2026-09-30');
    expect(s.operating).toMatchObject({ net: '45090.500', count: 2 });
    expect(s.excludedFromOperatingCost).toMatchObject({ net: '0.000', count: 0 });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'depense.cout_exploitation', objectId: purchase.id } });
    expect(audit).toMatchObject({ reason: 'Location-achat comptée en exploitation', before: { excludedFromOperatingCost: true }, after: { excludedFromOperatingCost: false } });
    // Un autre choix explicite à la saisie est respecté.
    expect(await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-03', category: 'ACHAT_VEHICULE', amount: '1000', excludedFromOperatingCost: false })).toMatchObject({ excludedFromOperatingCost: false });
  });

  it('T26 — une dépense datée avant un transfert reste imputée à la société historique ; coûts historiques inchangés', async () => {
    const before = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-08-15', category: 'ENTRETIEN_REPARATION', amount: '300' });
    expect(before.companyId).toBe(f.companies.A);
    // Transfert A → B au 1er septembre (historique écrit directement, le module de transfert n'étant pas l'objet de ce test).
    await t.prisma.client.vehicleCompanyHistory.create({ data: { organizationId: f.organizationId, vehicleId: vehicleA, fromCompanyId: f.companies.A, toCompanyId: f.companies.B, effectiveAt: new Date('2026-09-01T07:00:00Z'), reason: 'Transfert interne' } });
    await t.prisma.client.vehicle.update({ where: { id: vehicleA }, data: { companyId: f.companies.B } });

    // Coûts historiques inchangés : la dépense reste à A, jamais réimputée au propriétaire courant.
    expect((await chefA.get(`/expenses/${before.id}`)).body.companyId).toBe(f.companies.A);
    expect((await summary(chefA, '?from=2026-08-01&to=2026-08-31')).operating.net).toBe('300.000');
    expect((await summary(chefB, '?from=2026-08-01&to=2026-08-31')).operating).toMatchObject({ net: '0.000', count: 0 });

    // Nouvelle dépense datée après le transfert : société B ; datée avant : société A.
    const after = await expense(chefB, { vehicleId: vehicleA, occurredOn: '2026-09-10', category: 'PEAGE', amount: '7' });
    expect(after.companyId).toBe(f.companies.B);
    const late = await post(chefB, { vehicleId: vehicleA, occurredOn: '2026-08-20', category: 'PEAGE', amount: '5' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('PERIODE_HORS_PERIMETRE');
    // Même règle pour un incident antidaté (D-121) : il appartient à la société d'origine.
    const lateIncident = await chefB.post('/incidents', { vehicleId: vehicleA, type: 'PANNE', description: 'Panne constatée en août', occurredAt: '2026-08-20T08:00:00Z' });
    expect(lateIncident.status).toBe(422);
    expect(lateIncident.body.code).toBe('PERIODE_HORS_PERIMETRE');
    const lateA = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-08-20', category: 'PEAGE', amount: '5' });
    expect(lateA.companyId).toBe(f.companies.A);
    expect((await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-10', category: 'PEAGE', amount: '5' })).status).toBe(404);
    const byAdmin = await expense(admin, { vehicleId: vehicleA, occurredOn: '2026-08-31', category: 'STATIONNEMENT', amount: '2' });
    expect(byAdmin.companyId).toBe(f.companies.A);
    expect((await post(admin, { vehicleId: vehicleA, companyId: f.companies.B, occurredOn: '2026-08-31', category: 'STATIONNEMENT', amount: '2' })).body.code).toBe('SOCIETE_HISTORIQUE');
    // Une correction ne change jamais la société imputée.
    const moved = await admin.post(`/expenses/${before.id}/correct`, { occurredOn: '2026-09-05', reason: 'Date erronée', expectedVersion: 1 }).set('Idempotency-Key', randomUUID());
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe('SOCIETE_INCHANGEE');

    expect((await chefA.get(`/expenses?vehicleId=${vehicleA}`)).body.total).toBe(3);
    expect((await chefB.get(`/expenses?vehicleId=${vehicleA}`)).body.total).toBe(1);
    expect((await summary(chefA)).operating.net).toBe('307.000');
    expect((await summary(chefB)).operating.net).toBe('7.000');
  });

  it('D-217 — coût lié à un incident : dépenses rattachées et interventions issues, avoirs soustraits', async () => {
    const incident = await chefA.post('/incidents', { vehicleId: vehicleA, type: 'DOMMAGE', description: 'Rétroviseur arraché sur parking' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const incidentId = incident.body.id as string;
    const tow = await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-20', category: 'AUTRE', amount: '80', relatedIncidentId: incidentId, notes: 'Remorquage' });
    expect(tow.status, JSON.stringify(tow.body)).toBe(201);
    expect(tow.body).toMatchObject({ relatedIncidentId: incidentId, relatedIncidentReference: incident.body.reference });
    await expense(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-21', category: 'AUTRE', amount: '20', relatedIncidentId: incidentId });
    const repair = await chefA.post('/interventions', { vehicleId: vehicleA, kind: 'CORRECTIF', incidentId, tasks: [{ label: 'Remplacement du rétroviseur' }] });
    expect(repair.status, JSON.stringify(repair.body)).toBe(201);
    const done = await chefA.post(`/interventions/${repair.body.id}/complete`, { performedOn: '2026-09-22', completedTaskIds: repair.body.tasks.map((x: { id: string }) => x.id), expectedVersion: repair.body.version, totalAmount: '150' }).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Dépense sans lien avec l'incident : non comptée.
    await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-22', category: 'PEAGE', amount: '9' });

    expect((await chefA.get(`/incidents/${incidentId}`)).body.linkedCost).toBe('210.000');
    const linked = await chefA.get(`/expenses?relatedIncidentId=${incidentId}`);
    expect(linked.body.total).toBe(3);
    expect((await summary(chefA, `?relatedIncidentId=${incidentId}`)).operating.net).toBe('210.000');

    const otherVehicle = await createVehicle(t.prisma, f, 'A');
    expect((await post(chefA, { vehicleId: otherVehicle, occurredOn: '2026-09-22', category: 'AUTRE', amount: '1', relatedIncidentId: incidentId })).body.code).toBe('INCIDENT_AUTRE_VEHICULE');
    expect((await post(chefA, { companyId: f.companies.A, occurredOn: '2026-09-22', category: 'AUTRE', amount: '1', relatedIncidentId: incidentId })).body.code).toBe('INCIDENT_AUTRE_VEHICULE');
    const incidentB = await chefB.post('/incidents', { vehicleId: vehicleB, type: 'PANNE', description: 'Batterie à plat' });
    expect((await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-22', category: 'AUTRE', amount: '1', relatedIncidentId: incidentB.body.id })).status).toBe(404);
  });

  it('D-232 niveau 3 — un justificatif identique déjà rattaché déclenche un avertissement à confirmer', async () => {
    const first = await uploadPdf(chefA, t.server, f.companies.A, 'ticket.pdf');
    const second = await uploadPdf(chefA, t.server, f.companies.A, 'ticket-scan.pdf');
    const original = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-19', category: 'CARBURANT', amount: '70', attachmentId: first });
    const warned = await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-19', category: 'CARBURANT', amount: '70', attachmentId: second });
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe('JUSTIFICATIF_DEJA_UTILISE');
    expect(warned.body.details.expenseIds).toEqual([original.id]);
    expect(await t.prisma.client.expense.count()).toBe(1);
    const confirmed = await post(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-19', category: 'CARBURANT', amount: '70', attachmentId: second, confirmDuplicateAttachment: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'depense.creation', objectId: confirmed.body.id } });
    expect(audit.after).toMatchObject({ duplicateAttachmentConfirmed: true });
  });

  it('D-229 — un avoir et l’annulation concurrente de sa dépense d’origine ne réussissent jamais tous les deux', async () => {
    for (let round = 0; round < 8; round += 1) {
      const origin = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-10', category: 'ENTRETIEN_REPARATION', amount: '100' });
      const [cancelled, credit] = await Promise.all([
        chefA.post(`/expenses/${origin.id}/cancel`, { reason: 'Facture annulée par le garage', expectedVersion: 1 }),
        post(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-11', category: 'ENTRETIEN_REPARATION', amount: '10', relatedExpenseId: origin.id }),
      ]);
      const statuses = `${cancelled.status}/${credit.status} ${JSON.stringify([cancelled.body.code, credit.body.code])}`;
      // Jamais d'erreur interne ni de double succès : l'un des deux est refusé avec un motif métier.
      expect([cancelled.status, credit.status], statuses).not.toContain(500);
      expect(cancelled.status === 200 && credit.status === 201, statuses).toBe(false);
      if (cancelled.status !== 200) expect(cancelled.body.code, statuses).toBe('AVOIRS_LIES');
      if (credit.status !== 201) expect(credit.body.code, statuses).toBe('DEPENSE_ORIGINE_INACTIVE');
      const row = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: origin.id } });
      const liveCredits = await t.prisma.client.expense.count({ where: { relatedExpenseId: origin.id, kind: 'AVOIR', status: 'VALIDEE' } });
      expect(row.status === 'ANNULEE' && liveCredits > 0, statuses).toBe(false);
    }
    // Hors concurrence : un avoir ne se rattache pas à une dépense annulée.
    const cancelledOrigin = await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-09-12', category: 'PEAGE', amount: '15' });
    expect((await chefA.post(`/expenses/${cancelledOrigin.id}/cancel`, { reason: 'Ticket en double', expectedVersion: 1 })).status).toBe(200);
    const late = await post(chefA, { kind: 'AVOIR', vehicleId: vehicleA, occurredOn: '2026-09-13', category: 'PEAGE', amount: '5', relatedExpenseId: cancelledOrigin.id });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('DEPENSE_ORIGINE_INACTIVE');
  });

  it('CDC 2.4 — coût lié à un incident d’un véhicule transféré : la dépense d’une autre société n’est ni additionnée ni révélée', async () => {
    const incident = await chefA.post('/incidents', { vehicleId: vehicleA, type: 'DOMMAGE', description: 'Pare-choc enfoncé', occurredAt: '2026-08-20T09:00:00.000Z' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const incidentId = incident.body.id as string;
    expect(incident.body.companyId).toBe(f.companies.A);
    await expense(chefA, { vehicleId: vehicleA, occurredOn: '2026-08-21', category: 'AUTRE', amount: '100', relatedIncidentId: incidentId });
    // Transfert A → B au 1er septembre ; l'administrateur rattache une dépense de B (datée après) au même incident.
    await t.prisma.client.vehicleCompanyHistory.create({ data: { organizationId: f.organizationId, vehicleId: vehicleA, fromCompanyId: f.companies.A, toCompanyId: f.companies.B, effectiveAt: new Date('2026-09-01T07:00:00Z'), reason: 'Transfert interne' } });
    await t.prisma.client.vehicle.update({ where: { id: vehicleA }, data: { companyId: f.companies.B } });
    const inB = await expense(admin, { vehicleId: vehicleA, occurredOn: '2026-09-10', category: 'AUTRE', amount: '40', relatedIncidentId: incidentId });
    expect(inB.companyId).toBe(f.companies.B);

    // Le chef A ne voit ni le coût de B dans le coût lié de son incident, ni la dépense dans le registre filtré.
    expect((await chefA.get(`/incidents/${incidentId}`)).body.linkedCost).toBe('100.000');
    expect((await chefA.get(`/expenses?relatedIncidentId=${incidentId}`)).body.total).toBe(1);
    expect((await summary(chefA, `?relatedIncidentId=${incidentId}`)).operating.net).toBe('100.000');
    // L'administrateur a la vue complète.
    expect((await admin.get(`/incidents/${incidentId}`)).body.linkedCost).toBe('140.000');
    expect((await summary(admin, `?relatedIncidentId=${incidentId}`)).operating.net).toBe('140.000');
    // Le chef B voit sa dépense, sans la référence d'un incident de A qu'il ne peut pas consulter.
    const seenByB = await chefB.get(`/expenses/${inB.id}`);
    expect(seenByB.status).toBe(200);
    expect(seenByB.body.relatedIncidentReference).toBeNull();
    expect((await admin.get(`/expenses/${inB.id}`)).body.relatedIncidentReference).toBe(incident.body.reference);
  });
});
