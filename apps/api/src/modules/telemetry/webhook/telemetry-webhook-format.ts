import type { FieldErrors } from '../../../common/errors.js';
import { type FuelSample, type OdometerSample, ProviderError, type ProviderFuelKind, type ProviderOdometerKind, type ProviderUnit } from '../telemetry-provider.interface.js';

/**
 * Format JSON des lots poussés par un fournisseur (canal WEBHOOK, D-298) et paramètres du canal — une
 * seule implémentation, utilisée par l'API (contrôle à la réception) et par le worker (ingestion).
 *
 * Le lot reprend la forme normalisée du contrat des adaptateurs (TelemetryProvider) :
 *  {
 *    "version": 1,
 *    "units":     [{ "externalId", "label"?, "registration"?, "odometerKinds"?, "fuelKinds"? }],
 *    "odometers": [{ "unitExternalId", "kind": "COMPTEUR_CAN"|"DISTANCE_GPS", "valueKm", "observedAt", "sourceReference"? }],
 *    "fuel":      [{ "unitExternalId", "kind": "NIVEAU_CAN"|"NIVEAU_SONDE"|"CONSOMMATION_CAN", "liters"?, "percent"?,
 *                   "engineOn"?, "speedKmh"?, "observedAt", "sourceReference"? }]
 *  }
 *  - kilomètres, litres, pourcentages et vitesses : décimaux (chaîne recommandée, 3 décimales au plus) ;
 *  - observedAt : instant ISO 8601 avec décalage explicite (« Z » ou ±hh:mm), horodatage du fournisseur ;
 *  - tout champ non prévu est ignoré et n'est pas conservé (le lot stocké ne contient que ces champs).
 * Les contrôles propres à l'ingestion (unité associée, instant couvert, horodatage futur, doublons) restent
 * ceux de la synchronisation (telemetry-samples.ts), appliqués par le worker.
 */

export const WEBHOOK_FORMAT_VERSION = 1;
/** Taille maximale du corps brut d'un lot (413 au-delà). */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const WEBHOOK_MAX_UNITS = 1000;
export const WEBHOOK_MAX_SAMPLES = 5000;
/** Lots en attente de traitement au plus par fournisseur (429 au-delà : file pleine). */
export const WEBHOOK_MAX_PENDING = 500;
/** Longueur minimale et jeu de caractères d'un secret de signature (≥ 32 caractères imprimables, sans espace). */
export const WEBHOOK_SECRET_PATTERN = /^[\x21-\x7e]{32,256}$/;

const MAX_FIELD_ERRORS = 20;
const DECIMAL_3 = /^\d{1,12}(\.\d{1,3})?$/;
/** Instant ISO 8601 avec décalage explicite (jamais une heure locale ambiguë). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ODOMETER_KINDS: readonly ProviderOdometerKind[] = ['COMPTEUR_CAN', 'DISTANCE_GPS'];
const FUEL_KINDS: readonly ProviderFuelKind[] = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'];

export interface WebhookUnit {
  externalId: string;
  label: string | null;
  registration: string | null;
  odometerKinds: ProviderOdometerKind[];
  fuelKinds: ProviderFuelKind[];
}

export interface WebhookOdometer {
  unitExternalId: string;
  kind: ProviderOdometerKind;
  valueKm: string;
  /** Instant UTC normalisé (toISOString). */
  observedAt: string;
  sourceReference: string | null;
}

export interface WebhookFuel {
  unitExternalId: string;
  kind: ProviderFuelKind;
  liters: string | null;
  percent: string | null;
  engineOn: boolean | null;
  speedKmh: string | null;
  observedAt: string;
  sourceReference: string | null;
}

/** Lot normalisé, tel que stocké dans la file (TelemetryWebhookDelivery.payload). */
export interface WebhookBatch {
  version: typeof WEBHOOK_FORMAT_VERSION;
  units: WebhookUnit[];
  odometers: WebhookOdometer[];
  fuel: WebhookFuel[];
}

