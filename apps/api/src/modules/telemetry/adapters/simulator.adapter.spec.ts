import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../common/clock.js';
import { BusinessRuleError } from '../../../common/errors.js';
import { type AdapterConfig, ProviderError } from '../telemetry-provider.interface.js';
import { createSimulatorAdapter, parseSimulatorScenario } from './simulator.adapter.js';

const TOKEN = 'JETON-SIMULE-7f3a9c';

function config(scenario: Record<string, unknown>, options: { now?: string; token?: string | null } = {}): AdapterConfig {
  return {
    providerId: '00000000-0000-7000-8000-000000000001',
    baseUrl: 'https://simulateur.test',
    settings: { scenario },
    secrets: options.token === null ? {} : { JETON_API: options.token ?? TOKEN },
    timeoutMs: 1000,
    timezone: 'Africa/Tunis',
    clock: new FixedClock(options.now ?? '2026-09-24T10:00:00.000Z'),
  };
}

const BASE = {
  units: [
    { externalId: 'U1', label: 'Camion 1', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] },
    { externalId: 'U2', label: 'Utilitaire 2', declaredRegistration: null, odometerKinds: ['DISTANCE_GPS'], fuelKinds: [], removedAt: '2026-09-24T09:00:00Z' },
    { externalId: 'U3', label: 'VL 3', declaredRegistration: '200 TU 1', odometerKinds: ['COMPTEUR_CAN', 'DISTANCE_GPS'], fuelKinds: [] },
  ],
  odometerSamples: [
    { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '50000', observedAt: '2026-09-24T08:00:00Z', sourceReference: 'p1' },
    { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '50120.5', observedAt: '2026-09-24T09:00:00Z', sourceReference: 'p2' },
    { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '50200', observedAt: '2026-09-24T11:00:00Z', sourceReference: 'p3' },
    { unitExternalId: 'U3', kind: 'DISTANCE_GPS', valueKm: '12000', observedAt: '2026-09-24T07:00:00Z' },
    { unitExternalId: 'U3', kind: 'COMPTEUR_CAN', valueKm: '80000.001', observedAt: '2026-09-24T07:30:00+01:00' },
  ],
  fuelSamples: [
    { unitExternalId: 'U1', kind: 'NIVEAU_SONDE', liters: '80', engineOn: false, speedKmh: '0', observedAt: '2026-09-24T08:00:00Z' },
    { unitExternalId: 'U1', kind: 'NIVEAU_SONDE', liters: '55', engineOn: false, speedKmh: '0', observedAt: '2026-09-24T08:20:00Z' },
  ],
};

