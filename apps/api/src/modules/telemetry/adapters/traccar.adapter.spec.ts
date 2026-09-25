import { describe, expect, it } from 'vitest';
import { ProviderError } from '../telemetry-provider.interface.js';
import { DiagnosticsCollector, metersToKm, parseRetryAfter } from './adapter-support.js';
import { Decimal } from 'decimal.js';
import { TraccarAdapter, asDevice, asPosition, parseTraccarSettings, traccarFuelSample, traccarOdometerSamples, traccarUnit } from './traccar.adapter.js';

/**
 * Réponses enregistrées d'un serveur Traccar 6.15.3 réel (conteneur mirror.gcr.io/traccar/traccar:6.15,
 * positions envoyées par le protocole OsmAnd avec les paramètres odometer, fuel, ignition et speed),
 * recopiées telles que renvoyées par GET /api/devices et GET /api/positions (D-292, D-294).
 */
const DEVICE = JSON.parse(
  '{"id":1,"attributes":{"immat":"123 TU 4567"},"groupId":0,"calendarId":0,"name":"123 TU 4567","uniqueId":"865000000000001","status":"online","lastUpdate":"2026-09-24T15:10:44.725+00:00","positionId":0,"phone":null,"model":null,"contact":null,"category":null,"disabled":false,"expirationTime":null}',
) as unknown;
const POSITION_1 = JSON.parse(
  '{"id":1,"attributes":{"odometer":5.0E7,"fuel":62.5,"ignition":false,"distance":0.0,"totalDistance":0.0,"motion":false},"deviceId":1,"protocol":"osmand","serverTime":"2026-09-24T15:10:44.693+00:00","deviceTime":"2026-09-24T08:00:00.000+00:00","fixTime":"2026-09-24T08:00:00.000+00:00","valid":true,"latitude":36.8065,"longitude":10.1815,"altitude":0.0,"speed":0.0,"course":0.0,"address":null,"accuracy":0.0,"network":null,"geofenceIds":null}',
) as unknown;
const POSITION_2 = JSON.parse(
  '{"id":2,"attributes":{"odometer":5.0012345E7,"fuel":60.0,"ignition":true,"distance":1426.010135470461,"totalDistance":1426.010135470461,"motion":true},"deviceId":1,"protocol":"osmand","serverTime":"2026-09-24T15:10:44.721+00:00","deviceTime":"2026-09-24T08:10:00.000+00:00","fixTime":"2026-09-24T08:10:00.000+00:00","valid":true,"latitude":36.8165,"longitude":10.1915,"altitude":0.0,"speed":20.0,"course":0.0,"address":null,"accuracy":0.0,"network":null,"geofenceIds":null}',
) as unknown;
/**
 * Position enregistrée du même serveur, reçue SANS fix GPS (OsmAnd sans lat/lon, 10 min après un fix) :
 * Traccar recopie le dernier fix (fixTime, position, valid) mais l'attribut odometer est celui de deviceTime.
 */
const POSITION_WITHOUT_FIX = JSON.parse(
  '{"id":2,"attributes":{"odometer":1005000.0,"distance":0.0,"totalDistance":0.0,"motion":false},"deviceId":1,"protocol":"osmand","serverTime":"2026-09-24T17:25:34.575+00:00","deviceTime":"2026-09-24T16:35:32.000+00:00","fixTime":"2026-09-24T16:25:32.000+00:00","valid":true,"latitude":36.8,"longitude":10.1,"altitude":0.0,"speed":0.0,"course":0.0,"address":null,"accuracy":0.0,"network":null,"geofenceIds":null}',
) as unknown;

const settings = (extra: Record<string, unknown> = {}) => parseTraccarSettings(extra);
const position = (v: unknown) => asPosition(v) as NonNullable<ReturnType<typeof asPosition>>;