export type WebhookParseResult = { ok: true; batch: WebhookBatch } | { ok: false; fieldErrors: FieldErrors };

/** Contrôle et normalisation d'un lot (corps JSON déjà décodé). */
export function parseWebhookBatch(raw: unknown): WebhookParseResult {
  const errors: FieldErrors = {};
  let count = 0;
  const fail = (field: string, message: string): void => {
    if (count >= MAX_FIELD_ERRORS) return;
    count += 1;
    (errors[field] ??= []).push(message);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, fieldErrors: { body: ['Le lot doit être un objet JSON.'] } };
  }
  const body = raw as Record<string, unknown>;
  if (body['version'] !== WEBHOOK_FORMAT_VERSION) fail('version', `Version du format attendue : ${WEBHOOK_FORMAT_VERSION}.`);

  const units: WebhookUnit[] = [];
  for (const [i, u] of list(body['units'], 'units', WEBHOOK_MAX_UNITS, fail)) {
    const at = `units[${i}]`;
    if (!isObject(u)) {
      fail(at, 'Objet attendu.');
      continue;
    }
    const externalId = text(u['externalId'], 200);
    if (!externalId) fail(`${at}.externalId`, 'Identifiant d’unité obligatoire (200 caractères au plus).');
    const label = optionalText(u['label'], 200, `${at}.label`, fail);
    const registration = optionalText(u['registration'], 50, `${at}.registration`, fail);
    const odometerKinds = kindList(u['odometerKinds'], ODOMETER_KINDS, `${at}.odometerKinds`, fail);
    const fuelKinds = kindList(u['fuelKinds'], FUEL_KINDS, `${at}.fuelKinds`, fail);
    if (externalId) units.push({ externalId, label, registration, odometerKinds, fuelKinds });
  }

  const odometers: WebhookOdometer[] = [];
  for (const [i, s] of list(body['odometers'], 'odometers', WEBHOOK_MAX_SAMPLES, fail)) {
    const at = `odometers[${i}]`;
    if (!isObject(s)) {
      fail(at, 'Objet attendu.');
      continue;
    }
    const unitExternalId = text(s['unitExternalId'], 200);
    if (!unitExternalId) fail(`${at}.unitExternalId`, 'Identifiant d’unité obligatoire.');
    const kind = ODOMETER_KINDS.find((k) => k === s['kind']);
    if (!kind) fail(`${at}.kind`, `Nature attendue : ${ODOMETER_KINDS.join(' ou ')}.`);
    const valueKm = decimal(s['valueKm']);
    if (valueKm === null) fail(`${at}.valueKm`, 'Kilométrage décimal positif attendu (3 décimales au plus).');
    const observedAt = instant(s['observedAt']);
    if (!observedAt) fail(`${at}.observedAt`, 'Instant ISO 8601 avec décalage explicite attendu (ex. 2026-09-24T08:00:00Z).');
    const sourceReference = optionalText(s['sourceReference'], 200, `${at}.sourceReference`, fail);
    if (unitExternalId && kind && valueKm !== null && observedAt) odometers.push({ unitExternalId, kind, valueKm, observedAt, sourceReference });
  }

  const fuel: WebhookFuel[] = [];
  for (const [i, s] of list(body['fuel'], 'fuel', WEBHOOK_MAX_SAMPLES, fail)) {
    const at = `fuel[${i}]`;
    if (!isObject(s)) {
      fail(at, 'Objet attendu.');
      continue;
    }
    const unitExternalId = text(s['unitExternalId'], 200);
    if (!unitExternalId) fail(`${at}.unitExternalId`, 'Identifiant d’unité obligatoire.');
    const kind = FUEL_KINDS.find((k) => k === s['kind']);
    if (!kind) fail(`${at}.kind`, `Nature attendue : ${FUEL_KINDS.join(', ')}.`);
    const liters = optionalDecimal(s['liters'], `${at}.liters`, 'Litres décimaux positifs attendus.', fail);
    const percent = optionalDecimal(s['percent'], `${at}.percent`, 'Pourcentage décimal entre 0 et 100 attendu.', fail);
    if (percent !== null && percent !== undefined && Number(percent) > 100) fail(`${at}.percent`, 'Pourcentage décimal entre 0 et 100 attendu.');
    if (liters === null && percent === null) fail(at, 'Litres ou pourcentage obligatoire.');
    const speedKmh = optionalDecimal(s['speedKmh'], `${at}.speedKmh`, 'Vitesse décimale positive attendue.', fail);
    const engine = s['engineOn'];
    if (engine !== undefined && engine !== null && typeof engine !== 'boolean') fail(`${at}.engineOn`, 'Booléen attendu.');
    const observedAt = instant(s['observedAt']);
    if (!observedAt) fail(`${at}.observedAt`, 'Instant ISO 8601 avec décalage explicite attendu (ex. 2026-09-24T08:00:00Z).');
    const sourceReference = optionalText(s['sourceReference'], 200, `${at}.sourceReference`, fail);
    if (unitExternalId && kind && observedAt && liters !== undefined && percent !== undefined && speedKmh !== undefined && (liters !== null || percent !== null)) {
      fuel.push({ unitExternalId, kind, liters, percent, engineOn: typeof engine === 'boolean' ? engine : null, speedKmh, observedAt, sourceReference });
    }
  }

  if (count > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, batch: { version: WEBHOOK_FORMAT_VERSION, units, odometers, fuel } };
}

