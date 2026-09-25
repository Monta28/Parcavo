import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isConstraintViolation } from '../../src/infra/prisma.service.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T10:00:00.000Z';

/**
 * Associations unité ↔ véhicule sans chevauchement (CDC 14.5 ; R-14.5-X01) : contraintes d'exclusion SQL
 * telemetry_mapping_no_overlap_unit / _vehicle sur [validFrom, validTo[ des associations CONFIRME et CLOTURE,
 * vérifiées par de vraies transactions concurrentes (la seconde attend la première puis échoue), et refus 409
 * par l'API d'une date d'effet qui chevaucherait une association précédente.
 */
describe('Connecteur télématique — associations sans chevauchement (R-14.5-X01)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;

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
    const enabled = await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11' });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  });

  /** Fournisseur SIMULATEUR actif de la société A, unités découvertes ; renvoie leurs identifiants par externalId. */
  async function simulatorUnits(externalIds: string[]): Promise<{ providerId: string; units: Record<string, string> }> {
    const created = await admin.post('/telemetry/providers', {
      name: 'Simulateur chevauchement',
      kind: 'SIMULATEUR',
      settings: { scenario: { units: externalIds.map((externalId) => ({ externalId, label: `Boîtier ${externalId}`, declaredRegistration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] })) } },
      companyIds: [f.companies.A],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect((await admin.post(`/telemetry/providers/${created.body.id}/discover`)).status).toBe(200);
    const rows = await t.prisma.client.telemetryUnit.findMany({ where: { providerId: created.body.id } });
    return { providerId: created.body.id as string, units: Object.fromEntries(rows.map((u) => [u.externalId, u.id])) };
  }

  function mappingRow(providerId: string, unitId: string, vehicleId: string, status: 'CONFIRME' | 'CLOTURE' | 'PROPOSE', validFrom: string | null, validTo: string | null) {
    return {
      organizationId: f.organizationId,
      companyId: f.companies.A,
      providerId,
      unitId,
      vehicleId,
      status,
      odometerKind: 'COMPTEUR_CAN' as const,
      validFrom: validFrom ? new Date(validFrom) : null,
      validTo: validTo ? new Date(validTo) : null,
      proposedAt: new Date('2026-09-01T00:00:00Z'),
    };
  }

  /** Paires d'associations CONFIRME/CLOTURE qui se chevauchent (même unité ou même véhicule) : doit rester vide. */
  async function overlaps(): Promise<number> {
    const [row] = await t.prisma.client.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "TelemetryVehicleMapping" a JOIN "TelemetryVehicleMapping" b ON a.id < b.id
      WHERE a.status IN ('CONFIRME', 'CLOTURE') AND b.status IN ('CONFIRME', 'CLOTURE')
        AND (a."unitId" = b."unitId" OR a."vehicleId" = b."vehicleId")
        AND tstzrange(a."validFrom", a."validTo", '[)') && tstzrange(b."validFrom", b."validTo", '[)')`;
    return row?.n ?? -1;
  }

  /** Attend qu'une session PostgreSQL de cette base soit bloquée sur un verrou (transaction concurrente en attente). */
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await t.prisma.client.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if ((row?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Aucune transaction en attente de verrou : la concurrence n’a pas été reproduite.');
  }

  /**
   * Deux transactions réelles : la première insère puis reste ouverte ; la seconde insère une période qui
   * chevauche et se bloque sur la contrainte d'exclusion ; à la validation de la première, la seconde échoue.
   */
  async function concurrentInserts(first: ReturnType<typeof mappingRow>, second: ReturnType<typeof mappingRow>): Promise<unknown> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (signalInserted = resolve));
    const tx1 = t.prisma.client.$transaction(
      async (tx) => {
        await tx.telemetryVehicleMapping.create({ data: first });
        signalInserted();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inserted;
    const tx2 = t.prisma.client
      .$transaction(
        async (tx) => {
          await tx.telemetryVehicleMapping.create({ data: second });
        },
        { timeout: 30_000, maxWait: 10_000 },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    await waitForLockWaiter();
    release();
    await tx1;
    return tx2;
  }

  it('contraintes d’exclusion : une unité ou un véhicule jamais associé deux fois sur une même période, y compris entre deux transactions concurrentes réelles', async () => {
    const { providerId, units } = await simulatorUnits(['U-1', 'U-2', 'U-3']);
    const [v1, v2, v3] = [await createVehicle(t.prisma, f, 'A'), await createVehicle(t.prisma, f, 'A'), await createVehicle(t.prisma, f, 'A')];
    const u1 = units['U-1'] as string;
    const u2 = units['U-2'] as string;
    const u3 = units['U-3'] as string;

    // Même unité sur deux véhicules, périodes clôturées qui se recoupent : la seconde transaction attend la
    // première, puis échoue sur telemetry_mapping_no_overlap_unit.
    const unitConflict = await concurrentInserts(mappingRow(providerId, u1, v1, 'CLOTURE', '2026-09-10T00:00:00Z', '2026-09-15T00:00:00Z'), mappingRow(providerId, u1, v2, 'CLOTURE', '2026-09-14T00:00:00Z', '2026-09-18T00:00:00Z'));
    expect(isConstraintViolation(unitConflict, 'telemetry_mapping_no_overlap_unit'), String(unitConflict)).toBe(true);
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { unitId: u1 } })).toBe(1);

    // Même véhicule, deux unités : une clôturée, une en cours qui commence avant la fin de la première.
    const vehicleConflict = await concurrentInserts(mappingRow(providerId, u2, v3, 'CLOTURE', '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z'), mappingRow(providerId, u3, v3, 'CONFIRME', '2026-09-19T00:00:00Z', null));
    expect(isConstraintViolation(vehicleConflict, 'telemetry_mapping_no_overlap_vehicle'), String(vehicleConflict)).toBe(true);
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { vehicleId: v3 } })).toBe(1);

    // Périodes consécutives (fin = début, changement de boîtier) admises, comme une période vide (clôture à
    // l'instant de la confirmation) ; une proposition ne réserve aucune période.
    await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u1, v2, 'CLOTURE', '2026-09-15T00:00:00Z', '2026-09-18T00:00:00Z') });
    await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u3, v3, 'CONFIRME', '2026-09-20T00:00:00Z', null) });
    await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u2, v1, 'CLOTURE', '2026-09-16T00:00:00Z', '2026-09-16T00:00:00Z') });
    await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u2, v3, 'PROPOSE', null, null) });

    // Invariants de période : date d'effet obligatoire pour une association confirmée ; fin jamais avant le début.
    const noStart = await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u2, v2, 'CONFIRME', null, null) }).catch((e: unknown) => e);
    expect(isConstraintViolation(noStart, 'telemetry_mapping_period_valid'), String(noStart)).toBe(true);
    const reversed = await t.prisma.client.telemetryVehicleMapping.create({ data: mappingRow(providerId, u2, v2, 'CLOTURE', '2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z') }).catch((e: unknown) => e);
    expect(isConstraintViolation(reversed, 'telemetry_mapping_period_valid'), String(reversed)).toBe(true);
    // Prolonger une période clôturée sur la suivante est refusé par la base.
    const closedU1 = await t.prisma.client.telemetryVehicleMapping.findFirstOrThrow({ where: { unitId: u1, vehicleId: v1 } });
    const extended = await t.prisma.client.telemetryVehicleMapping.update({ where: { id: closedU1.id }, data: { validTo: new Date('2026-09-16T00:00:00Z') } }).catch((e: unknown) => e);
    expect(isConstraintViolation(extended, 'telemetry_mapping_no_overlap_unit'), String(extended)).toBe(true);
    expect(await overlaps()).toBe(0);
  });

  it('API : date d’effet chevauchant l’association précédente de l’unité ou du véhicule → 409 ; associations concurrentes du même boîtier → une seule réussit', async () => {
    const { providerId, units } = await simulatorUnits(['B-1', 'B-2', 'B-3', 'B-4', 'B-5']);
    const [v1, v2, v3, v4, v5] = [
      await createVehicle(t.prisma, f, 'A', { code: 'V-OV-1' }),
      await createVehicle(t.prisma, f, 'A', { code: 'V-OV-2' }),
      await createVehicle(t.prisma, f, 'A', { code: 'V-OV-3' }),
      await createVehicle(t.prisma, f, 'A', { code: 'V-OV-4' }),
      await createVehicle(t.prisma, f, 'A', { code: 'V-OV-5' }),
    ];
    // B-1 posé sur V1 le 20/09, déposé le 23/09 à 08:00.
    const first = await chefA.post('/telemetry/mappings', { unitId: units['B-1'], vehicleId: v1, odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-20T08:00:00Z' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const closed = await chefA.post(`/telemetry/mappings/${first.body.id}/close`, { reason: 'Boîtier déposé', closedAt: '2026-09-23T08:00:00Z', expectedVersion: first.body.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    // Reposé sur V2 avec une date d'effet antérieure à sa dépose : conflit (409), aucune association créée.
    const overlapUnit = await chefA.post('/telemetry/mappings', { unitId: units['B-1'], vehicleId: v2, odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-22T08:00:00Z' });
    expect(overlapUnit.status, JSON.stringify(overlapUnit.body)).toBe(409);
    expect(overlapUnit.body).toMatchObject({ code: 'PERIODE_UNITE_CHEVAUCHEMENT', details: { minimum: '2026-09-23T08:00:00.000Z' } });
    const moved = await chefA.post('/telemetry/mappings', { unitId: units['B-1'], vehicleId: v2, odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-23T08:00:00Z' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body).toMatchObject({ status: 'CONFIRME', validFrom: '2026-09-23T08:00:00.000Z', validTo: null });

    // V1, désormais sans unité, reçoit B-2 : pas avant la fin de sa précédente association.
    const overlapVehicle = await chefA.post('/telemetry/mappings', { unitId: units['B-2'], vehicleId: v1, odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-21T00:00:00Z' });
    expect(overlapVehicle.status, JSON.stringify(overlapVehicle.body)).toBe(409);
    expect(overlapVehicle.body.code).toBe('PERIODE_VEHICULE_CHEVAUCHEMENT');
    // Proposition existante confirmée avec une date chevauchante : même refus (confirmation d'un mapping conflictuel).
    const proposal = await t.prisma.client.telemetryVehicleMapping.create({ data: { ...mappingRow(providerId, units['B-2'] as string, v1, 'PROPOSE', null, null), proposedAt: new Date(NOW) } });
    const confirmOverlap = await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], validFrom: '2026-09-22T00:00:00Z', expectedVersion: proposal.version });
    expect(confirmOverlap.status, JSON.stringify(confirmOverlap.body)).toBe(409);
    expect(confirmOverlap.body.code).toBe('PERIODE_VEHICULE_CHEVAUCHEMENT');
    expect((await t.prisma.client.telemetryVehicleMapping.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('PROPOSE');
    const confirmed = await chefA.post(`/telemetry/mappings/${proposal.id}/confirm`, { odometerKind: 'COMPTEUR_CAN', fuelKinds: [], expectedVersion: proposal.version });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.validFrom).toBe('2026-09-23T08:00:00.000Z');

    // Deux chefs associent au même instant le même boîtier à deux véhicules : une seule association.
    const [a, b] = await Promise.all([
      chefA.post('/telemetry/mappings', { unitId: units['B-3'], vehicleId: v3, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] }),
      chefA.post('/telemetry/mappings', { unitId: units['B-3'], vehicleId: v4, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe('UNITE_DEJA_ASSOCIEE');
    // Et deux boîtiers posés au même instant sur le même véhicule : un seul.
    const [c, d] = await Promise.all([
      chefA.post('/telemetry/mappings', { unitId: units['B-4'], vehicleId: v5, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] }),
      chefA.post('/telemetry/mappings', { unitId: units['B-5'], vehicleId: v5, odometerKind: 'COMPTEUR_CAN', fuelKinds: [] }),
    ]);
    expect([c.status, d.status].sort()).toEqual([201, 409]);
    expect([c, d].find((r) => r.status === 409)?.body.code).toBe('VEHICULE_DEJA_EQUIPE');
    expect(await t.prisma.client.telemetryVehicleMapping.count({ where: { vehicleId: v5, status: 'CONFIRME' } })).toBe(1);
    expect(await overlaps()).toBe(0);
  });
});
