import { BusinessRuleError, type FieldErrors } from '../../../common/errors.js';
import { describeErrorSafely, redactSensitiveText } from '../../../common/secret-redaction.js';
import {
  type AdapterConfig,
  type AdapterFactory,
  type FuelSample,
  type OdometerSample,
  type ProviderFuelKind,
  type ProviderHealth,
  type ProviderOdometerKind,
  type ProviderUnit,
  ProviderError,
  type TelemetryProvider,
} from '../telemetry-provider.interface.js';
import { SIMULATOR_LABEL } from '../telemetry-settings.js';

/**
 * SIMULATEUR — données fictives (CDC 14.6, 18 ; D-292, D-303). Fournisseur de test explicitement nommé,
 * piloté par un scénario stocké dans TelemetryProvider.settings.scenario : unités et immatriculations
 * déclarées, natures remontées, séries horodatées d'échantillons odomètre (CAN/GPS) et carburant, pannes
 * (injoignable, quota 429 avec Retry-After, authentification), doublons et désordre de livraison.
 *
 * Déterministe : aucune valeur aléatoire ; seule l'horloge fournie (AdapterConfig.clock) décide quels
 * échantillons sont « déjà disponibles » (observedAt ≤ maintenant) et quelles pannes sont en cours.
 * Jamais enregistré en production (registre) et refusé à la création/activation en production (service).
 */

const ODOMETER_KINDS: readonly ProviderOdometerKind[] = ['COMPTEUR_CAN', 'DISTANCE_GPS'];
const FUEL_KINDS: readonly ProviderFuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];
const FAILURE_MODES = ['INJOIGNABLE', 'QUOTA', 'AUTHENTIFICATION'] as const;
const OPERATIONS = ['listUnits', 'getOdometers', 'getOdometerHistory', 'getFuel', 'healthCheck'] as const;
const ORDERS = ['CHRONOLOGIQUE', 'INVERSE', 'ENTRELACE'] as const;
const DECIMAL_3 = /^\d{1,12}(\.\d{1,3})?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_UNITS = 2000;
const MAX_SAMPLES = 20_000;

export type SimulatorFailureMode = (typeof FAILURE_MODES)[number];
export type SimulatorOperation = (typeof OPERATIONS)[number];

export interface SimulatorUnit {
  externalId: string;
  label: string;
  declaredRegistration: string | null;
  odometerKinds: ProviderOdometerKind[];
  fuelKinds: ProviderFuelKind[];
  /** Unité retirée chez le fournisseur à partir de cet instant (présence chez le fournisseur). */
  removedAt: Date | null;
}

export interface SimulatorFailure {
  mode: SimulatorFailureMode;
  /** Fenêtre [from, until[ de la panne ; absente = permanente. */
  from: Date | null;
  until: Date | null;
  retryAfterSeconds: number | null;
  /** Opérations touchées ; absent = toutes. */
  operations: SimulatorOperation[] | null;
}

export interface SimulatorScenario {
  units: SimulatorUnit[];
  odometerSamples: OdometerSample[];
  fuelSamples: FuelSample[];
  failures: SimulatorFailure[];
  /** Chaque échantillon livré deux fois (idempotence, T36). */
  duplicates: boolean;
  /** Ordre de livraison déterministe : chronologique, inversé ou entrelacé (désordre). */
  order: (typeof ORDERS)[number];
  /** Exige un jeton API déposé (sinon erreur d'authentification). */
  authRequired: boolean;
  /** Historique disponible (getOdometerHistory) ; faux = canal sans historique (D-294). */
  supportsHistory: boolean;
  /**
   * Reproduit un client HTTP qui cite l'URL appelée (jeton compris) dans ses erreurs : sert à vérifier
   * que le service assainit toute erreur fournisseur avant de la journaliser ou de la renvoyer (T44).
   */
  echoRequestUrlInErrors: boolean;
}