/** Relit un lot stocké dans la file (déjà contrôlé à la réception ; contrôlé de nouveau par sûreté). */
export function storedBatch(payload: unknown): WebhookBatch | null {
  const parsed = parseWebhookBatch(payload);
  return parsed.ok ? parsed.batch : null;
}

/** Unités déclarées ou constatées dans des lots (natures remontées réellement). */
export function batchUnits(batches: readonly WebhookBatch[]): ProviderUnit[] {
  const byId = new Map<string, ProviderUnit>();
  const ensure = (externalId: string): ProviderUnit => {
    let unit = byId.get(externalId);
    if (!unit) {
      unit = { externalId, label: externalId, declaredRegistration: null, odometerKinds: [], fuelKinds: [] };
      byId.set(externalId, unit);
    }
    return unit;
  };
  for (const batch of batches) {
    for (const u of batch.units) {
      const unit = ensure(u.externalId);
      if (u.label) unit.label = u.label;
      if (u.registration) unit.declaredRegistration = u.registration;
      for (const k of u.odometerKinds) if (!unit.odometerKinds.includes(k)) unit.odometerKinds.push(k);
      for (const k of u.fuelKinds) if (!unit.fuelKinds.includes(k)) unit.fuelKinds.push(k);
    }
    for (const s of batch.odometers) {
      const unit = ensure(s.unitExternalId);
      if (!unit.odometerKinds.includes(s.kind)) unit.odometerKinds.push(s.kind);
    }
    for (const s of batch.fuel) {
      const unit = ensure(s.unitExternalId);
      if (!unit.fuelKinds.includes(s.kind)) unit.fuelKinds.push(s.kind);
    }
  }
  return [...byId.values()];
}

/** Échantillons au format du contrat des adaptateurs (instants en Date). */
export function batchOdometerSamples(batch: WebhookBatch): OdometerSample[] {
  return batch.odometers.map((s) => ({ unitExternalId: s.unitExternalId, kind: s.kind, valueKm: s.valueKm, observedAt: new Date(s.observedAt), sourceReference: s.sourceReference }));
}

export function batchFuelSamples(batch: WebhookBatch): FuelSample[] {
  return batch.fuel.map((s) => ({
    unitExternalId: s.unitExternalId,
    kind: s.kind,
    liters: s.liters,
    percent: s.percent,
    engineOn: s.engineOn,
    speedKmh: s.speedKmh,
    observedAt: new Date(s.observedAt),
    sourceReference: s.sourceReference,
  }));
}

// ---------------------------------------------------------------------------------------------
// Paramètres non secrets du canal WEBHOOK (TelemetryProvider.settings)
// ---------------------------------------------------------------------------------------------

