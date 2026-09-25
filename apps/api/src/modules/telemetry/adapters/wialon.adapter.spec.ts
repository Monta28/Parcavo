import { describe, expect, it } from 'vitest';
import { ProviderError } from '../telemetry-provider.interface.js';
import { DiagnosticsCollector } from './adapter-support.js';
import { WialonAdapter, asWialonUnit, fuelSensorsOf, mileageFromCalcLast, parseWialonSettings, wialonDeclaredRegistration, wialonUnit } from './wialon.adapter.js';

/**
 * Structures reprises de la documentation officielle Wialon Remote API (help.wialon.com/en/api) :
 *  - user-guide/data-format/units : propriétés générales (flag 1 : nm, cls, id, mu, uacl), avancées
 *    (256 : uid, hw…), dernier message et position (1024 : pos.t, lmsg), capteurs (4096 : sens{id, n, t,
 *    d, m, p, f, c, vt, vs, tbl}), compteurs (8192 : cfl, cnm, cneh, cnkb), profil (8388608 : pflds) ;
 *  - user-guide/api-reference/unit/calc_last : mileage{value, format{value « 24498.82 km »}}.
 * Les valeurs sont fictives ; la forme est celle de la documentation.
 */
const UNIT_ITEM = {
  nm: 'Camion 12',
  cls: 2,
  id: 16091323,
  mu: 0,
  uacl: 19327369763,
  uid: '865000000000123',
  hw: 1234,
  pos: { t: 1726128000, y: 36.8065, x: 10.1815, z: 12, s: 0, c: 0, sc: 9 },
  lmsg: { t: 1726128000, f: 7, tp: 'ud', pos: { y: 36.8065, x: 10.1815, z: 12, s: 0, c: 0, sc: 9 }, i: 0, o: 0, p: { can_fls: 412 } },
  sens: {
    '1': { id: 1, n: 'Réservoir', t: 'fuel level', d: '', m: 'l', p: 'can_fls', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
    '2': { id: 2, n: 'Contact', t: 'engine operation', d: '', m: 'On/Off', p: 'in1', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
    '3': { id: 3, n: 'Compteur CAN', t: 'mileage', d: '', m: 'km', p: 'can_mileage', f: 0, c: '', vt: 0, vs: 0, tbl: [] },
  },
  cfl: 1,
  cnm: 24498,
  cneh: 0,
  cnkb: 0,
  pflds: { '1': { id: 1, n: 'registration_plate', v: '123 TU 4567' } },
  flds: { '1': { id: 1, n: 'Immatriculation', v: '123-TU-4567' } },
};

const settings = (extra: Record<string, unknown> = {}) => parseWialonSettings({ odometerKind: 'COMPTEUR_CAN', ...extra });

describe('Adaptateur Wialon — normalisation (structures documentées)', () => {
  it('unité : identifiant, nom, dernier message, capteurs, compteur, champs de profil et personnalisés', () => {
    const unit = asWialonUnit(UNIT_ITEM);
    expect(unit).toMatchObject({ id: 16091323, name: 'Camion 12', mu: 0, uid: '865000000000123', lastMessageAt: 1726128000, mileageCounter: 24498 });
    expect(unit?.sensors).toHaveLength(3);
    expect(asWialonUnit({ nm: 'sans id' })).toBeNull();
  });

  it('immatriculation déclarée selon registrationSource', () => {
    const unit = asWialonUnit(UNIT_ITEM) as NonNullable<ReturnType<typeof asWialonUnit>>;
    expect(wialonDeclaredRegistration(unit, { kind: 'name' })).toBe('Camion 12');
    expect(wialonDeclaredRegistration(unit, { kind: 'uid' })).toBe('865000000000123');
    expect(wialonDeclaredRegistration(unit, { kind: 'profile', field: 'registration_plate' })).toBe('123 TU 4567');
    expect(wialonDeclaredRegistration(unit, { kind: 'custom', field: 'Immatriculation' })).toBe('123-TU-4567');
    expect(wialonDeclaredRegistration(unit, { kind: 'profile', field: 'vin' })).toBeNull();
  });

  it('natures : kilométrage selon settings.odometerKind, carburant selon les capteurs déclarés', () => {
    const unit = asWialonUnit(UNIT_ITEM) as NonNullable<ReturnType<typeof asWialonUnit>>;
    const diag = new DiagnosticsCollector();
    expect(wialonUnit(unit, settings({ registrationSource: 'profile:registration_plate', fuelSensors: [{ type: 'fuel level', kind: 'NIVEAU_SONDE' }] }), diag)).toEqual({
      externalId: '16091323',
      label: 'Camion 12',
      declaredRegistration: '123 TU 4567',
      odometerKinds: ['COMPTEUR_CAN'],
      fuelKinds: ['NIVEAU_SONDE'],
    });
    expect(wialonUnit(unit, parseWialonSettings({ odometerKind: 'DISTANCE_GPS' }), diag)).toMatchObject({ odometerKinds: ['DISTANCE_GPS'], fuelKinds: [] });
  });

  it('plusieurs capteurs carburant pour une même nature : ambiguïté comptée, nature ignorée', () => {
    const twoTanks = { ...UNIT_ITEM, sens: { ...UNIT_ITEM.sens, '4': { id: 4, n: 'Réservoir 2', t: 'fuel level', m: 'l' } } };
    const unit = asWialonUnit(twoTanks) as NonNullable<ReturnType<typeof asWialonUnit>>;
    const diag = new DiagnosticsCollector();
    expect(fuelSensorsOf(unit, settings({ fuelSensors: [{ type: 'fuel level', kind: 'NIVEAU_SONDE' }] }), diag)).toEqual([]);
    expect(Object.keys(diag.snapshot().rejected)).toHaveLength(1);
    expect(fuelSensorsOf(unit, settings({ fuelSensors: [{ type: 'fuel level', name: 'Réservoir', kind: 'NIVEAU_SONDE' }] }), diag)).toHaveLength(1);
  });

  it('calc_last : km (format « 24498.82 km »), miles convertis, unité inconnue refusée', () => {
    expect(mileageFromCalcLast({ i: 1, mileage: { value: 24498.82, format: { value: '24498.82 km' } } }, 0)).toBe('24498.820');
    expect(mileageFromCalcLast({ i: 1, mileage: { value: 100, format: { value: '100.00 mi' } } }, 0)).toBe('160.934');
    expect(mileageFromCalcLast({ i: 1, mileage: { value: 100 } }, 1)).toBe('160.934');
    expect(mileageFromCalcLast({ i: 1, mileage: { value: 100 } }, null)).toBeNull();
    expect(mileageFromCalcLast({ i: 1, mileage: { value: -3, format: { value: '-3 km' } } }, 0)).toBeNull();
    expect(mileageFromCalcLast({ i: 1 }, 0)).toBeNull();
  });

  it('codes d’erreur documentés → erreurs typées', () => {
    expect(WialonAdapter.mapError('core/search_items', 1).kind).toBe('AUTHENTIFICATION');
    expect(WialonAdapter.mapError('core/search_items', 4).kind).toBe('REPONSE_INVALIDE');
    expect(WialonAdapter.mapError('unit/calc_last', 7).kind).toBe('AUTHENTIFICATION');
    expect(WialonAdapter.mapError('unit/calc_last', 6).kind).toBe('INJOIGNABLE');
    expect(WialonAdapter.mapError('messages/load_interval', 1003).kind).toBe('QUOTA');
  });

  it('paramètres : nature du compteur obligatoire, capteurs désignés, historique seulement avec capteur de kilométrage', () => {
    expect(() => parseWialonSettings({})).toThrow(ProviderError);
    expect(() => parseWialonSettings({ odometerKind: 'CAN' })).toThrow(ProviderError);
    expect(() => settings({ registrationSource: 'plaque' })).toThrow(ProviderError);
    expect(() => settings({ fuelSensors: [{ kind: 'NIVEAU_SONDE' }] })).toThrow(/type \(t\) ou son nom/);
    expect(() => settings({ fuelSensors: [{ type: 'fuel level', kind: 'ESTIMATION' }] })).toThrow(ProviderError);
    expect(settings().engineSensor).toEqual({ type: 'engine operation', name: null });
    expect(settings({ engineSensor: null }).engineSensor).toBeNull();
    const base = { providerId: 'p', baseUrl: 'https://hst-api.wialon.com', secrets: { JETON_API: 'x' }, timeoutMs: 1000, timezone: 'Africa/Tunis' };
    expect(new WialonAdapter({ ...base, settings: { odometerKind: 'COMPTEUR_CAN' } }).getOdometerHistory).toBeUndefined();
    expect(typeof new WialonAdapter({ ...base, settings: { odometerKind: 'COMPTEUR_CAN', mileageSensor: { type: 'mileage' } } }).getOdometerHistory).toBe('function');
  });
});
