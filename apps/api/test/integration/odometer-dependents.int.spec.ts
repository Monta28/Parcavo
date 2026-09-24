import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AfterCommit } from '../../src/common/after-commit.js';
import { OdometerEventsService } from '../../src/modules/odometer/odometer-events.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, uploadPdf, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * Données dépendantes du kilométrage (CDC 5.3, 5.4, 13.3, 15.3 ; T13, T14) : une correction recalcule dans
 * sa transaction les échéances d'entretien, la fraîcheur et leurs alertes ; une correction qui rendrait un
 * événement incohérent est bloquée ; l'entretien suit le kilométrage cumulé ; la source reste contrôlée
 * par le serveur.
 */
describe('Kilométrage — données dépendantes, compteur remplacé et contrats de saisie (CDC 5.2 à 5.4, 13.3, 15.3)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let vidangeId: string;
  let keySeq = 0;
  const key = () => `cle-dep-${Date.now()}-${keySeq++}`;

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
    operateurA = await login(t.server, f.emails.operateurA, DEFAULT_PASSWORD);
    vehicleId = await createVehicle(t.prisma, f, 'A', { code: 'VA-1' });
    const type = await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    vidangeId = type.body.id;
  });

  const reading = (agent: Agent, physicalKm: string, observedAt: string, extra: Record<string, unknown> = {}) => agent.post(`/vehicles/${vehicleId}/readings`, { physicalKm, observedAt, ...extra });
  const plan = async (body: Record<string, unknown>) => {
    const res = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; status: string };
  };
  const planRow = (id: string) => t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id } });
  const dueAlert = (planId: string) => t.prisma.client.alert.findFirst({ where: { type: 'ENTRETIEN_ECHEANCE', objectId: planId }, orderBy: { createdAt: 'desc' } });

  it('R-5.3-06 / R-13.3-07 — correction : échéance, statut du plan et alerte d’entretien recalculés, fraîcheur réévaluée, traces dans l’audit', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '40000' });
    const p = await plan({ intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '35000', baseDate: '2026-03-01' } });
    const typo = await reading(chefA, '44800', '2026-09-23T08:00:00Z');
    expect(typo.body.outcome).toBe('ACCEPTE');
    // 44 800 lus : échéance 45 000 dans le préavis de 500 km → à prévoir, alerte active.
    expect((await planRow(p.id)).computedStatus).toBe('A_PREVOIR');
    expect((await dueAlert(p.id))?.status).toBe('ACTIVE');
    // Le compteur affichait 44 080 : la correction ramène le plan à jour et résout l'alerte.
    const corrected = await chefA.post(`/readings/${typo.body.reading.id}/correct`, { reason: 'Chiffres inversés à la saisie', replacementReading: { physicalKm: '44080' }, expectedVersion: typo.body.reading.version }).set('Idempotency-Key', key());
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    const row = await planRow(p.id);
    expect(row.computedStatus).toBe('A_JOUR');
    expect(row.nextDueKm?.toString()).toBe('45000');
    const alert = await dueAlert(p.id);
    expect(alert?.status).toBe('RESOLUE');
    expect(alert?.resolutionReason).toBe('échéance non atteinte');
    const view = await chefA.get(`/maintenance-plans/${p.id}`);
    expect(view.body.currentKm).toBe('44080');
    expect(view.body.remainingKm).toBe('920');
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'releve.correction', objectId: typo.body.reading.id } });
    expect([...(audit.after as { recomputed: string[] }).recomputed].sort()).toEqual(['entretien', 'fraicheur']);

    // Correction de la date d'un relevé libre vers une date ancienne : la fraîcheur se dégrade dans la même
    // transaction (alerte « kilométrage à actualiser » levée sans attendre le rattrapage).
    const second = await chefA.post(`/readings/${corrected.body.id}/correct`, { reason: 'Relevé en réalité du 10 septembre', replacementReading: { physicalKm: '44080', observedAt: '2026-09-10T08:00:00Z' }, expectedVersion: corrected.body.version }).set('Idempotency-Key', key());
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const stale = await t.prisma.client.alert.findMany({ where: { type: 'KILOMETRAGE_ANCIEN', objectId: vehicleId, status: 'ACTIVE' } });
    expect(stale.map((a) => a.occurrenceKey)).toEqual(['depuis:2026-09-10']);
  });

  it('R-13.3-07 — le recalcul des dépendances s’exécute dans la transaction appelante : annulée avec elle, rien n’est écrit', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '40000' });
    const p = await plan({ intervalKm: '10000', noticeKm: '500', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '35000', baseDate: '2026-03-01' } });
    const r = await reading(chefA, '44800', '2026-09-23T08:00:00Z');
    expect((await planRow(p.id)).computedStatus).toBe('A_PREVOIR');
    const events = t.app.get(OdometerEventsService);
    const after = new AfterCommit();
    let seenInside: string | null = null;
    await expect(
      t.prisma.client.$transaction(async (tx) => {
        await tx.odometerReading.update({ where: { id: r.body.reading.id }, data: { physicalKm: '44080', cumulativeKm: '44080' } });
        const names = await events.recomputeDependentsInTx(tx, { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, readingId: r.body.reading.id, origin: 'MANUAL', measurementKind: 'COMPTEUR_AFFICHE', isEstimate: false }, after);
        expect([...names].sort()).toEqual(['entretien', 'fraicheur']);
        seenInside = (await tx.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: p.id } })).computedStatus;
        expect((await tx.alert.findFirstOrThrow({ where: { type: 'ENTRETIEN_ECHEANCE', objectId: p.id } })).status).toBe('RESOLUE');
        throw new Error('annulation volontaire de la transaction');
      }),
    ).rejects.toThrow('annulation volontaire');
    expect(seenInside).toBe('A_JOUR');
    // Transaction annulée : plan et alerte inchangés, relevé intact.
    expect((await planRow(p.id)).computedStatus).toBe('A_PREVOIR');
    expect((await dueAlert(p.id))?.status).toBe('ACTIVE');
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: r.body.reading.id } })).physicalKm?.toString()).toBe('44800');
  });

  it('R-5.3-08 — la date d’un relevé de remise ou de restitution ne se corrige pas hors de l’événement (bloqué) ; sa valeur oui, distance recalculée', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '40000' });
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-A1', categories: ['B'] } });
    const out = await chefA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T07:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '40100' }, location: { placeLabel: 'Dépôt' } })
      .set('Idempotency-Key', key());
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const back = await chefA.post(`/usages/${out.body.id}/return`, { returnedAt: '2026-09-24T09:00:00Z', reading: { physicalKm: '40300' }, location: { placeLabel: 'Dépôt' }, expectedVersion: out.body.version }).set('Idempotency-Key', key());
    expect(back.body.distanceKm).toBe('200.000');
    const returnReading = back.body.returnReading as { id: string };
    const version = (await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: returnReading.id } })).version;
    const moved = await chefA.post(`/readings/${returnReading.id}/correct`, { reason: 'Heure de lecture différente', replacementReading: { physicalKm: '40300', observedAt: '2026-09-24T08:30:00Z' }, expectedVersion: version }).set('Idempotency-Key', key());
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe('CORRECTION_BLOQUEE');
    expect(Object.keys(moved.body.fieldErrors)).toEqual(['replacementReading.observedAt']);
    expect(moved.body.details).toMatchObject({ anomaly: 'DATE_LIEE_A_UN_EVENEMENT', dependents: [{ type: 'utilisation', id: out.body.id }] });
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: returnReading.id } })).status).toBe('ACCEPTE');
    // La valeur se corrige (même instant) : l'utilisation suit le remplacement et sa distance est recalculée.
    const value = await chefA.post(`/readings/${returnReading.id}/correct`, { reason: 'Valeur mal lue', replacementReading: { physicalKm: '40280' }, expectedVersion: version }).set('Idempotency-Key', key());
    expect(value.status, JSON.stringify(value.body)).toBe(200);
    const usage = (await chefA.get(`/usages/${out.body.id}`)).body;
    expect(usage.returnReading.id).toBe(value.body.id);
    expect(usage).toMatchObject({ distanceStatus: 'VALIDEE', distanceKm: '180.000' });
    // Une valeur de départ supérieure au retour rendrait la distance négative : bloquée par la chronologie.
    const checkoutReading = usage.checkoutReading as { id: string };
    const cv = (await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: checkoutReading.id } })).version;
    const inverted = await chefA.post(`/readings/${checkoutReading.id}/correct`, { reason: 'Départ mal lu', replacementReading: { physicalKm: '40290' }, expectedVersion: cv }).set('Idempotency-Key', key());
    expect(inverted.status).toBe(422);
    expect(inverted.body.code).toBe('CORRECTION_BLOQUEE');
  });

  it('R-5.3-06 / R-5.3-08 — compteur remplacé : la valeur qui a fixé la base cumulée du compteur suivant ne se corrige pas ; aucun relevé rétroactif ni validation ne dépasse cette base', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-01-01T08:00:00Z', physicalKm: '100000' });
    const last = await reading(chefA, '120000', '2026-09-20T08:00:00Z');
    expect(last.body.outcome).toBe('ACCEPTE');
    // Hausse jugée implausible avant le remplacement : en attente, elle ne compte pas dans la base.
    const pending = await reading(chefA, '120500', '2026-09-20T12:00:00Z');
    expect(pending.body.outcome).toBe('EN_ATTENTE');
    const proof = await uploadPdf(chefA, t.server, f.companies.A, 'facture-compteur.pdf');
    const replaced = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-21T08:00:00Z', physicalKm: '0', reason: 'remplacement du bloc compteur', justificationAttachmentId: proof });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.startCumulativeKm).toBe('120000.000');
    const after = await reading(chefA, '100', '2026-09-22T08:00:00Z');
    expect(after.body.reading.cumulativeKm).toBe('120100.000');

    // Correction de la valeur qui a fixé la base (120 000) : bloquée, rien n'est remplacé.
    const typo = await chefA.post(`/readings/${last.body.reading.id}/correct`, { reason: 'Faute de frappe', replacementReading: { physicalKm: '119000' }, expectedVersion: last.body.reading.version }).set('Idempotency-Key', key());
    expect(typo.status).toBe(422);
    expect(typo.body).toMatchObject({ code: 'CORRECTION_BLOQUEE', details: { anomaly: 'BASE_COMPTEUR_SUIVANT', segmentId: replaced.body.id, segmentSequence: 2 } });
    expect(Object.keys(typo.body.fieldErrors)).toEqual(['replacementReading.physicalKm']);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: last.body.reading.id } })).status).toBe('ACCEPTE');
    expect((await t.prisma.client.odometerSegment.findUniqueOrThrow({ where: { id: replaced.body.id } })).startCumulativeKm.toString()).toBe('120000');

    // La relève en attente dépasserait la base du nouveau compteur : sa validation est impossible.
    const approve = await chefA.post(`/readings/${pending.body.reading.id}/approve`, { expectedVersion: pending.body.reading.version, reason: 'Trajet confirmé' });
    expect(approve.status).toBe(422);
    expect(approve.body.code).toBe('VALIDATION_IMPOSSIBLE');
    // Relevé rétroactif sur l'ancien compteur après sa dernière valeur validée : au-delà de la base, refusé ;
    // à la même valeur (véhicule immobile), accepté.
    const segments = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body as Array<{ id: string; sequence: number }>;
    const old = segments.find((s) => s.sequence === 1)?.id;
    const beyond = await reading(operateurA, '120200', '2026-09-20T14:00:00Z', { odometerSegmentId: old });
    expect(beyond.status).toBe(422);
    expect(beyond.body.code).toBe('CHRONOLOGIE_SUIVANT');
    const still = await reading(operateurA, '120000', '2026-09-20T20:00:00Z', { odometerSegmentId: old });
    expect(still.status, JSON.stringify(still.body)).toBe(201);
    expect(still.body.outcome).toBe('ACCEPTE');
    // Le cumul du véhicule reste croissant dans le temps.
    const accepted = await t.prisma.client.odometerReading.findMany({ where: { vehicleId, status: 'ACCEPTE', isEstimate: false }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }] });
    const cumuls = accepted.map((r) => Number(r.cumulativeKm));
    expect(cumuls).toEqual([...cumuls].sort((a, b) => a - b));
  });

  it('R-18-14 / R-5.4-06 / R-3.1-10 — T14 : après remplacement à 120 000 par 0, lecture 500 = 120 500 cumulés et l’entretien suit le cumul (synthèse comprise)', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-01-01T08:00:00Z', physicalKm: '100000' });
    expect((await reading(chefA, '120000', '2026-09-20T08:00:00Z')).body.outcome).toBe('ACCEPTE');
    const proof = await uploadPdf(chefA, t.server, f.companies.A, 'facture-compteur.pdf');
    const replaced = await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-21T08:00:00Z', physicalKm: '0', reason: 'remplacement du bloc compteur', justificationAttachmentId: proof });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    // Vidange tous les 10 000 km, dernière à 111 000 cumulés : échéance 121 000, préavis 1 000.
    const vidange = await plan({ intervalKm: '10000', noticeKm: '1000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '111000', baseDate: '2026-05-01' } });
    const pneus = (await admin.post('/maintenance-types', { code: 'PNEUS', label: 'Permutation des pneus' })).body.id as string;
    const pneusPlan = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: pneus, intervalKm: '20000', noticeKm: '1000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '110000', baseDate: '2026-05-01' } });
    expect(pneusPlan.status).toBe(201);
    const after = await reading(chefA, '500', '2026-09-22T08:00:00Z');
    expect(after.body.reading).toMatchObject({ physicalKm: '500.000', cumulativeKm: '120500.000' });
    // Sur le cumul (120 500) : reste 500 km ≤ préavis → à prévoir ; sur le compteur physique (500) il resterait 120 500 km.
    const view = await chefA.get(`/maintenance-plans/${vidange.id}`);
    expect(view.body).toMatchObject({ status: 'A_PREVOIR', currentKm: '120500', remainingKm: '500', nextDueKm: '121000' });
    const synthesis = await chefA.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesis.status).toBe(200);
    // Prochaines échéances de la synthèse (3.1) : triées par urgence, sur le cumul.
    expect(synthesis.body.upcomingMaintenance).toEqual([
      { planId: vidange.id, maintenanceTypeLabel: 'Vidange moteur', status: 'A_PREVOIR', nextDueKm: '121000.000', nextDueDate: null },
      { planId: pneusPlan.body.id, maintenanceTypeLabel: 'Permutation des pneus', status: 'A_JOUR', nextDueKm: '130000.000', nextDueDate: null },
    ]);
    expect(synthesis.body.odometer).toMatchObject({ physicalKm: '500.000' });
    // 1 200 physiques = 121 200 cumulés : échéance dépassée → en retard.
    await reading(chefA, '1200', '2026-09-23T08:00:00Z');
    expect((await chefA.get(`/maintenance-plans/${vidange.id}`)).body).toMatchObject({ status: 'EN_RETARD', remainingKm: '-200' });
    expect((await dueAlert(vidange.id))?.severity).toBe('CRITIQUE');
  });

  it('R-15.3-04 — POST /vehicles/:id/readings : odometerSegmentId (relevé rétroactif sur l’ancien compteur) et context enregistrés', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-01-01T08:00:00Z', physicalKm: '100000' });
    await reading(chefA, '120000', '2026-09-20T08:00:00Z');
    const proof = await uploadPdf(chefA, t.server, f.companies.A, 'facture.pdf');
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'REPLACEMENT', startedAt: '2026-09-21T08:00:00Z', physicalKm: '0', reason: 'remplacement du bloc compteur', justificationAttachmentId: proof });
    const segments = (await chefA.get(`/vehicles/${vehicleId}/odometer-segments`)).body as Array<{ id: string; sequence: number }>;
    const old = segments.find((s) => s.sequence === 1) as { id: string };
    // Relevé rétroactif (plein du 15 septembre) sur l'ancien compteur, dans sa chronologie.
    const retro = await reading(operateurA, '118000', '2026-09-15T08:00:00Z', { odometerSegmentId: old.id, context: 'CARBURANT', note: 'Ticket retrouvé' });
    expect(retro.status, JSON.stringify(retro.body)).toBe(201);
    expect(retro.body.outcome).toBe('ACCEPTE');
    expect(retro.body.reading).toMatchObject({ segmentId: old.id, segmentSequence: 1, context: 'CARBURANT', physicalKm: '118000.000', cumulativeKm: '118000.000', note: 'Ticket retrouvé', source: 'MANUAL' });
    // Le compteur courant reste celui du nouveau segment (dernier accepté selon l'observation).
    expect((await chefA.get(`/vehicles/${vehicleId}/odometer`)).body.reading.physicalKm).toBe('0.000');
    // Une valeur qui casserait la chronologie de l'ancien compteur est refusée.
    const broken = await reading(operateurA, '121000', '2026-09-16T08:00:00Z', { odometerSegmentId: old.id });
    expect(broken.status).toBe(422);
    // Contexte hors liste (remise/restitution passent par /usages) : 422.
    expect((await reading(operateurA, '10', '2026-09-22T08:00:00Z', { context: 'REMISE' })).status).toBe(422);
  });

  it('R-15.3-05 / R-5.1-05 — aucune route publique n’accepte la source TELEMATICS : auteur, source et société déterminés par le serveur', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: '40000' });
    const forged = await reading(chefA, '40100', '2026-09-20T08:00:00Z', { source: 'TELEMATICS' });
    expect(forged.status).toBe(422);
    expect(Object.keys(forged.body.fieldErrors ?? {})).toContain('source');
    const forgedAuthor = await reading(chefA, '40100', '2026-09-20T08:00:00Z', { createdById: f.users.admin, companyId: f.companies.B });
    expect(forgedAuthor.status).toBe(422);
    const batch = await chefA.post('/readings/batch', { items: [{ vehicleId, physicalKm: '40100', observedAt: '2026-09-20T08:00:00Z', source: 'TELEMATICS' }] }).set('Idempotency-Key', key());
    expect(batch.status).toBe(422);
    await t.prisma.client.driverPermit.create({ data: { organizationId: f.organizationId, driverId: f.drivers.a1, number: 'P-A1', categories: ['B'] } });
    const checkout = await chefA
      .post('/usages/checkout', { vehicleId, driverId: f.drivers.a1, checkedOutAt: '2026-09-24T07:00:00Z', expectedReturnAt: '2026-09-24T18:00:00Z', purpose: 'Mission', reading: { physicalKm: '40100', source: 'TELEMATICS' }, location: { placeLabel: 'Dépôt' } })
      .set('Idempotency-Key', key());
    expect(checkout.status).toBe(422);
    expect(await t.prisma.client.odometerReading.count({ where: { source: 'TELEMATICS' } })).toBe(0);
    // Saisie légitime : source MANUAL, auteur et société (à la date d'observation) fixés par le serveur.
    const ok = await reading(operateurA, '40100', '2026-09-20T08:00:00Z');
    expect(ok.body.reading).toMatchObject({ source: 'MANUAL', companyId: f.companies.A });
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: ok.body.reading.id } })).createdById).toBe(f.users.operateurA);
  });

  it('R-5.2-09 — seuil de plausibilité paramétrable (versionné, audité) : relevé en attente au seuil par défaut, accepté après relèvement du seuil de la société', async () => {
    await chefA.post(`/vehicles/${vehicleId}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-23T08:00:00Z', physicalKm: '40000' });
    // Seuils par défaut : 1 500 km par 24 h, tolérance minimale de 300 km entre relevés rapprochés.
    const within = await reading(chefA, '41400', '2026-09-24T08:00:00Z');
    expect(within.body.outcome).toBe('ACCEPTE');
    const beyond = await reading(chefA, '43000', '2026-09-24T09:00:00Z');
    expect(beyond.body.outcome).toBe('EN_ATTENTE');
    expect(beyond.body.anomaly.code).toBe('HAUSSE_IMPLAUSIBLE');
    // Présenté comme un filtre administratif, pas comme une limite physique (libellés servis par GET /settings).
    const settings = (await chefA.get(`/settings?companyId=${f.companies.A}`)).body as Array<{ key: string; label: string; value: number }>;
    for (const k of ['odometer.plausibilityMaxKmPerDay', 'odometer.plausibilityMinKm']) {
      expect(settings.find((x) => x.key === k)?.label).toContain('filtre administratif, pas une limite physique');
    }
    // Le chef ne modifie pas le seuil ; l'administrateur le relève pour la société A (motif, version, audit).
    expect((await chefA.put('/settings/odometer.plausibilityMinKm', { value: 2000, companyId: f.companies.A, reason: 'Parc routier longue distance' })).status).toBe(403);
    const raised = await admin.put('/settings/odometer.plausibilityMinKm', { value: 2000, companyId: f.companies.A, reason: 'Parc routier longue distance' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'parametre.modification', reason: 'Parc routier longue distance' } });
    expect(JSON.stringify(audit.after)).toContain('2000');
    // Nouvelle saisie d'une hausse comparable : acceptée sous le nouveau seuil (filtre administratif, pas une limite physique).
    expect(((await chefA.get(`/settings?companyId=${f.companies.A}`)).body as Array<{ key: string; value: number; source: string }>).find((x) => x.key === 'odometer.plausibilityMinKm')).toMatchObject({ value: 2000, source: 'societe' });
    const accepted = await reading(chefA, '43100', '2026-09-24T09:30:00Z');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.outcome).toBe('ACCEPTE');
    // Le relevé en attente reste en attente (le seuil ne rejuge pas le passé) et se décide explicitement.
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: beyond.body.reading.id } })).status).toBe('EN_ATTENTE');
  });
});