export interface WebhookSettings {
  /** Lots acceptés au plus par minute glissante pour ce fournisseur (429 au-delà). */
  maxRequestsPerMinute: number;
  /** Écart maximal admis entre l'horodatage signé et l'horloge du serveur. */
  toleranceSeconds: number;
  /** Durée pendant laquelle l'ancien secret reste accepté après une rotation (0 : aucune). */
  rotationOverlapHours: number;
}

export const WEBHOOK_SETTINGS_BOUNDS = {
  maxRequestsPerMinute: { min: 1, max: 600, default: 60 },
  toleranceSeconds: { min: 60, max: 900, default: 300 },
  rotationOverlapHours: { min: 0, max: 168, default: 24 },
} as const satisfies Record<keyof WebhookSettings, { min: number; max: number; default: number }>;

/** Paramètres du canal (valeurs par défaut documentées) ; ProviderError CONFIGURATION si invalides. */
export function parseWebhookSettings(settings: Record<string, unknown>): WebhookSettings {
  const known = Object.keys(WEBHOOK_SETTINGS_BOUNDS);
  const unknown = Object.keys(settings).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new ProviderError('CONFIGURATION', `Paramètres inconnus pour le canal webhook : ${unknown.join(', ')} (attendus : ${known.join(', ')}).`);
  const read = (key: keyof WebhookSettings): number => {
    const bounds = WEBHOOK_SETTINGS_BOUNDS[key];
    const value = settings[key];
    if (value === undefined || value === null) return bounds.default;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new ProviderError('CONFIGURATION', `${key} : entier entre ${bounds.min} et ${bounds.max} attendu.`);
    }
    return value;
  };
  return { maxRequestsPerMinute: read('maxRequestsPerMinute'), toleranceSeconds: read('toleranceSeconds'), rotationOverlapHours: read('rotationOverlapHours') };
}

/** Paramètres effectifs d'un fournisseur enregistré (valeurs par défaut si la configuration est illisible). */
export function effectiveWebhookSettings(settings: unknown): WebhookSettings {
  try {
    return parseWebhookSettings(isObject(settings) ? settings : {});
  } catch {
    return { maxRequestsPerMinute: WEBHOOK_SETTINGS_BOUNDS.maxRequestsPerMinute.default, toleranceSeconds: WEBHOOK_SETTINGS_BOUNDS.toleranceSeconds.default, rotationOverlapHours: WEBHOOK_SETTINGS_BOUNDS.rotationOverlapHours.default };
  }
}

// ---------------------------------------------------------------------------------------------
// Aides de lecture
// ---------------------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown, field: string, max: number, fail: (field: string, message: string) => void): Array<[number, unknown]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(field, 'Tableau attendu.');
    return [];
  }
  if (value.length > max) {
    fail(field, `${max} éléments au plus par lot : découpez l’envoi.`);
    return [];
  }
  return value.map((v, i) => [i, v] as [number, unknown]);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function optionalText(value: unknown, max: number, field: string, fail: (field: string, message: string) => void): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    fail(field, `Texte de ${max} caractères au plus attendu.`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function kindList<T extends string>(value: unknown, allowed: readonly T[], field: string, fail: (field: string, message: string) => void): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => !allowed.includes(v as T))) {
    fail(field, `Liste attendue parmi : ${allowed.join(', ')}.`);
    return [];
  }
  return [...new Set(value as T[])];
}

/** Décimal positif à 3 décimales au plus (chaîne, ou nombre fini converti sans perte d'écriture). */
function decimal(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return DECIMAL_3.test(trimmed) ? trimmed : null;
}

/** Décimal facultatif : undefined si invalide (erreur signalée), null si absent. */
function optionalDecimal(value: unknown, field: string, message: string, fail: (field: string, message: string) => void): string | null | undefined {
  if (value === undefined || value === null) return null;
  const parsed = decimal(value);
  if (parsed === null) {
    fail(field, message);
    return undefined;
  }
  return parsed;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
