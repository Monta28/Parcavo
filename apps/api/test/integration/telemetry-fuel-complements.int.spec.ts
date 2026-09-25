import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelemetrySyncService } from '../../src/modules/telemetry/sync/telemetry-sync.service.js';
import { webhookSignatureHeader } from '../../src/modules/telemetry/webhook/telemetry-webhook-signature.js';
import { DEFAULT_PASSWORD, createVehicle, seedFixture, type Fixture } from '../support/factories.js';
import { login, resetDatabase, startTestApp, type Agent, type TestApp } from '../support/test-app.js';

const NOW = '2026-09-24T07:00:00.000Z';
const DAY = '2026-09-24';

type FuelKind = 'NIVEAU_SONDE' | 'NIVEAU_CAN' | 'CONSOMMATION_CAN';

interface Sample {
  unitExternalId: string;
  kind: FuelKind;
  liters: string;
  engineOn: boolean;
  speedKmh: string;
  observedAt: string;
}

function at(hhmm: string): string {
  return `${DAY}T${hhmm}:00Z`;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Journée type d'un véhicule équipé d'une sonde, un échantillon toutes les 5 min de 07:50 à 18:25 :
 * plein A de 40 L à 08:00 (20 → 60 L), 0,5 L consommé par tranche de 5 min en roulant, plein partiel de 20 L
 * à 13:00 (31,5 → 51,5 L), plein B de 30 L à 18:00 (23 → 53 L). Consommation réelle selon la sonde : 57 L.
 */
function probeDay(unit: string, options: { kind?: FuelKind; skip?: [string, string] } = {}): Sample[] {
  const kind = options.kind ?? 'NIVEAU_SONDE';
  const out: Sample[] = [];
  for (let t = minutes('07:50'); t <= minutes('18:25'); t += 5) {
    const time = hhmm(t);
    if (options.skip && t > minutes(options.skip[0]) && t < minutes(options.skip[1])) continue;
    let level: number;
    let driving = false;
    if (t < minutes('08:00')) level = 20;
    else if (t === minutes('08:00')) level = 40;
    else if (t === minutes('08:05')) level = 60;
    else if (t <= minutes('12:50')) {
      level = 60 - 0.5 * ((t - minutes('08:05')) / 5);
      driving = true;
    } else if (t === minutes('12:55')) level = 31.5;
    else if (t === minutes('13:00')) level = 41.5;
    else if (t === minutes('13:05')) level = 51.5;
    else if (t <= minutes('17:50')) {
      level = 51.5 - 0.5 * ((t - minutes('13:05')) / 5);
      driving = true;
    } else if (t === minutes('17:55')) level = 23;
    else if (t === minutes('18:00')) level = 38;
    else level = 53;
    out.push({ unitExternalId: unit, kind, liters: level.toFixed(3), engineOn: driving, speedKmh: driving ? '60' : '0', observedAt: at(time) });
  }
  return out;
}

/** Compteur de litres consommés (CONSOMMATION_CAN) toutes les 30 min : 1 000 L à 08:00, 1 051 L à 18:00. */
function consumptionCounterDay(unit: string): Sample[] {
  const out: Sample[] = [];
  for (let t = minutes('07:30'); t <= minutes('18:30'); t += 30) {
    const elapsed = Math.min(Math.max(t - minutes('08:00'), 0), 600);
    out.push({ unitExternalId: unit, kind: 'CONSOMMATION_CAN', liters: (1000 + (51 * elapsed) / 600).toFixed(3), engineOn: true, speedKmh: '60', observedAt: at(hhmm(t)) });
  }
  return out;
}

/**
 * Carburant télématique — compléments (CDC 8.5, 17.1, annexe A ; D-234, D-236, D-238, D-240) : seuils propres
 * à un véhicule, consommation télématique en parallèle de la consommation déclarée, consommation théorique
 * jamais importée.
 */
describe('Carburant télématique — compléments (R-8.5-07, R-17.1-14, R-8.5-10, R-8.5-05, R-21-06)', () => {
  let t: TestApp;
  let f: Fixture;
  let admin: Agent;
  let chefA: Agent;
  let chefB: Agent;
  let operateurA: Agent;
  let lecteurA: Agent;
  let conducteurA: Agent;

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
    const enabled = await admin.post(`/telemetry/companies/${f.companies.A}/enable`, { reason: 'Mise en service du module F11' });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  });

  async function vehicle(code: string, init = '9000'): Promise<string> {
    const id = await createVehicle(t.prisma, f, 'A', { code });
    expect((await chefA.patch(`/vehicles/${id}`, { energy: 'DIESEL', tankCapacityLiters: '80', expectedVersion: 1 })).status).toBe(200);
    expect((await chefA.post(`/vehicles/${id}/odometer-segments`, { mode: 'INITIAL', startedAt: '2026-09-01T08:00:00Z', physicalKm: init })).status).toBe(201);
    return id;
  }

  /** SIMULATEUR actif couvrant A, unités découvertes ; associations confirmées par le chef (natures déclarées). */
  async function simulator(units: Array<{ externalId: string; fuelKinds: FuelKind[] }>, samples: Sample[]): Promise<{ id: string; units: Record<string, string> }> {
    const created = await admin.post('/telemetry/providers', {
      name: `Simulateur carburant ${randomBytes(3).toString('hex')}`,
      kind: 'SIMULATEUR',
      settings: { scenario: { units: units.map((u) => ({ externalId: u.externalId, label: `Boîtier ${u.externalId}`, declaredRegistration: null, odometerKinds: [], fuelKinds: u.fuelKinds })), fuelSamples: samples } },
      companyIds: [f.companies.A],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const activated = await admin.post(`/telemetry/providers/${created.body.id}/activate`, { expectedVersion: created.body.version });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect((await admin.post(`/telemetry/providers/${created.body.id}/discover`)).status).toBe(200);
    const rows = await t.prisma.client.telemetryUnit.findMany({ where: { providerId: created.body.id } });
    return { id: created.body.id as string, units: Object.fromEntries(rows.map((u) => [u.externalId, u.id])) };
  }

  async function associate(unitId: string, vehicleId: string, fuelKinds: FuelKind[]): Promise<void> {
    const res = await chefA.post('/telemetry/mappings', { unitId, vehicleId, odometerKind: 'AUCUN', fuelKinds });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function runDue(instant: string) {
    t.clock.set(instant);
    return t.app.get(TelemetrySyncService).runDue(new Date(instant), { holder: 'worker-test', sleep: () => Promise.resolve() });
  }

  async function ticket(vehicleId: string, filledAt: string, liters: string, odometerKm: string, isFullTank = true): Promise<string> {
    const res = await chefA.post('/fuel-entries', { vehicleId, filledAt, liters, unitPrice: '2.000', totalAmount: (Number(liters) * 2).toFixed(3), isFullTank, odometerKm }).set('Idempotency-Key', randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('VALIDE');
    return res.body.id as string;
  }

  /** Pleins de la journée type : A 40 L (10 000 km), partiel 20 L (10 200 km), B 30 L (10 400 km). */
  async function dayTickets(vehicleId: string): Promise<{ a: string; mid: string; b: string }> {
    t.clock.set(at('18:20'));
    const a = await ticket(vehicleId, at('08:00'), '40', '10000');
    const mid = await ticket(vehicleId, at('13:00'), '20', '10200', false);
    const b = await ticket(vehicleId, at('18:00'), '30', '10400');
    return { a, mid, b };
  }

  // ---------------------------------------------------------------------------------------------
  // R-8.5-07, R-17.1-14 — seuils propres au véhicule
  // ---------------------------------------------------------------------------------------------

  it('R-8.5-07, R-17.1-14 — seuils carburant par véhicule : lecture dans le périmètre, modification par le chef (motif, bornes, verrou optimiste y compris après un retrait, audit), priorité véhicule > société > groupe > produit', async () => {
    const vehicleId = await vehicle('V-SEUILS');
    const initial = await chefA.get(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`);
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toMatchObject({ vehicleId, companyId: f.companies.A, version: 0, reason: null, canEdit: true });
    expect(initial.body.thresholds.map((r: Record<string, unknown>) => [r['field'], r['vehicleValue'], r['companyValue'], r['effectiveValue'], r['source']])).toEqual([
      ['dropLiters', null, 10, 10, 'defaut'],
      ['dropPercent', null, 5, 5, 'defaut'],
      ['dropWindowMinutes', null, 30, 30, 'defaut'],
      ['fillLiters', null, 10, 10, 'defaut'],
      ['fillPercent', null, 10, 10, 'defaut'],
      ['fillWindowMinutes', null, 30, 30, 'defaut'],
    ]);
    // Périmètre : lecteur de A en lecture seule, chef de B 404, conducteur 403 ; seuls chef et administrateur modifient.
    expect((await lecteurA.get(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`)).body.canEdit).toBe(false);
    expect((await chefB.get(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`)).status).toBe(404);
    expect((await conducteurA.get(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`)).status).toBe(403);
    const body = { dropLiters: 5, dropWindowMinutes: 20, reason: 'Petit réservoir, surveillance renforcée', expectedVersion: 0 };
    expect((await operateurA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, body)).status).toBe(403);
    expect((await chefB.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, body)).status).toBe(404);

    // Bornes des paramètres correspondants, entier pour une fenêtre, motif, surcharge vide.
    const invalid = await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 0.1, fillPercent: 150, fillLiters: 12.3456, reason: 'Essai', expectedVersion: 0 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('SEUIL_INVALIDE');
    expect(invalid.body.fieldErrors).toEqual({ dropLiters: ['Valeur minimale 0.5 L.'], fillLiters: ['Nombre positif à 3 décimales au plus attendu.'], fillPercent: ['Valeur maximale 100 %.'] });
    expect((await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropWindowMinutes: 7.5, reason: 'Essai', expectedVersion: 0 })).body.fieldErrors).toHaveProperty('dropWindowMinutes');
    expect(await t.prisma.client.vehicleFuelThresholds.count()).toBe(0);
    expect((await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 5, reason: '', expectedVersion: 0 })).status).toBe(422);
    expect((await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { reason: 'Rien à surcharger', expectedVersion: 0 })).body.code).toBe('SURCHARGE_VIDE');

    // Surcharge société par l'administrateur (paramètres versionnés), puis surcharge du véhicule par le chef.
    const company = await admin.put('/settings/telemetry.fuelDropLiters', { value: 12, companyId: f.companies.A, reason: 'Parc poids lourds de la société A' });
    expect(company.status, JSON.stringify(company.body)).toBe(200);
    const saved = await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, reason: 'Petit réservoir, surveillance renforcée', updatedByName: 'Chaima Chef-A' });
    const rows = Object.fromEntries(saved.body.thresholds.map((r: { field: string }) => [r.field, r]));
    expect(rows['dropLiters']).toMatchObject({ vehicleValue: 5, companyValue: 12, companySource: 'societe', effectiveValue: 5, source: 'vehicule' });
    expect(rows['dropPercent']).toMatchObject({ vehicleValue: null, effectiveValue: 5, source: 'defaut' });
    expect(rows['dropWindowMinutes']).toMatchObject({ vehicleValue: 20, effectiveValue: 20, source: 'vehicule' });
    const audit = await t.prisma.client.auditEvent.findFirstOrThrow({ where: { action: 'telemetrie.seuils_carburant.modification', objectId: vehicleId } });
    expect(audit).toMatchObject({ companyId: f.companies.A, actorUserId: f.users.chefA, reason: 'Petit réservoir, surveillance renforcée', before: null });
    expect(audit.after).toMatchObject({ dropLiters: 5, dropWindowMinutes: 20, dropPercent: null });

    // Verrou optimiste : deux modifications simultanées de la même version → une seule réussit.
    const [x, y] = await Promise.all([
      chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 6, reason: 'Ajustement après essai', expectedVersion: 1 }),
      admin.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 7, reason: 'Ajustement concurrent', expectedVersion: 1 }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 8, reason: 'Version obsolète', expectedVersion: 1 })).status).toBe(409);

    // Tous les champs nuls : surcharge retirée (audit), retour aux valeurs de la société.
    const cleared = await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: null, reason: 'Retour aux seuils de la société', expectedVersion: 2 });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.version).toBe(0);
    expect(cleared.body.thresholds[0]).toMatchObject({ field: 'dropLiters', vehicleValue: null, effectiveValue: 12, source: 'societe' });
    expect(await t.prisma.client.auditEvent.count({ where: { action: 'telemetrie.seuils_carburant.suppression', objectId: vehicleId } })).toBe(1);
    expect(await t.prisma.client.vehicleFuelThresholds.count()).toBe(0);

    // Nouvelle surcharge après le retrait : jamais une version déjà lue (création, modification, retrait déjà
    // audités → version 4) ; une saisie préparée sur la toute première surcharge (version 1) est refusée.
    const again = await chefA.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { fillLiters: 20, reason: 'Nouvelle sonde, seuil de remplissage relevé', expectedVersion: 0 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.version).toBe(4);
    const stale = await admin.put(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`, { dropLiters: 9, reason: 'Saisie préparée avant le retrait', expectedVersion: 1 });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect((await chefA.get(`/telemetry/vehicles/${vehicleId}/fuel-thresholds`)).body.thresholds.map((r: { vehicleValue: number | null }) => r.vehicleValue)).toEqual([null, null, null, 20, null, null]);
  });

  it('R-8.5-07, R-17.1-14 — détection : seuils du véhicule prioritaires sur ceux de la société (3 L perdus moteur coupé : anomalie au seuil de 2 L, rien au seuil 10 L ou 5 % ; 25 L perdus : rien au seuil de 30 L ou 50 %) ; seuils appliqués tracés', async () => {
    const strict = await vehicle('V-STRICT');
    const standard = await vehicle('V-STANDARD');
    const lenient = await vehicle('V-TOLERANT');
    const drop = (unit: string, total: number): Sample[] =>
      ['09:00', '09:05', '09:10', '09:15', '09:20'].map((time, i) => ({ unitExternalId: unit, kind: 'NIVEAU_SONDE', liters: (60 - (total / 4) * i).toFixed(3), engineOn: false, speedKmh: '0', observedAt: at(time) }));
    const provider = await simulator(
      [
        { externalId: 'U-STRICT', fuelKinds: ['NIVEAU_SONDE'] },
        { externalId: 'U-STANDARD', fuelKinds: ['NIVEAU_SONDE'] },
        { externalId: 'U-TOLERANT', fuelKinds: ['NIVEAU_SONDE'] },
      ],
      [...drop('U-STRICT', 3), ...drop('U-STANDARD', 3), ...drop('U-TOLERANT', 25)],
    );
    await associate(provider.units['U-STRICT'] as string, strict, ['NIVEAU_SONDE']);
    await associate(provider.units['U-STANDARD'] as string, standard, ['NIVEAU_SONDE']);
    await associate(provider.units['U-TOLERANT'] as string, lenient, ['NIVEAU_SONDE']);
    const tight = await chefA.put(`/telemetry/vehicles/${strict}/fuel-thresholds`, { dropLiters: 2, dropPercent: 50, reason: 'Véhicule exposé au siphonnage', expectedVersion: 0 });
    expect(tight.status, JSON.stringify(tight.body)).toBe(200);
    const loose = await chefA.put(`/telemetry/vehicles/${lenient}/fuel-thresholds`, { dropLiters: 30, dropPercent: 50, reason: 'Sonde de benne, variations normales à l’arrêt', expectedVersion: 0 });
    expect(loose.status, JSON.stringify(loose.body)).toBe(200);

    await runDue(at('09:30'));
    const events = await t.prisma.client.fuelEvent.findMany();
    expect(events.map((e) => [e.vehicleId, e.type, e.status, e.litersDelta?.toString()])).toEqual([[strict, 'BAISSE_ANORMALE', 'A_QUALIFIER', '3']]);
    expect(events[0]?.details).toMatchObject({ seuils: { liters: 2, percent: 50, windowMinutes: 30 } });
    expect(await t.prisma.client.alert.count({ where: { type: 'CARBURANT_BAISSE_ANORMALE', status: 'ACTIVE', vehicleId: strict } })).toBe(1);
    // Échantillons des trois véhicules bien reçus : seule la règle de seuil les distingue.
    for (const id of [standard, lenient]) expect(await t.prisma.client.fuelLevelSample.count({ where: { vehicleId: id } })).toBe(5);
  });

  // ---------------------------------------------------------------------------------------------
  // R-8.5-10 — consommation télématique en parallèle
  // ---------------------------------------------------------------------------------------------

  it('R-8.5-10 — consommation télématique en parallèle (sonde : bilan de niveaux et remplissages ; compteur CAN : différence), même intervalle A → B, nature et écart ; N/D motivé ; rien sans mesure exploitable', async () => {
    const probe = await vehicle('V-SONDE');
    const counter = await vehicle('V-COMPTEUR');
    const gap = await vehicle('V-TROU');
    const gauge = await vehicle('V-JAUGE');
    const manual = await vehicle('V-MANUEL');
    const provider = await simulator(
      [
        { externalId: 'U-SONDE', fuelKinds: ['NIVEAU_SONDE'] },
        { externalId: 'U-COMPTEUR', fuelKinds: ['CONSOMMATION_CAN'] },
        { externalId: 'U-TROU', fuelKinds: ['NIVEAU_SONDE'] },
        { externalId: 'U-JAUGE', fuelKinds: ['NIVEAU_CAN'] },
      ],
      [...probeDay('U-SONDE'), ...consumptionCounterDay('U-COMPTEUR'), ...probeDay('U-TROU', { skip: ['10:00', '11:30'] }), ...probeDay('U-JAUGE', { kind: 'NIVEAU_CAN' })],
    );
    await associate(provider.units['U-SONDE'] as string, probe, ['NIVEAU_SONDE']);
    await associate(provider.units['U-COMPTEUR'] as string, counter, ['CONSOMMATION_CAN']);
    await associate(provider.units['U-TROU'] as string, gap, ['NIVEAU_SONDE']);
    await associate(provider.units['U-JAUGE'] as string, gauge, ['NIVEAU_CAN']);
    const tickets = { probe: await dayTickets(probe), counter: await dayTickets(counter), gap: await dayTickets(gap), gauge: await dayTickets(gauge), manual: await dayTickets(manual) };
    await runDue(at('18:30'));

    // Remplissages de la sonde rapprochés des pleins A, intermédiaire et B (justifiés, aucune anomalie).
    const fills = await t.prisma.client.fuelEvent.findMany({ where: { vehicleId: probe }, orderBy: { detectedAt: 'asc' } });
    expect(fills.map((e) => [e.type, e.qualification, e.fuelEntryId])).toEqual([
      ['REMPLISSAGE_DETECTE', 'JUSTIFIE', tickets.probe.a],
      ['REMPLISSAGE_DETECTE', 'JUSTIFIE', tickets.probe.mid],
      ['REMPLISSAGE_DETECTE', 'JUSTIFIE', tickets.probe.b],
    ]);

    // Sonde : 60 L après A − 23 L avant B + 20 L remplis entre les deux = 57 L sur 400 km → 14,3 L/100 km,
    // écart +14,0 % par rapport à la consommation déclarée (50 L, 12,5 L/100 km) du même intervalle.
    const sonde = (await lecteurA.get(`/vehicles/${probe}/consumption`)).body;
    expect(sonde.totals).toHaveLength(1);
    expect(sonde.totals[0]).toMatchObject({ energy: 'DIESEL', available: true, litersPer100Km: '12.5' });
    expect(sonde.totals[0].telematics).toEqual({
      kind: 'NIVEAU_SONDE',
      kindLabel: 'Niveau sonde',
      available: true,
      comparedIntervals: 1,
      liters: '57.000',
      distanceKm: '400.000',
      declaredLiters: '50.000',
      litersPer100Km: '14.3',
      litersPer100KmExact: '14.25',
      declaredLitersPer100Km: '12.5',
      deviationPercent: '+14.0',
      reasons: [],
    });
    const retained = sonde.intervals.find((i: { retained: boolean }) => i.retained);
    expect(retained).toMatchObject({ startFuelEntryId: tickets.probe.a, endFuelEntryId: tickets.probe.b, litersPer100Km: '12.5' });
    expect(retained.telematics).toMatchObject({ kind: 'NIVEAU_SONDE', available: true, liters: '57.000', litersPer100Km: '14.3', deviationPercent: '+14.0', reasons: [] });
    const first = sonde.intervals.find((i: { startFuelEntryId: string | null }) => i.startFuelEntryId === null);
    expect(first.telematics).toMatchObject({ available: false, reasons: [{ code: 'ECHANTILLONS_ABSENTS' }] });

    // Compteur CAN de consommation : 1 051 − 1 000 = 51 L → 12,8 L/100 km, écart +2,0 %.
    const can = (await chefA.get(`/vehicles/${counter}/consumption`)).body;
    expect(can.totals[0].telematics).toMatchObject({ kind: 'CONSOMMATION_CAN', kindLabel: 'Consommation CAN', available: true, liters: '51.000', litersPer100Km: '12.8', declaredLitersPer100Km: '12.5', deviationPercent: '+2.0' });

    // Trou de 90 min dans les échantillons : N/D motivé, la consommation déclarée reste affichée.
    const hole = (await chefA.get(`/vehicles/${gap}/consumption`)).body;
    expect(hole.totals[0]).toMatchObject({ available: true, litersPer100Km: '12.5' });
    expect(hole.totals[0].telematics).toMatchObject({ kind: 'NIVEAU_SONDE', available: false, comparedIntervals: 0, liters: null, litersPer100Km: null, deviationPercent: null, reasons: [{ code: 'ECHANTILLONS_ABSENTS' }, { code: 'TROU_ECHANTILLONS' }] });
    expect(hole.intervals.find((i: { retained: boolean }) => i.retained).telematics.reasons[0].label).toContain('60 minutes');

    // Jauge CAN seule (jamais utilisée) ou véhicule sans F11 : réponse inchangée, sans consommation télématique.
    for (const id of [gauge, manual]) {
      const plain = (await chefA.get(`/vehicles/${id}/consumption`)).body;
      expect(plain.totals[0]).toMatchObject({ available: true, litersPer100Km: '12.5' });
      expect(plain.totals[0]).not.toHaveProperty('telematics');
      expect(plain.intervals.every((i: Record<string, unknown>) => !('telematics' in i))).toBe(true);
    }
    // Périmètre inchangé : chef de B 404, conducteur 403.
    expect((await chefB.get(`/vehicles/${probe}/consumption`)).status).toBe(404);
    expect((await conducteurA.get(`/vehicles/${probe}/consumption`)).status).toBe(403);
    // Aucune matérialisation ni dépense : les seules dépenses sont celles des pleins saisis.
    expect(await t.prisma.client.expense.count({ where: { vehicleId: probe } })).toBe(3);
  });

  // ---------------------------------------------------------------------------------------------
  // R-8.5-05, R-21-06 — consommation théorique jamais importée
  // ---------------------------------------------------------------------------------------------

  it('R-8.5-05, R-21-06 — consommation théorique du fournisseur jamais importée : aucune nature ni configuration ne l’admet (Traccar, Wialon, rapports, webhook, simulateur, association)', async () => {
    const theoretical = 'CONSOMMATION_THEORIQUE';
    const configs: Array<{ kind: string; baseUrl?: string; settings: Record<string, unknown>; field: string }> = [
      { kind: 'TRACCAR', baseUrl: 'https://traccar.exemple.tn', settings: { fuelAttribute: 'fuelConsumption', fuelUnit: 'L', fuelKind: theoretical }, field: 'fuelKind' },
      { kind: 'WIALON', baseUrl: 'https://hst-api.wialon.com', settings: { odometerKind: 'COMPTEUR_CAN', fuelSensors: [{ name: 'Consommation par taux', kind: theoretical }] }, field: 'kind' },
      {
        kind: 'RAPPORT_GENERIQUE',
        settings: {
          source: 'SFTP',
          sftp: { host: 'sftp.exemple.tn', directory: '/rapports', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
          columns: { unit: 'Unité', timestamp: 'Date', fuelLiters: 'Consommation théorique (L)' },
          timestampFormat: 'ISO',
          fuelKind: theoretical,
        },
        field: 'fuelKind',
      },
    ];
    for (const c of configs) {
      const res = await admin.post('/telemetry/providers', { name: `Fournisseur ${c.kind}`, kind: c.kind, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}), settings: c.settings, companyIds: [f.companies.A] });
      expect(res.status, `${c.kind} ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.code, c.kind).toBe('PARAMETRES_INVALIDES');
      expect(res.body.message, c.kind).toContain(c.field);
    }
    const scenario = await admin.post('/telemetry/providers', {
      name: 'Simulateur théorique',
      kind: 'SIMULATEUR',
      settings: { scenario: { units: [{ externalId: 'U-T', label: 'Boîtier', declaredRegistration: null, odometerKinds: [], fuelKinds: [theoretical] }] } },
      companyIds: [f.companies.A],
    });
    expect(scenario.status).toBe(422);
    expect(await t.prisma.client.telemetryProvider.count()).toBe(0);

    // Association : seules les trois natures mesurées sont enregistrables par véhicule.
    const vehicleId = await vehicle('V-NATURE');
    const provider = await simulator([{ externalId: 'U-N', fuelKinds: ['NIVEAU_SONDE'] }], []);
    const refused = await chefA.post('/telemetry/mappings', { unitId: provider.units['U-N'], vehicleId, odometerKind: 'AUCUN', fuelKinds: [theoretical] });
    expect(refused.status).toBe(422);
    await associate(provider.units['U-N'] as string, vehicleId, ['NIVEAU_SONDE']);
    expect((await chefA.get(`/telemetry/vehicles/${vehicleId}`)).body.mapping.fuelKinds).toEqual(['NIVEAU_SONDE']);

    // Webhook : un lot poussé avec une consommation théorique est refusé en bloc, rien n'est déposé.
    const hook = await admin.post('/telemetry/providers', { name: 'Webhook théorique', kind: 'WEBHOOK_GENERIQUE', settings: {}, companyIds: [f.companies.A] });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    expect((await admin.put(`/telemetry/providers/${hook.body.id}/credentials/SIGNATURE_WEBHOOK`, { secret })).status).toBe(200);
    expect((await admin.post(`/telemetry/providers/${hook.body.id}/activate`, { expectedVersion: hook.body.version })).status).toBe(200);
    const payload = JSON.stringify({ version: 1, fuel: [{ unitExternalId: 'U-W', kind: theoretical, liters: '12.500', observedAt: '2026-09-24T06:30:00Z' }] });
    const timestamp = String(Math.floor(t.clock.now().getTime() / 1000));
    const pushed = await request(t.server)
      .post(`/api/v1/telemetry/webhooks/${hook.body.id}`)
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', webhookSignatureHeader(secret, timestamp, Buffer.from(payload, 'utf8')))
      .send(payload);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(422);
    expect(await t.prisma.client.telemetryWebhookDelivery.count()).toBe(0);
    expect(await t.prisma.client.fuelLevelSample.count()).toBe(0);
  });
});