/** Lit et valide le scénario (settings.scenario) ; lève 422 avec les erreurs par champ. */
export function parseSimulatorScenario(settings: Record<string, unknown>): SimulatorScenario {
  const errors: FieldErrors = {};
  const err = (path: string, message: string) => {
    (errors[path] ??= []).push(message);
  };
  const root = settings['scenario'];
  const known = new Set(['scenario']);
  for (const key of Object.keys(settings)) if (!known.has(key)) err(`settings.${key}`, 'Paramètre inconnu pour le simulateur (seul « scenario » est admis).');
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    err('settings.scenario', 'Scénario du simulateur attendu (objet).');
    throw new BusinessRuleError('SCENARIO_INVALIDE', 'Scénario du simulateur invalide.', { fieldErrors: errors });
  }
  const s = root as Record<string, unknown>;
  const allowedKeys = new Set(['units', 'odometerSamples', 'fuelSamples', 'failures', 'duplicates', 'order', 'authRequired', 'supportsHistory', 'echoRequestUrlInErrors']);
  for (const key of Object.keys(s)) if (!allowedKeys.has(key)) err(`settings.scenario.${key}`, 'Champ inconnu.');

  const units: SimulatorUnit[] = [];
  const unitKinds = new Map<string, SimulatorUnit>();
  const rawUnits = arrayAt(s, 'units', err, 'settings.scenario.units', MAX_UNITS);
  rawUnits.forEach((raw, i) => {
    const p = `settings.scenario.units[${i}]`;
    const u = objectAt(raw, err, p);
    if (!u) return;
    const externalId = stringAt(u, 'externalId', err, p, { required: true, max: 200 });
    const label = stringAt(u, 'label', err, p, { required: true, max: 200 });
    const declaredRegistration = stringAt(u, 'declaredRegistration', err, p, { required: false, max: 50 });
    const odometerKinds = enumListAt(u, 'odometerKinds', ODOMETER_KINDS, err, p);
    const fuelKinds = enumListAt(u, 'fuelKinds', FUEL_KINDS, err, p);
    const removedAt = instantAt(u, 'removedAt', err, p, false);
    if (!externalId || !label) return;
    if (unitKinds.has(externalId)) {
      err(`${p}.externalId`, 'Identifiant d’unité en double dans le scénario.');
      return;
    }
    const unit: SimulatorUnit = { externalId, label, declaredRegistration, odometerKinds, fuelKinds, removedAt };
    unitKinds.set(externalId, unit);
    units.push(unit);
  });

  const odometerSamples: OdometerSample[] = [];
  arrayAt(s, 'odometerSamples', err, 'settings.scenario.odometerSamples', MAX_SAMPLES).forEach((raw, i) => {
    const p = `settings.scenario.odometerSamples[${i}]`;
    const o = objectAt(raw, err, p);
    if (!o) return;
    const unitExternalId = stringAt(o, 'unitExternalId', err, p, { required: true, max: 200 });
    const kind = enumAt(o, 'kind', ODOMETER_KINDS, err, p);
    const valueKm = decimalAt(o, 'valueKm', err, p, true);
    const observedAt = instantAt(o, 'observedAt', err, p, true);
    const sourceReference = stringAt(o, 'sourceReference', err, p, { required: false, max: 200 });
    if (!unitExternalId || !kind || !valueKm || !observedAt) return;
    const unit = unitKinds.get(unitExternalId);
    if (!unit) return err(`${p}.unitExternalId`, 'Unité absente du scénario.');
    if (!unit.odometerKinds.includes(kind)) return err(`${p}.kind`, `Nature ${kind} non déclarée pour l’unité ${unitExternalId}.`);
    odometerSamples.push({ unitExternalId, kind, valueKm, observedAt, sourceReference });
  });

  const fuelSamples: FuelSample[] = [];
  arrayAt(s, 'fuelSamples', err, 'settings.scenario.fuelSamples', MAX_SAMPLES).forEach((raw, i) => {
    const p = `settings.scenario.fuelSamples[${i}]`;
    const o = objectAt(raw, err, p);
    if (!o) return;
    const unitExternalId = stringAt(o, 'unitExternalId', err, p, { required: true, max: 200 });
    const kind = enumAt(o, 'kind', FUEL_KINDS, err, p);
    const liters = decimalAt(o, 'liters', err, p, false);
    const percent = decimalAt(o, 'percent', err, p, false);
    const speedKmh = decimalAt(o, 'speedKmh', err, p, false);
    const engineOn = booleanAt(o, 'engineOn', err, p, null);
    const observedAt = instantAt(o, 'observedAt', err, p, true);
    const sourceReference = stringAt(o, 'sourceReference', err, p, { required: false, max: 200 });
    if (!unitExternalId || !kind || !observedAt) return;
    if (liters === null && percent === null) return err(p, 'Litres ou pourcentage requis (aucune valeur inventée).');
    if (percent !== null && Number(percent) > 100) return err(`${p}.percent`, 'Pourcentage supérieur à 100.');
    const unit = unitKinds.get(unitExternalId);
    if (!unit) return err(`${p}.unitExternalId`, 'Unité absente du scénario.');
    if (!unit.fuelKinds.includes(kind)) return err(`${p}.kind`, `Nature ${kind} non déclarée pour l’unité ${unitExternalId}.`);
    fuelSamples.push({ unitExternalId, kind, liters, percent, engineOn, speedKmh, observedAt, sourceReference });
  });

  const failures: SimulatorFailure[] = [];
  arrayAt(s, 'failures', err, 'settings.scenario.failures', 100).forEach((raw, i) => {
    const p = `settings.scenario.failures[${i}]`;
    const f = objectAt(raw, err, p);
    if (!f) return;
    const mode = enumAt(f, 'mode', FAILURE_MODES, err, p);
    const from = instantAt(f, 'from', err, p, false);
    const until = instantAt(f, 'until', err, p, false);
    let retryAfterSeconds: number | null = null;
    if (f['retryAfterSeconds'] !== undefined && f['retryAfterSeconds'] !== null) {
      const r = f['retryAfterSeconds'];
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 86_400) err(`${p}.retryAfterSeconds`, 'Entier de 0 à 86 400 attendu.');
      else retryAfterSeconds = r;
    }
    const operations = f['operations'] === undefined || f['operations'] === null ? null : enumListAt(f, 'operations', OPERATIONS, err, p);
    if (from && until && until.getTime() <= from.getTime()) err(`${p}.until`, 'La fin de la panne doit suivre son début.');
    if (!mode) return;
    failures.push({ mode, from, until, retryAfterSeconds, operations });
  });

  const scenario: SimulatorScenario = {
    units,
    odometerSamples,
    fuelSamples,
    failures,
    duplicates: booleanAt(s, 'duplicates', err, 'settings.scenario', false) ?? false,
    order: enumAt(s, 'order', ORDERS, err, 'settings.scenario', 'CHRONOLOGIQUE') ?? 'CHRONOLOGIQUE',
    authRequired: booleanAt(s, 'authRequired', err, 'settings.scenario', false) ?? false,
    supportsHistory: booleanAt(s, 'supportsHistory', err, 'settings.scenario', true) ?? true,
    echoRequestUrlInErrors: booleanAt(s, 'echoRequestUrlInErrors', err, 'settings.scenario', false) ?? false,
  };
  if (Object.keys(errors).length > 0) throw new BusinessRuleError('SCENARIO_INVALIDE', 'Scénario du simulateur invalide.', { fieldErrors: errors });
  return scenario;
}

