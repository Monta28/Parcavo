import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../common/clock.js';
import { BusinessRuleError } from '../../common/errors.js';
import { type AppEnv, loadEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { SecretsCryptoService } from '../../infra/secrets-crypto.service.js';
import { TelemetryAdapterRegistry, describeProviderKinds, resolveAdapterFactory, validateProviderConfiguration } from './telemetry-adapter.registry.js';
import { TelemetryCredentialsService } from './telemetry-credentials.service.js';
import { RPA_REFUSAL_MESSAGE } from './telemetry-settings.js';

const KEY = Buffer.alloc(32, 3).toString('base64');

function env(nodeEnv: 'production' | 'test', simulator: boolean): AppEnv {
  return loadEnv({
    NODE_ENV: nodeEnv,
    DATABASE_URL: 'postgresql://registre:registre@localhost:1/aucune_connexion',
    SECRETS_ENCRYPTION_KEY: KEY,
    TELEMETRY_SIMULATOR_ENABLED: simulator ? 'true' : 'false',
  });
}

/** Registre réel construit hors conteneur Nest ; aucune requête n'est émise par les cas testés. */
function registry(appEnv: AppEnv): TelemetryAdapterRegistry {
  const prisma = new PrismaService(appEnv);
  const clock = new FixedClock('2026-09-24T10:00:00Z');
  return new TelemetryAdapterRegistry(appEnv, prisma, new TelemetryCredentialsService(prisma, new SecretsCryptoService(appEnv), clock), clock);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof BusinessRuleError ? error.code : `autre: ${String(error)}`;
  }
}

describe('Registre des adaptateurs télématiques (D-292, D-303)', () => {
  it('production : le simulateur ne peut pas être demandé (loadEnv) ni résolu (registre), même forcé', () => {
    expect(() => env('production', true)).toThrow(/ne peut pas être activé en production/);
    const prod = env('production', false);
    expect(prod.telemetrySimulatorEnabled).toBe(false);
    expect(codeOf(() => resolveAdapterFactory('SIMULATEUR', prod))).toBe('SIMULATEUR_INTERDIT_EN_PRODUCTION');
    // Défense en profondeur : un environnement incohérent (drapeau forcé) reste refusé en production.
    expect(codeOf(() => resolveAdapterFactory('SIMULATEUR', { nodeEnv: 'production', telemetrySimulatorEnabled: true }))).toBe('SIMULATEUR_INTERDIT_EN_PRODUCTION');
    expect(codeOf(() => registry(prod).factoryFor('SIMULATEUR'))).toBe('SIMULATEUR_INTERDIT_EN_PRODUCTION');
    const kinds = describeProviderKinds(prod);
    expect(kinds.find((k) => k.kind === 'SIMULATEUR')).toMatchObject({ available: false, label: 'SIMULATEUR — données fictives' });
    expect(kinds.filter((k) => k.available).map((k) => k.kind)).toEqual(['TRACCAR', 'WIALON', 'RAPPORT_GENERIQUE', 'WEBHOOK_GENERIQUE']);
    expect(kinds.find((k) => k.kind === 'WEBHOOK_GENERIQUE')).toMatchObject({ channel: 'WEBHOOK', available: true });
  });

  it('production : ouvrir un simulateur existant échoue avant tout déchiffrement ou appel', async () => {
    const reg = registry(env('production', false));
    const opened = reg.withAdapter({ id: '00000000-0000-7000-8000-000000000001', organizationId: '00000000-0000-7000-8000-000000000002', kind: 'SIMULATEUR', baseUrl: null, settings: {} }, () => Promise.resolve('jamais'));
    await expect(opened).rejects.toMatchObject({ code: 'SIMULATEUR_INTERDIT_EN_PRODUCTION' });
  });

  it('hors production : simulateur enregistré seulement si TELEMETRY_SIMULATOR_ENABLED', () => {
    expect(codeOf(() => resolveAdapterFactory('SIMULATEUR', env('test', false)))).toBe('SIMULATEUR_NON_ACTIVE');
    expect(codeOf(() => resolveAdapterFactory('SIMULATEUR', env('test', true)))).toBeNull();
  });

  it('RPA refusé en V1 avec le motif documenté (D-292)', () => {
    let message = '';
    try {
      resolveAdapterFactory('RPA', env('test', true));
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(BusinessRuleError);
      expect((error as BusinessRuleError).getStatus()).toBe(422);
    }
    expect(message).toBe(RPA_REFUSAL_MESSAGE);
    expect(message).toBe('Canal RPA non disponible en V1 : interface documentée, accord écrit du fournisseur requis (D-292)');
  });

  it('configuration validée par les analyseurs des adaptateurs (422 motivé)', () => {
    expect(codeOf(() => validateProviderConfiguration('TRACCAR', 'https://traccar.example.tn', {}))).toBeNull();
    expect(codeOf(() => validateProviderConfiguration('TRACCAR', 'http://traccar.example.tn', {}))).toBe('PARAMETRES_INVALIDES');
    expect(codeOf(() => validateProviderConfiguration('TRACCAR', 'http://traccar.interne', { allowPlainHttp: true }))).toBeNull();
    expect(codeOf(() => validateProviderConfiguration('WIALON', 'https://hst-api.wialon.com', {}))).toBe('PARAMETRES_INVALIDES');
    expect(codeOf(() => validateProviderConfiguration('WIALON', 'https://hst-api.wialon.com', { odometerKind: 'DISTANCE_GPS' }))).toBeNull();
    expect(codeOf(() => validateProviderConfiguration('RAPPORT_GENERIQUE', 'https://inutile.example.tn', {}))).toBe('PARAMETRES_INVALIDES');
    expect(codeOf(() => validateProviderConfiguration('WEBHOOK_GENERIQUE', null, {}))).toBeNull();
    expect(codeOf(() => validateProviderConfiguration('WEBHOOK_GENERIQUE', null, { maxRequestsPerMinute: 1000 }))).toBe('PARAMETRES_INVALIDES');
    expect(codeOf(() => validateProviderConfiguration('WEBHOOK_GENERIQUE', 'https://inutile.example.tn', {}))).toBe('PARAMETRES_INVALIDES');
    expect(codeOf(() => validateProviderConfiguration('SIMULATEUR', null, { scenario: { units: [] } }))).toBeNull();
    expect(codeOf(() => validateProviderConfiguration('RPA', null, {}))).toBe('CANAL_RPA_INDISPONIBLE');
  });
});