describe('Adaptateur Traccar — normalisation (D-294, D-195)', () => {
  it('compteur CAN (odometer) et distance GPS (totalDistance) en km, instant fixTime, référence de position', () => {
    const diag = new DiagnosticsCollector();
    expect(traccarOdometerSamples(position(POSITION_2), settings(), diag)).toEqual([
      { unitExternalId: '1', kind: 'COMPTEUR_CAN', valueKm: '50012.345', observedAt: new Date('2026-09-24T08:10:00.000Z'), sourceReference: 'pos:2:COMPTEUR_CAN' },
      { unitExternalId: '1', kind: 'DISTANCE_GPS', valueKm: '1.426', observedAt: new Date('2026-09-24T08:10:00.000Z'), sourceReference: 'pos:2:DISTANCE_GPS' },
    ]);
    expect(traccarOdometerSamples(position(POSITION_1), settings(), diag).map((s) => s.valueKm)).toEqual(['50000.000', '0.000']);
    expect(diag.snapshot().rejected).toEqual({});
  });

  it('attributs paramétrables : odometer déclaré GPS, nature CAN désactivée, horodatage deviceTime', () => {
    const s = settings({ canOdometerAttribute: null, gpsDistanceAttribute: 'odometer', timeSource: 'deviceTime' });
    const samples = traccarOdometerSamples(position(POSITION_2), s, new DiagnosticsCollector());
    expect(samples).toEqual([{ unitExternalId: '1', kind: 'DISTANCE_GPS', valueKm: '50012.345', observedAt: new Date('2026-09-24T08:10:00.000Z'), sourceReference: 'pos:2:DISTANCE_GPS' }]);
  });

  it('valeurs absentes omises, invalides écartées et comptées ; position sans horodatage refusée', () => {
    const diag = new DiagnosticsCollector();
    const noAttributes = position({ id: 9, deviceId: 3, fixTime: '2026-09-24T08:00:00Z', attributes: {} });
    expect(traccarOdometerSamples(noAttributes, settings(), diag)).toEqual([]);
    const invalid = position({ id: 10, deviceId: 3, fixTime: '2026-09-24T08:00:00Z', attributes: { odometer: -5, totalDistance: 'abc' } });
    expect(traccarOdometerSamples(invalid, settings(), diag)).toEqual([]);
    const undated = position({ id: 11, deviceId: 3, fixTime: null, attributes: { odometer: 1000 } });
    expect(traccarOdometerSamples(undated, settings(), diag)).toEqual([]);
    const localTime = position({ id: 12, deviceId: 3, fixTime: '2026-09-24T08:00:00', attributes: { odometer: 1000 } });
    expect(traccarOdometerSamples(localTime, settings(), diag)).toEqual([]);
    expect(diag.snapshot().rejected).toEqual({
      'compteur COMPTEUR_CAN invalide': 1,
      'compteur DISTANCE_GPS invalide': 1,
      'position sans horodatage exploitable': 2,
    });
  });

  it('position reçue sans fix GPS (fix recopié par Traccar) : écartée en mode fixTime, datée deviceTime sur demande', () => {
    const diag = new DiagnosticsCollector();
    expect(traccarOdometerSamples(position(POSITION_WITHOUT_FIX), settings(), diag)).toEqual([]);
    const fuelSettings = settings({ fuelAttribute: 'odometer', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE', canOdometerAttribute: null, gpsDistanceAttribute: 'totalDistance' });
    expect(traccarFuelSample(position(POSITION_WITHOUT_FIX), fuelSettings, diag)).toBeNull();
    expect(diag.snapshot().rejected).toEqual({ 'position sans fix GPS récent (fixTime antérieur à deviceTime) : instant de mesure incertain': 3 });
    // Tolérance élargie : l'écart de 10 min est admis et l'instant reste fixTime.
    expect(traccarOdometerSamples(position(POSITION_WITHOUT_FIX), settings({ staleFixToleranceSeconds: 900 }), diag)[0]?.observedAt).toEqual(new Date('2026-09-24T16:25:32.000Z'));
    expect(traccarOdometerSamples(position(POSITION_WITHOUT_FIX), settings({ timeSource: 'deviceTime' }), diag)).toEqual([
      { unitExternalId: '1', kind: 'COMPTEUR_CAN', valueKm: '1005.000', observedAt: new Date('2026-09-24T16:35:32.000Z'), sourceReference: 'pos:2:COMPTEUR_CAN' },
      { unitExternalId: '1', kind: 'DISTANCE_GPS', valueKm: '0.000', observedAt: new Date('2026-09-24T16:35:32.000Z'), sourceReference: 'pos:2:DISTANCE_GPS' },
    ]);
  });

  it('carburant configuré : %, moteur (ignition), vitesse nœuds → km/h ; sans configuration, rien', () => {
    const s = settings({ fuelAttribute: 'fuel', fuelUnit: '%', fuelKind: 'NIVEAU_CAN' });
    const diag = new DiagnosticsCollector();
    expect(traccarFuelSample(position(POSITION_2), s, diag)).toEqual({
      unitExternalId: '1',
      kind: 'NIVEAU_CAN',
      liters: null,
      percent: '60.000',
      engineOn: true,
      speedKmh: '37.040',
      observedAt: new Date('2026-09-24T08:10:00.000Z'),
      sourceReference: 'pos:2',
    });
    const liters = settings({ fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' });
    expect(traccarFuelSample(position(POSITION_1), liters, diag)).toMatchObject({ liters: '62.500', percent: null, engineOn: false, speedKmh: '0.000' });
    expect(traccarFuelSample(position(POSITION_1), settings(), diag)).toBeNull();
    const over = position({ id: 5, deviceId: 1, fixTime: '2026-09-24T08:00:00Z', valid: false, speed: 3, attributes: { fuel: 140 } });
    expect(traccarFuelSample(over, s, diag)).toBeNull();
    expect(diag.snapshot().rejected).toEqual({ 'niveau de carburant invalide': 1 });
    const invalidFix = position({ id: 6, deviceId: 1, fixTime: '2026-09-24T08:00:00Z', valid: false, speed: 3, attributes: { fuel: 40 } });
    expect(traccarFuelSample(invalidFix, s, diag)).toMatchObject({ percent: '40.000', engineOn: null, speedKmh: null });
  });

  it('unité : immatriculation selon registrationSource, natures constatées sur la dernière position', () => {
    const device = asDevice(DEVICE) as NonNullable<ReturnType<typeof asDevice>>;
    const s = settings({ fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' });
    expect(traccarUnit(device, position(POSITION_2), s)).toEqual({
      externalId: '1',
      label: '123 TU 4567',
      declaredRegistration: '123 TU 4567',
      odometerKinds: ['COMPTEUR_CAN', 'DISTANCE_GPS'],
      fuelKinds: ['NIVEAU_SONDE'],
    });
    expect(traccarUnit(device, undefined, settings({ registrationSource: 'uniqueId' }))).toMatchObject({ declaredRegistration: '865000000000001', odometerKinds: [], fuelKinds: [] });
    expect(traccarUnit(device, undefined, settings({ registrationSource: 'attribute:immat' })).declaredRegistration).toBe('123 TU 4567');
    expect(traccarUnit(device, undefined, settings({ registrationSource: 'attribute:absent' })).declaredRegistration).toBeNull();
  });

  it('paramètres incohérents refusés (CONFIGURATION)', () => {
    const bad: Array<Record<string, unknown>> = [
      { registrationSource: 'plaque' },
      { fuelAttribute: 'fuel' },
      { fuelAttribute: 'fuel', fuelUnit: 'gallon', fuelKind: 'NIVEAU_CAN' },
      { fuelUnit: 'L' },
      { timeSource: 'serverTime' },
      { canOdometerAttribute: 'odometer', gpsDistanceAttribute: 'odometer' },
      { historyChunkHours: 0 },
      { staleFixToleranceSeconds: -1 },
    ];
    for (const s of bad) expect(() => parseTraccarSettings(s)).toThrow(ProviderError);
  });

  it('URL et secrets : https exigé pour un hôte distant, secret absent signalé sans appel réseau', async () => {
    const base = { providerId: 'p', settings: {}, secrets: {}, timeoutMs: 1000, timezone: 'Africa/Tunis' };
    expect(() => new TraccarAdapter({ ...base, baseUrl: 'http://traccar.example.com' })).toThrow(/HTTP non chiffré/);
    expect(() => new TraccarAdapter({ ...base, baseUrl: null })).toThrow(/URL de base/);
    expect(() => new TraccarAdapter({ ...base, baseUrl: 'https://u:p@traccar.example.com' })).toThrow(/identifiant/);
    expect(() => new TraccarAdapter({ ...base, baseUrl: 'http://traccar.lan:8082', settings: { allowPlainHttp: true } })).not.toThrow();
    const adapter = new TraccarAdapter({ ...base, baseUrl: 'https://traccar.example.com/api' });
    await expect(adapter.listUnits()).rejects.toMatchObject({ kind: 'CONFIGURATION' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).not.toMatch(/example\.com/);
    await expect(new TraccarAdapter({ ...base, baseUrl: 'https://traccar.example.com', secrets: { IDENTIFIANTS_API: 'sans-deux-points' } }).getOdometers(['1'])).rejects.toMatchObject({
      kind: 'CONFIGURATION',
    });
    await expect(adapter.getOdometers([])).resolves.toEqual([]);
  });
});

describe('Conversions communes', () => {
  it('mètres → km arrondis au mètre (demi vers le haut), bornés à Decimal(15, 3)', () => {
    expect(metersToKm(new Decimal('1426.5'))).toBe('1.427');
    expect(metersToKm(new Decimal('1426.4999'))).toBe('1.426');
    expect(metersToKm(new Decimal('-1'))).toBeNull();
    expect(metersToKm(new Decimal('1e18'))).toBeNull();
  });
  it('Retry-After en secondes ou date HTTP', () => {
    expect(parseRetryAfter('120', 0)).toBe(120);
    expect(parseRetryAfter('Thu, 24 Sep 2026 10:00:30 GMT', Date.parse('2026-09-24T10:00:00Z'))).toBe(30);
    expect(parseRetryAfter('bientôt', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