/** Fabrique de l'adaptateur SIMULATEUR (contrat AdapterFactory). */
export const createSimulatorAdapter: AdapterFactory = (config: AdapterConfig): TelemetryProvider => {
  const scenario = parseSimulatorScenario(config.settings);
  const now = () => (config.clock ? config.clock.now() : new Date());
  const token = config.secrets.JETON_API ?? null;
  const baseUrl = config.baseUrl ?? 'https://simulateur.invalid';
  const secrets = Object.values(config.secrets).filter((v): v is string => typeof v === 'string');

  const requestUrl = (operation: SimulatorOperation) => `${baseUrl}/api/${operation}${token ? `?token=${token}` : ''}`;

  /** Lève l'erreur de la panne scénarisée en cours pour cette opération, s'il y en a une. */
  const guard = (operation: SimulatorOperation): void => {
    const at = now().getTime();
    if (scenario.authRequired && !token) {
      throw new ProviderError('AUTHENTIFICATION', `${SIMULATOR_LABEL} : jeton API absent (le scénario exige une authentification).`);
    }
    const failure = scenario.failures.find(
      (f) => (f.from === null || f.from.getTime() <= at) && (f.until === null || at < f.until.getTime()) && (f.operations === null || f.operations.includes(operation)),
    );
    if (!failure) return;
    const where = scenario.echoRequestUrlInErrors ? ` — GET ${requestUrl(operation)}` : '';
    switch (failure.mode) {
      case 'INJOIGNABLE':
        throw new ProviderError('INJOIGNABLE', `${SIMULATOR_LABEL} : fournisseur injoignable (connexion refusée)${where}`);
      case 'QUOTA':
        throw new ProviderError('QUOTA', `${SIMULATOR_LABEL} : quota dépassé (HTTP 429, Retry-After ${failure.retryAfterSeconds ?? 60} s)${where}`, failure.retryAfterSeconds ?? 60);
      case 'AUTHENTIFICATION':
        throw new ProviderError('AUTHENTIFICATION', `${SIMULATOR_LABEL} : authentification refusée (HTTP 401)${where}`);
    }
  };

  const present = (u: SimulatorUnit) => u.removedAt === null || now().getTime() < u.removedAt.getTime();
  const wanted = (ids: readonly string[]) => {
    const set = new Set(ids);
    return new Set(scenario.units.filter((u) => set.has(u.externalId) && present(u)).map((u) => u.externalId));
  };
  const available = (observedAt: Date) => observedAt.getTime() <= now().getTime();

  const provider: TelemetryProvider = {
    listUnits(): Promise<ProviderUnit[]> {
      return settle(() => {
        guard('listUnits');
        return scenario.units.filter(present).map((u) => ({
          externalId: u.externalId,
          label: `SIMULATEUR — ${u.label}`,
          declaredRegistration: u.declaredRegistration,
          odometerKinds: [...u.odometerKinds],
          fuelKinds: [...u.fuelKinds],
        }));
      });
    },
    getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]> {
      return settle(() => {
        guard('getOdometers');
        const ids = wanted(unitExternalIds);
        const latest = new Map<string, OdometerSample>();
        for (const sample of scenario.odometerSamples) {
          if (!ids.has(sample.unitExternalId) || !available(sample.observedAt)) continue;
          const key = `${sample.unitExternalId}|${sample.kind}`;
          const current = latest.get(key);
          if (!current || current.observedAt.getTime() < sample.observedAt.getTime()) latest.set(key, sample);
        }
        return deliver([...latest.values()], scenario);
      });
    },
    getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]> {
      return settle(() => {
        guard('getFuel');
        const ids = wanted(unitExternalIds);
        return deliver(
          scenario.fuelSamples.filter((s) => ids.has(s.unitExternalId) && available(s.observedAt) && s.observedAt.getTime() >= from.getTime() && s.observedAt.getTime() <= to.getTime()),
          scenario,
        );
      });
    },
    healthCheck(): Promise<ProviderHealth> {
      const checkedAt = now();
      try {
        guard('healthCheck');
      } catch (error) {
        return Promise.resolve({ ok: false, message: describeErrorSafely(error, secrets), latencyMs: null, checkedAt });
      }
      const count = scenario.units.filter(present).length;
      return Promise.resolve({ ok: true, message: redactSensitiveText(`${SIMULATOR_LABEL} : ${count} unité(s) simulée(s) disponible(s).`, secrets), latencyMs: null, checkedAt });
    },
  };
  if (scenario.supportsHistory) {
    provider.getOdometerHistory = (unitExternalIds: string[], from: Date, to: Date): Promise<OdometerSample[]> =>
      settle(() => {
        guard('getOdometerHistory');
        const ids = wanted(unitExternalIds);
        return deliver(
          scenario.odometerSamples.filter((s) => ids.has(s.unitExternalId) && available(s.observedAt) && s.observedAt.getTime() >= from.getTime() && s.observedAt.getTime() <= to.getTime()),
          scenario,
        );
      });
  }
  return provider;
};