describe('SIMULATEUR — données fictives (D-292, D-303)', () => {
  it('liste les unités présentes, libellées comme simulées, avec natures et immatriculations déclarées', async () => {
    const adapter = createSimulatorAdapter(config(BASE));
    const units = await adapter.listUnits();
    expect(units.map((u) => u.externalId)).toEqual(['U1', 'U3']);
    expect(units[0]).toEqual({ externalId: 'U1', label: 'SIMULATEUR — Camion 1', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] });
    const before = createSimulatorAdapter(config(BASE, { now: '2026-09-24T08:30:00Z' }));
    expect((await before.listUnits()).map((u) => u.externalId)).toEqual(['U1', 'U2', 'U3']);
  });

  it('dernier état par unité et par nature, jamais un échantillon futur ; horodatage fournisseur conservé', async () => {
    const adapter = createSimulatorAdapter(config(BASE));
    const samples = await adapter.getOdometers(['U1', 'U3', 'INCONNUE']);
    expect(samples).toEqual([
      { unitExternalId: 'U3', kind: 'COMPTEUR_CAN', valueKm: '80000.001', observedAt: new Date('2026-09-24T06:30:00Z'), sourceReference: null },
      { unitExternalId: 'U3', kind: 'DISTANCE_GPS', valueKm: '12000', observedAt: new Date('2026-09-24T07:00:00Z'), sourceReference: null },
      { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '50120.5', observedAt: new Date('2026-09-24T09:00:00Z'), sourceReference: 'p2' },
    ]);
  });

  it('historique et carburant bornés à la période et à l’instant courant', async () => {
    const adapter = createSimulatorAdapter(config(BASE));
    const history = await adapter.getOdometerHistory?.(['U1'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    expect(history?.map((s) => s.valueKm)).toEqual(['50000', '50120.5']);
    const fuel = await adapter.getFuel(['U1'], new Date('2026-09-24T08:10:00Z'), new Date('2026-09-24T12:00:00Z'));
    expect(fuel).toEqual([{ unitExternalId: 'U1', kind: 'NIVEAU_SONDE', liters: '55', percent: null, engineOn: false, speedKmh: '0', observedAt: new Date('2026-09-24T08:20:00Z'), sourceReference: null }]);
    const noHistory = createSimulatorAdapter(config({ ...BASE, supportsHistory: false }));
    expect(noHistory.getOdometerHistory).toBeUndefined();
  });

  it('doublons et désordre déterministes (même résultat à chaque appel)', async () => {
    const inverse = createSimulatorAdapter(config({ ...BASE, order: 'INVERSE', duplicates: true }));
    const a = await inverse.getOdometerHistory?.(['U1'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    const b = await inverse.getOdometerHistory?.(['U1'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    expect(a?.map((s) => s.sourceReference)).toEqual(['p2', 'p2', 'p1', 'p1']);
    expect(b).toEqual(a);
    const interleaved = createSimulatorAdapter(config({ ...BASE, order: 'ENTRELACE' }));
    const all = await interleaved.getOdometerHistory?.(['U1', 'U3'], new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
    expect(all?.map((s) => s.valueKm)).toEqual(['12000', '50120.5', '80000.001', '50000']);
  });

  it('pannes scénarisées : injoignable dans une fenêtre, quota 429 avec Retry-After, authentification', async () => {
    const outage = createSimulatorAdapter(config({ ...BASE, failures: [{ mode: 'INJOIGNABLE', from: '2026-09-24T09:00:00Z', until: '2026-09-25T10:00:00Z' }] }));
    await expect(outage.getOdometers(['U1'])).rejects.toMatchObject({ kind: 'INJOIGNABLE' });
    const later = createSimulatorAdapter(config({ ...BASE, failures: [{ mode: 'INJOIGNABLE', from: '2026-09-24T09:00:00Z', until: '2026-09-24T09:30:00Z' }] }));
    await expect(later.getOdometers(['U1'])).resolves.toHaveLength(1);

    const quota = createSimulatorAdapter(config({ ...BASE, failures: [{ mode: 'QUOTA', retryAfterSeconds: 120, operations: ['getFuel'] }] }));
    await expect(quota.getOdometers(['U1'])).resolves.toHaveLength(1);
    const error = await quota.getFuel(['U1'], new Date(0), new Date('2027-01-01T00:00:00Z')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'QUOTA', retryAfterSeconds: 120 });

    const noToken = createSimulatorAdapter(config({ ...BASE, authRequired: true }, { token: null }));
    await expect(noToken.listUnits()).rejects.toMatchObject({ kind: 'AUTHENTIFICATION' });
  });

  it('client « bavard » : l’erreur brute cite l’URL avec le jeton, le contrôle de santé renvoie un message expurgé', async () => {
    const adapter = createSimulatorAdapter(config({ ...BASE, echoRequestUrlInErrors: true, failures: [{ mode: 'AUTHENTIFICATION' }] }));
    const error = (await adapter.listUnits().catch((e: unknown) => e)) as ProviderError;
    expect(error.kind).toBe('AUTHENTIFICATION');
    expect(error.message).toContain(TOKEN);
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toContain('SIMULATEUR — données fictives');
    expect(health.message).not.toContain(TOKEN);
    expect(health.checkedAt).toEqual(new Date('2026-09-24T10:00:00.000Z'));
    await expect(createSimulatorAdapter(config(BASE)).healthCheck()).resolves.toMatchObject({ ok: true, latencyMs: null });
  });

  it('scénario invalide : 422 avec erreurs par champ (horodatage absent, nature non déclarée, champ inconnu)', () => {
    const run = () =>
      parseSimulatorScenario({
        scenario: {
          units: [{ externalId: 'U1', label: 'A', odometerKinds: ['COMPTEUR_CAN'] }],
          odometerSamples: [
            { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '10' },
            { unitExternalId: 'U1', kind: 'DISTANCE_GPS', valueKm: '10', observedAt: '2026-09-24T08:00:00Z' },
            { unitExternalId: 'U1', kind: 'COMPTEUR_CAN', valueKm: '-4', observedAt: '2026-09-24 08:00' },
          ],
          inconnu: true,
        },
      });
    expect(run).toThrow(BusinessRuleError);
    try {
      run();
    } catch (error) {
      const fields = (error as BusinessRuleError).fieldErrors ?? {};
      expect(Object.keys(fields).sort()).toEqual([
        'settings.scenario.inconnu',
        'settings.scenario.odometerSamples[0].observedAt',
        'settings.scenario.odometerSamples[1].kind',
        'settings.scenario.odometerSamples[2].observedAt',
        'settings.scenario.odometerSamples[2].valueKm',
      ]);
    }
  });
});
