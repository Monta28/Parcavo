import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

describe('Transfert de véhicule entre sociétés (CDC 2.4, 11.3 — T26 ; D-119 à D-125)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let vehicleId: string;
  let expenseId: string;
  let initialReadingId: string;

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
    vehicleId = await createVehicle(t.prisma, f, 'A');
    const reading = await chefA.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85000', observedAt: '2026-09-01T08:00:00Z' });
    expect(reading.status, JSON.stringify(reading.body)).toBe(201);
    initialReadingId = reading.body.reading.id as string;
    const expense = await chefA.post('/expenses', { vehicleId, occurredOn: '2026-09-10', category: 'PEAGE', amount: '100.500' }).set('Idempotency-Key', randomUUID());
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);
    expenseId = expense.body.id as string;
  });

  async function version(): Promise<number> {
    return (await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).version;
  }

  async function minimalBody(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return { targetCompanyId: f.companies.B, expectedVersion: await version(), reason: 'Réorganisation du parc', plans: [], siteId: null, departmentId: null, sharedDocumentVersionIds: [], noReadingReason: 'Véhicule déjà au dépôt de la société B', ...extra };
  }

  it('T26 — refus 409 TRANSFERT_BLOQUE avec une intervention ouverte, puis transfert après résolution ; coûts historiques inchangés', async () => {
    const created = await chefA.post('/interventions', { vehicleId, kind: 'CORRECTIF', tasks: [{ label: 'Diagnostic bruit moteur' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const interventionId = created.body.id as string;

    const preview = await admin.get(`/vehicles/${vehicleId}/transfer-preview`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.canTransfer).toBe(false);
    expect(preview.body.blockers).toEqual([expect.objectContaining({ type: 'INTERVENTION_OUVERTE', id: interventionId, status: 'BROUILLON', link: `/interventions/${interventionId}` })]);
    expect(preview.body.targetCompanies.map((c: { id: string }) => c.id).sort()).toEqual([f.companies.B, f.companies.C].sort());

    const refused = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('TRANSFERT_BLOQUE');
    expect(refused.body.details.blockers).toEqual([expect.objectContaining({ type: 'INTERVENTION_OUVERTE', id: interventionId, link: `/interventions/${interventionId}` })]);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.A);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId } })).toBe(0);

    // Résolution explicite : annulation motivée de l'intervention.
    const cancelled = await chefA.post(`/interventions/${interventionId}/cancel`, { reason: 'Doublon', expectedVersion: created.body.version });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body.canTransfer).toBe(true);

    const done = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ fromCompanyId: f.companies.A, toCompanyId: f.companies.B, effectiveAt: NOW, transferReadingId: null });
    expect(done.body.vehicle).toMatchObject({ id: vehicleId, companyId: f.companies.B });

    const history = await t.prisma.client.vehicleCompanyHistory.findFirstOrThrow({ where: { vehicleId } });
    expect(history).toMatchObject({ fromCompanyId: f.companies.A, toCompanyId: f.companies.B, reason: 'Réorganisation du parc', createdById: f.users.admin });
    expect(history.effectiveAt.toISOString()).toBe(NOW);
    expect(history.technicalSnapshot).toMatchObject({ odometer: { distanceAllocation: 'NON_VENTILABLE', noReadingReason: 'Véhicule déjà au dépôt de la société B', lastAcceptedReading: { readingId: initialReadingId, physicalKm: '85000' } } });

    // Événements et dépenses gardent leur société historique (aucune réimputation).
    const expense = await t.prisma.client.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.companyId).toBe(f.companies.A);
    expect(expense.amount.toString()).toBe('100.5');
    expect((await t.prisma.client.intervention.findUniqueOrThrow({ where: { id: interventionId } })).companyId).toBe(f.companies.A);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: initialReadingId } })).companyId).toBe(f.companies.A);
    expect((await chefA.get(`/expenses/${expenseId}`)).status).toBe(200);
    expect((await chefB.get(`/expenses/${expenseId}`)).status).toBe(404);

    // Visibilité : le chef d'origine ne voit plus le véhicule, le chef de la cible le voit.
    expect((await chefA.get(`/vehicles/${vehicleId}`)).status).toBe(404);
    const seenByB = await chefB.get(`/vehicles/${vehicleId}`);
    expect(seenByB.status).toBe(200);
    expect(seenByB.body.companyId).toBe(f.companies.B);
    expect((await chefA.get('/vehicles')).body.items.map((v: { id: string }) => v.id)).not.toContain(vehicleId);
    expect((await chefB.get('/vehicles')).body.items.map((v: { id: string }) => v.id)).toContain(vehicleId);

    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'vehicule.transfert', objectId: vehicleId } });
    expect(audit).toMatchObject({ actorUserId: f.users.admin, companyId: f.companies.A, reason: 'Réorganisation du parc' });
    expect(audit.after).toMatchObject({ companyId: f.companies.B, historyId: history.id });
  });

  it('bloque aussi une utilisation, une immobilisation et une réservation future ; l’incident ouvert n’est qu’un avertissement', async () => {
    const reservation = await t.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a1, startAt: new Date('2026-09-30T08:00:00Z'), endAt: new Date('2026-09-30T18:00:00Z'), purpose: 'Mission' } });
    const past = await t.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, driverId: f.drivers.a2, startAt: new Date('2026-09-20T08:00:00Z'), endAt: new Date('2026-09-20T18:00:00Z'), purpose: 'Mission passée' } });
    const incident = await chefA.post('/incidents', { vehicleId, type: 'DOMMAGE', description: 'Rétroviseur arraché sur parking' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const preview = (await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body;
    expect(preview.blockers).toEqual([expect.objectContaining({ type: 'RESERVATION_A_TRAITER', id: reservation.id, link: `/planning?reservation=${reservation.id}` })]);
    expect(preview.blockers.map((b: { id: string }) => b.id)).not.toContain(past.id);
    expect(preview.warnings).toEqual([expect.objectContaining({ type: 'INCIDENT_OUVERT', id: incident.body.id, link: `/incidents/${incident.body.id}` })]);
    const refused = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ acknowledgeWarnings: true })).set('Idempotency-Key', randomUUID());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TRANSFERT_BLOQUE');
  });

  it('réservé à l’administrateur : 403 pour le chef ou l’opérateur de la société, 404 hors périmètre', async () => {
    expect((await chefA.get(`/vehicles/${vehicleId}/transfer-preview`)).status).toBe(403);
    expect((await operateurA.get(`/vehicles/${vehicleId}/transfer-preview`)).status).toBe(403);
    const byChef = await chefA.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID());
    expect(byChef.status).toBe(403);
    expect(byChef.body.code).toBe('ACTION_INTERDITE');
    expect((await chefB.get(`/vehicles/${vehicleId}/transfer-preview`)).status).toBe(404);
    expect((await chefB.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID())).status).toBe(404);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.A);
    // La société n'est jamais modifiable par PATCH.
    const patch = await admin.patch(`/vehicles/${vehicleId}`, { companyId: f.companies.B, expectedVersion: await version() });
    expect(patch.status).toBe(422);
  });

  it('idempotent (même clé et même corps : même résultat ; corps différent : 409) et versionné', async () => {
    const stale = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ expectedVersion: 99 })).set('Idempotency-Key', randomUUID());
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_OBSOLETE');

    const key = randomUUID();
    const body = await minimalBody();
    const first = await admin.post(`/vehicles/${vehicleId}/transfer`, body).set('Idempotency-Key', key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    t.clock.advance(60_000);
    const replay = await admin.post(`/vehicles/${vehicleId}/transfer`, body).set('Idempotency-Key', key);
    expect(replay.status).toBe(200);
    expect(replay.body.historyId).toBe(first.body.historyId);
    expect(replay.body.effectiveAt).toBe(NOW);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId } })).toBe(1);
    const other = await admin.post(`/vehicles/${vehicleId}/transfer`, { ...body, targetCompanyId: f.companies.C }).set('Idempotency-Key', key);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCE_CORPS_DIFFERENT');
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.B);
    const missingKey = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ targetCompanyId: f.companies.C }));
    expect(missingKey.status).toBe(422);
    expect(missingKey.body.code).toBe('IDEMPOTENCE_CLE_REQUISE');
  });

  it('deux transferts concurrents : verrou du véhicule, un seul aboutit (l’autre reçoit 409)', async () => {
    const body = await minimalBody();
    const [a, b] = await Promise.all([
      admin.post(`/vehicles/${vehicleId}/transfer`, body).set('Idempotency-Key', randomUUID()),
      admin.post(`/vehicles/${vehicleId}/transfer`, { ...body, targetCompanyId: f.companies.C }).set('Idempotency-Key', randomUUID()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId } })).toBe(1);
    const winner = a.status === 200 ? a.body : b.body;
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(winner.toCompanyId);
  });

  it('relevé de transfert (contexte TRANSFERT, société d’origine) et décisions explicites : affectation, plans, site, service, documents, alertes', async () => {
    // Affectation habituelle en cours (conducteur de A).
    const assignment = await chefA.post('/responsible-assignments', { vehicleId, driverId: f.drivers.a1, startsAt: '2026-09-01T00:00:00Z' });
    expect(assignment.status, JSON.stringify(assignment.body)).toBe(201);
    // Deux plans : vidange en retard (alerte active dans A) conservée, batterie désactivée.
    const vidangeType = (await admin.post('/maintenance-types', { code: 'VIDANGE', label: 'Vidange moteur' })).body.id as string;
    const batterieType = (await admin.post('/maintenance-types', { code: 'BATTERIE', label: 'Batterie' })).body.id as string;
    const vidange = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: vidangeType, intervalMonths: 6, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2026-01-10' } });
    const batterie = await chefA.post('/maintenance-plans', { vehicleId, maintenanceTypeId: batterieType, intervalMonths: 48, base: { baseMode: 'DERNIERE_OPERATION', baseDate: '2024-01-15' } });
    expect(vidange.status, JSON.stringify(vidange.body)).toBe(201);
    expect(batterie.status, JSON.stringify(batterie.body)).toBe(201);
    expect(await t.prisma.client.alert.count({ where: { objectId: vidange.body.id, companyId: f.companies.A, status: 'ACTIVE' } })).toBe(1);
    // Documents : une version expirée, une version valable.
    const typeId = (await admin.post('/document-types', { code: 'ASSURANCE', label: 'Assurance', ownerType: 'VEHICULE', hasExpiry: true, required: false, blocksCheckout: false })).body.id as string;
    const expired = await chefA.post('/documents', { documentTypeId: typeId, vehicleId, number: 'POL-0', validFrom: '2025-09-01', validTo: '2026-09-01' });
    const valid = await chefA.post('/documents', { documentTypeId: typeId, vehicleId, number: 'POL-1', validFrom: '2026-09-02', validTo: '2027-09-01' });
    expect(valid.status, JSON.stringify(valid.body)).toBe(201);
    // Site et service de la société cible.
    const siteB = (await admin.post('/sites', { companyId: f.companies.B, name: 'Dépôt B' })).body.id as string;
    const siteA = (await admin.post('/sites', { companyId: f.companies.A, name: 'Dépôt A' })).body.id as string;
    const departmentB = (await admin.post('/departments', { companyId: f.companies.B, name: 'Logistique' })).body.id as string;
    // Relevé conducteur en attente : avertissement à acquitter.
    const pending = await t.prisma.client.odometerReading.create({
      data: { organizationId: f.organizationId, companyId: f.companies.A, vehicleId, segmentId: (await t.prisma.client.odometerSegment.findFirstOrThrow({ where: { vehicleId } })).id, source: 'MANUAL', context: 'RELEVE_LIBRE', measurementKind: 'COMPTEUR_AFFICHE', status: 'EN_ATTENTE', physicalKm: '85500', cumulativeKm: '85500', observedAt: new Date('2026-09-20T08:00:00Z'), enteredAt: new Date('2026-09-20T08:00:00Z'), anomalyCode: 'SOUMISSION_CONDUCTEUR', statusReason: 'Soumission conducteur.' },
    });

    const preview = (await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body;
    expect(preview.canTransfer).toBe(true);
    expect(preview.warnings).toEqual([expect.objectContaining({ type: 'RELEVE_EN_ATTENTE', id: pending.id })]);
    expect(preview.assignments).toEqual([expect.objectContaining({ id: assignment.body.id, driverId: f.drivers.a1, isCurrent: true })]);
    expect(preview.plans.map((p: { id: string }) => p.id).sort()).toEqual([vidange.body.id, batterie.body.id].sort());
    const docs = new Map(preview.documents.map((d: { id: string; suggested: boolean }) => [d.id, d.suggested]));
    expect(docs.get(expired.body.id)).toBe(false);
    expect(docs.get(valid.body.id)).toBe(true);

    const full = {
      assignment: { closeCurrent: true, newResponsibleDriverId: f.drivers.b1 },
      plans: [
        { planId: vidange.body.id, decision: 'KEEP', responsibleUserId: f.users.chefB },
        { planId: batterie.body.id, decision: 'DEACTIVATE' },
      ],
      siteId: siteB,
      departmentId: departmentB,
      sharedDocumentVersionIds: [valid.body.id],
      transferReading: { physicalKm: '86000' },
      noReadingReason: undefined,
      acknowledgeWarnings: true,
    };

    // Décisions incomplètes : 422 avec erreurs par champ, rien n'est écrit.
    const incomplete = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ ...full, plans: [full.plans[0]], acknowledgeWarnings: undefined, assignment: undefined })).set('Idempotency-Key', randomUUID());
    expect(incomplete.status, JSON.stringify(incomplete.body)).toBe(422);
    expect(incomplete.body.code).toBe('DECISIONS_TRANSFERT');
    expect(Object.keys(incomplete.body.fieldErrors).sort()).toEqual(['acknowledgeWarnings', 'assignment.closeCurrent', 'plans']);
    const explicitNull = await admin.post(`/vehicles/${vehicleId}/transfer`, { ...(await minimalBody(full)), siteId: undefined }).set('Idempotency-Key', randomUUID());
    expect(explicitNull.status).toBe(422);
    expect(explicitNull.body.fieldErrors).toHaveProperty('siteId');
    // Références hors société cible : 422 « référence invalide ».
    const wrongRefs = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ ...full, siteId: siteA, plans: [{ ...full.plans[0], responsibleUserId: f.users.chefA }, full.plans[1]] })).set('Idempotency-Key', randomUUID());
    expect(wrongRefs.status, JSON.stringify(wrongRefs.body)).toBe(422);
    expect(wrongRefs.body.code).toBe('REFERENCE_INVALIDE');
    expect(Object.keys(wrongRefs.body.fieldErrors).sort()).toEqual(['plans.0.responsibleUserId', 'siteId']);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, context: 'TRANSFERT' } })).toBe(0);

    const done = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody(full)).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ closedAssignmentIds: [assignment.body.id], keptPlanIds: [vidange.body.id], deactivatedPlanIds: [batterie.body.id], sharedDocumentVersionIds: [valid.body.id] });

    // Relevé de transfert : service unique d'ingestion, observé à l'instant du transfert, société d'origine.
    const transferReading = await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: done.body.transferReadingId } });
    expect(transferReading).toMatchObject({ context: 'TRANSFERT', status: 'ACCEPTE', companyId: f.companies.A, source: 'MANUAL', createdById: f.users.admin });
    expect(transferReading.observedAt.toISOString()).toBe(NOW);
    expect(transferReading.physicalKm?.toString()).toBe('86000');
    const history = await t.prisma.client.vehicleCompanyHistory.findFirstOrThrow({ where: { vehicleId } });
    expect(history).toMatchObject({ transferReadingId: transferReading.id, sharedDocumentIds: [valid.body.id] });
    expect(history.technicalSnapshot).toMatchObject({ odometer: { distanceAllocation: 'BORNEE_PAR_RELEVE_DE_TRANSFERT', transferReadingId: transferReading.id }, acknowledgedWarnings: [{ type: 'RELEVE_EN_ATTENTE', id: pending.id }] });
    // Un relevé ultérieur de la société cible lui est rattaché.
    t.clock.advance(3_600_000);
    const later = await chefB.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '86100', observedAt: '2026-09-24T10:30:00Z' });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: later.body.reading.id } })).companyId).toBe(f.companies.B);

    // Affectation clôturée à l'instant du transfert ; nouveau responsable de la société cible.
    const closed = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: assignment.body.id } });
    expect(closed.endsAt?.toISOString()).toBe(NOW);
    expect(closed.companyId).toBe(f.companies.A);
    const created = await t.prisma.client.vehicleResponsibleAssignment.findUniqueOrThrow({ where: { id: done.body.newAssignmentId } });
    expect(created).toMatchObject({ companyId: f.companies.B, driverId: f.drivers.b1, endsAt: null });
    expect(created.startsAt.toISOString()).toBe(NOW);
    // Plans : conservé pour B avec son nouveau responsable, ou désactivé (reste à A).
    expect(await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: vidange.body.id } })).toMatchObject({ companyId: f.companies.B, responsibleUserId: f.users.chefB, active: true });
    expect(await t.prisma.client.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: batterie.body.id } })).toMatchObject({ companyId: f.companies.A, active: false });
    // Site et service de la cible.
    expect(await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).toMatchObject({ companyId: f.companies.B, siteId: siteB, departmentId: departmentB });
    // Alertes : celle de A résolue (motif transfert), recalculée pour B ; le relevé en attente garde la sienne.
    const alertA = await t.prisma.client.alert.findFirstOrThrow({ where: { objectId: vidange.body.id, companyId: f.companies.A } });
    expect(alertA.status).toBe('RESOLUE');
    expect(alertA.resolutionReason).toContain('transfert');
    expect(await t.prisma.client.alert.count({ where: { objectId: vidange.body.id, companyId: f.companies.B, status: 'ACTIVE' } })).toBe(1);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: pending.id } })).companyId).toBe(f.companies.A);
    // Documents : la cible voit la version partagée, pas l'ancienne ; la version garde sa société historique.
    const sharedDoc = await t.prisma.client.documentVersion.findUniqueOrThrow({ where: { id: valid.body.id } });
    expect(sharedDoc).toMatchObject({ companyId: f.companies.A, sharedWithCompanyIds: [f.companies.B] });
    const listB = await chefB.get(`/documents?vehicleId=${vehicleId}`);
    expect(listB.status).toBe(200);
    expect(listB.body.items.map((d: { id: string }) => d.id)).toEqual([valid.body.id]);
    expect((await chefB.get(`/documents/${expired.body.id}`)).status).toBe(404);
    expect((await chefB.get(`/documents/${valid.body.id}`)).status).toBe(200);
    // La synthèse de la cible ne voit plus le chef A ; le chef A ne voit plus le véhicule.
    expect((await chefA.get(`/vehicles/${vehicleId}/synthesis`)).status).toBe(404);
    expect((await chefB.get(`/vehicles/${vehicleId}/synthesis`)).body.responsible).toMatchObject({ driverId: f.drivers.b1 });
  });

  it('mapping télématique : clôturé à la date du transfert, proposé à la société cible couverte et activée (D-124)', async () => {
    await t.prisma.client.company.update({ where: { id: f.companies.B }, data: { telemetryEnabled: true } });
    const provider = await t.prisma.client.telemetryProvider.create({ data: { organizationId: f.organizationId, name: 'Fournisseur GPS', kind: 'TRACCAR', channel: 'API', status: 'ACTIF' } });
    await t.prisma.client.telemetryProviderCompany.createMany({ data: [f.companies.A, f.companies.B].map((companyId) => ({ providerId: provider.id, companyId, organizationId: f.organizationId })) });
    const unit = await t.prisma.client.telemetryUnit.create({ data: { organizationId: f.organizationId, providerId: provider.id, externalId: 'U-1', label: 'Boîtier 1', firstSeenAt: new Date('2026-09-01T00:00:00Z'), lastSeenAt: new Date(NOW) } });
    const mapping = await t.prisma.client.telemetryVehicleMapping.create({ data: { organizationId: f.organizationId, companyId: f.companies.A, providerId: provider.id, unitId: unit.id, vehicleId, status: 'CONFIRME', odometerKind: 'COMPTEUR_CAN', validFrom: new Date('2026-09-01T00:00:00Z'), proposedAt: new Date('2026-09-01T00:00:00Z') } });
    const preview = (await admin.get(`/vehicles/${vehicleId}/transfer-preview`)).body;
    expect(preview.telemetryMappings).toEqual([expect.objectContaining({ id: mapping.id, status: 'CONFIRME', providerName: 'Fournisseur GPS', unitLabel: 'Boîtier 1' })]);
    const done = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.closedTelemetryMappingIds).toEqual([mapping.id]);
    const closed = await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: mapping.id } });
    expect(closed).toMatchObject({ status: 'CLOTURE', companyId: f.companies.A });
    expect(closed.validTo?.toISOString()).toBe(NOW);
    const proposed = await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: done.body.proposedTelemetryMappingIds[0] } });
    expect(proposed).toMatchObject({ status: 'PROPOSE', companyId: f.companies.B, unitId: unit.id, vehicleId, odometerKind: 'COMPTEUR_CAN', validTo: null });
  });

  it('refuse un relevé de transfert incohérent (contrôle du service unique) sans rien écrire', async () => {
    const res = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ transferReading: { physicalKm: '84000' }, noReadingReason: undefined })).set('Idempotency-Key', randomUUID());
    // Diminution du compteur refusée par le service unique d'ingestion, erreur rapportée sur le champ du relevé de transfert.
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('DIMINUTION');
    expect(Object.keys(res.body.fieldErrors)).toEqual(['transferReading.physicalKm']);
    // Hausse implausible : le service unique mettrait le relevé EN_ATTENTE ; le transfert est refusé et rien n'est conservé.
    const implausible = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ transferReading: { physicalKm: '985000' }, noReadingReason: undefined })).set('Idempotency-Key', randomUUID());
    expect(implausible.status, JSON.stringify(implausible.body)).toBe(422);
    expect(implausible.body.code).toBe('RELEVE_TRANSFERT_EN_ATTENTE');
    expect(Object.keys(implausible.body.fieldErrors)).toEqual(['transferReading.physicalKm']);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, status: 'EN_ATTENTE' } })).toBe(0);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).companyId).toBe(f.companies.A);
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, context: 'TRANSFERT' } })).toBe(0);
    expect(await t.prisma.client.vehicleCompanyHistory.count({ where: { vehicleId } })).toBe(0);
  });

  it('événements datés après le transfert : un relevé rétroactif appartient à la société d’origine ; la cible ne peut pas écrire dans son historique (D-121)', async () => {
    const done = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody()).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // Saisie rétroactive par l'administrateur (observée avant le transfert) : société d'origine, pas la société courante.
    const retro = await admin.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85300', observedAt: '2026-09-15T08:00:00Z' });
    expect(retro.status, JSON.stringify(retro.body)).toBe(201);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: retro.body.reading.id } })).companyId).toBe(f.companies.A);
    expect((await chefB.get(`/readings?vehicleId=${vehicleId}`)).body.items.map((r: { id: string }) => r.id)).not.toContain(retro.body.reading.id);

    // Le chef de la société cible ne peut pas écrire dans la période de la société d'origine : 422, rien n'est écrit.
    const byB = await chefB.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85400', observedAt: '2026-09-18T08:00:00Z' });
    expect(byB.status, JSON.stringify(byB.body)).toBe(422);
    expect(byB.body.code).toBe('PERIODE_HORS_PERIMETRE');
    expect(await t.prisma.client.odometerReading.count({ where: { vehicleId, physicalKm: '85400' } })).toBe(0);

    // Après l'instant du transfert : société cible.
    t.clock.advance(3_600_000);
    const later = await chefB.post(`/vehicles/${vehicleId}/readings`, { physicalKm: '85600', observedAt: '2026-09-24T10:30:00Z' });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect((await t.prisma.client.odometerReading.findUniqueOrThrow({ where: { id: later.body.reading.id } })).companyId).toBe(f.companies.B);
  });

  it('après le transfert : localisations, alertes et fournisseur de contrat restent à la société d’origine (aucune fuite ni référence croisée)', async () => {
    const declared = await chefA.post(`/vehicles/${vehicleId}/location-reports`, { placeLabel: 'Parking du siège A', observedAt: '2026-09-20T08:00:00Z', comment: 'Clés remises à l’accueil par Karim' });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    const incident = await chefA.post('/incidents', { vehicleId, type: 'ACCIDENT', severity: 'CRITIQUE', description: 'Choc avant, véhicule roulant' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const incidentAlert = await t.prisma.client.alert.findFirstOrThrow({ where: { objectType: 'Incident', objectId: incident.body.id, status: 'ACTIVE' } });
    expect(incidentAlert.companyId).toBe(f.companies.A);
    const supplier = await admin.post('/suppliers', { companyId: f.companies.A, name: 'Loueur de la société A', category: 'LOUEUR' });
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    const patched = await admin.patch(`/vehicles/${vehicleId}`, { contractSupplierId: supplier.body.id, expectedVersion: await version() });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const done = await admin.post(`/vehicles/${vehicleId}/transfer`, await minimalBody({ acknowledgeWarnings: true })).set('Idempotency-Key', randomUUID());
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // Fournisseur de contrat de la société d'origine : retiré de la fiche, valeur figée dans l'historique.
    expect(done.body.clearedContractSupplierId).toBe(supplier.body.id);
    expect((await t.prisma.client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).contractSupplierId).toBeNull();
    const history = await t.prisma.client.vehicleCompanyHistory.findFirstOrThrow({ where: { vehicleId } });
    expect(history.technicalSnapshot).toMatchObject({ contract: { previousContractSupplierId: supplier.body.id, contractSupplierCleared: true } });

    // L'alerte de l'incident ouvert (événement daté conservé) reste active dans la société d'origine.
    expect(await t.prisma.client.alert.findUniqueOrThrow({ where: { id: incidentAlert.id } })).toMatchObject({ status: 'ACTIVE', companyId: f.companies.A });

    // Localisations : la cible ne voit ni l'historique ni l'auteur de la société d'origine (D-123).
    const listB = await chefB.get(`/vehicles/${vehicleId}/location-reports`);
    expect(listB.status).toBe(200);
    expect(listB.body.items).toEqual([]);
    expect(listB.body.total).toBe(0);
    const synthesisB = await chefB.get(`/vehicles/${vehicleId}/synthesis`);
    expect(synthesisB.status).toBe(200);
    expect(synthesisB.body.lastLocation).toMatchObject({ placeLabel: 'Parking du siège A', createdById: null, createdByName: null, comment: null });
    const listAdmin = await admin.get(`/vehicles/${vehicleId}/location-reports`);
    expect(listAdmin.body.items).toEqual([expect.objectContaining({ id: declared.body.id, createdById: f.users.chefA, comment: 'Clés remises à l’accueil par Karim' })]);
  });
});