/** Ordre de livraison déterministe, puis doublons éventuels (copies indépendantes). */
function deliver<T extends { observedAt: Date; unitExternalId: string; kind: string }>(samples: readonly T[], scenario: SimulatorScenario): T[] {
  const sorted = [...samples].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.unitExternalId.localeCompare(b.unitExternalId) || a.kind.localeCompare(b.kind),
  );
  let ordered: T[];
  if (scenario.order === 'INVERSE') ordered = sorted.reverse();
  else if (scenario.order === 'ENTRELACE') ordered = [...sorted.filter((_, i) => i % 2 === 1), ...sorted.filter((_, i) => i % 2 === 0)];
  else ordered = sorted;
  const copy = (s: T): T => ({ ...s, observedAt: new Date(s.observedAt.getTime()) });
  return scenario.duplicates ? ordered.flatMap((s) => [copy(s), copy(s)]) : ordered.map(copy);
}

function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

type Err = (path: string, message: string) => void;

function objectAt(raw: unknown, err: Err, path: string): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    err(path, 'Objet attendu.');
    return null;
  }
  return raw as Record<string, unknown>;
}

function arrayAt(o: Record<string, unknown>, key: string, err: Err, path: string, max: number): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    err(path, 'Liste attendue.');
    return [];
  }
  if (v.length > max) {
    err(path, `Au plus ${max} éléments.`);
    return [];
  }
  return v;
}

function stringAt(o: Record<string, unknown>, key: string, err: Err, path: string, opts: { required: boolean; max: number }): string | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opts.required) err(`${path}.${key}`, 'Ce champ est obligatoire.');
    return null;
  }
  if (typeof v !== 'string' || v.trim().length === 0) {
    err(`${path}.${key}`, 'Chaîne non vide attendue.');
    return null;
  }
  if (v.length > opts.max) {
    err(`${path}.${key}`, `${opts.max} caractères au plus.`);
    return null;
  }
  return v.trim();
}

function enumAt<T extends string>(o: Record<string, unknown>, key: string, values: readonly T[], err: Err, path: string, fallback?: T): T | null {
  const v = o[key];
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    err(`${path}.${key}`, `Valeur attendue parmi : ${values.join(', ')}.`);
    return null;
  }
  return v as T;
}

function enumListAt<T extends string>(o: Record<string, unknown>, key: string, values: readonly T[], err: Err, path: string): T[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(values as readonly string[]).includes(x))) {
    err(`${path}.${key}`, `Liste de valeurs parmi : ${values.join(', ')}.`);
    return [];
  }
  return [...new Set(v as T[])];
}

function decimalAt(o: Record<string, unknown>, key: string, err: Err, path: string, required: boolean): string | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) err(`${path}.${key}`, 'Ce champ est obligatoire.');
    return null;
  }
  if (typeof v !== 'string' || !DECIMAL_3.test(v)) {
    err(`${path}.${key}`, 'Nombre décimal positif en chaîne attendu (3 décimales au plus).');
    return null;
  }
  return v;
}

function booleanAt(o: Record<string, unknown>, key: string, err: Err, path: string, fallback: boolean | null): boolean | null {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    err(`${path}.${key}`, 'Valeur vrai/faux attendue.');
    return fallback;
  }
  return v;
}

function instantAt(o: Record<string, unknown>, key: string, err: Err, path: string, required: boolean): Date | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) err(`${path}.${key}`, 'Horodatage obligatoire (instant du fournisseur).');
    return null;
  }
  if (typeof v !== 'string' || !ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
    err(`${path}.${key}`, 'Instant ISO 8601 avec fuseau attendu (ex. 2026-09-24T08:00:00Z).');
    return null;
  }
  return new Date(v);
}
