import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { FuelSample, OdometerSample, ProviderFuelKind, ProviderOdometerKind } from '../telemetry-provider.interface.js';

/**
 * Normalisation et clés d'idempotence des échantillons reçus d'un adaptateur (CDC 5.6 ; D-184, D-195,
 * D-294) — règles uniques, pures :
 *  - valeur décimale exacte (3 décimales au plus), jamais négative ; horodatage fournisseur obligatoire,
 *    jamais dans le futur au-delà de la tolérance d'horloge (receivedAt ne remplace jamais observedAt) ;
 *  - sourceReference du fournisseur si elle existe, sinon référence de repli déterministe
 *    « fp: » + SHA-256(fournisseur | unité | nature | observedAt en ms | valeur à 3 décimales) : l'index
 *    unique (fournisseur, unité, sourceReference) couvre ainsi les deux clés de 5.6 (T36) ;
 *  - doublons d'un même lot (même unité, nature et instant) : même valeur = doublon ignoré, valeur
 *    différente = conflit compté, le premier reçu est conservé.
 */

/** Tolérance d'horloge pour un horodatage fournisseur légèrement en avance (identique aux relevés). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DECIMAL_3 = /^\d{1,12}(\.\d{1,3})?$/;

export interface NormalizedOdometerSample {
  unitExternalId: string;
  kind: ProviderOdometerKind;
  valueKm: Decimal;
  observedAt: Date;
  sourceReference: string;
  /** Vrai si la référence est celle du fournisseur (faux : référence de repli fp:). */
  providerReference: boolean;
}

export interface NormalizedFuelSample {
  unitExternalId: string;
  kind: ProviderFuelKind;
  liters: Decimal | null;
  percent: Decimal | null;
  engineOn: boolean | null;
  speedKmh: Decimal | null;
  observedAt: Date;
}

export interface NormalizationReport<T> {
  samples: T[];
  /** Échantillons écartés, par motif en français (jamais de contenu brut du fournisseur). */
  rejected: Record<string, number>;
  duplicates: number;
  conflicts: number;
}

/** Référence de repli déterministe (D-184, D-195). */
export function fallbackSourceReference(input: { providerId: string; unitExternalId: string; kind: string; observedAt: Date; valueKm: Decimal }): string {
  const payload = [input.providerId, input.unitExternalId, input.kind, String(input.observedAt.getTime()), input.valueKm.toFixed(3)].join('|');
  return `fp:${createHash('sha256').update(payload).digest('hex')}`;
}

function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string' || !DECIMAL_3.test(value.trim())) return null;
  return new Decimal(value.trim());
}

function validInstant(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function count(map: Record<string, number>, reason: string): void {
  map[reason] = (map[reason] ?? 0) + 1;
}

/**
 * Échantillons d'odomètre valides des unités attendues, triés par instant ; doublons et conflits
 * comptés (le premier reçu est conservé).
 */
export function normalizeOdometerSamples(raw: readonly OdometerSample[], options: { providerId: string; unitExternalIds: ReadonlySet<string>; now: Date }): NormalizationReport<NormalizedOdometerSample> {
  const rejected: Record<string, number> = {};
  const byKey = new Map<string, NormalizedOdometerSample>();
  let duplicates = 0;
  let conflicts = 0;
  for (const s of raw) {
    if (!options.unitExternalIds.has(s.unitExternalId)) {
      count(rejected, 'unité non demandée');
      continue;
    }
    if (s.kind !== 'COMPTEUR_CAN' && s.kind !== 'DISTANCE_GPS') {
      count(rejected, 'nature de kilométrage inconnue');
      continue;
    }
    if (!validInstant(s.observedAt)) {
      count(rejected, 'horodatage fournisseur absent');
      continue;
    }
    if (s.observedAt.getTime() > options.now.getTime() + FUTURE_TOLERANCE_MS) {
      count(rejected, 'horodatage dans le futur');
      continue;
    }
    const valueKm = parseDecimal(s.valueKm);
    if (!valueKm) {
      count(rejected, 'valeur kilométrique invalide');
      continue;
    }
    const providerReference = typeof s.sourceReference === 'string' && s.sourceReference.trim().length > 0 && s.sourceReference.length <= 200;
    const sourceReference = providerReference
      ? (s.sourceReference as string).trim()
      : fallbackSourceReference({ providerId: options.providerId, unitExternalId: s.unitExternalId, kind: s.kind, observedAt: s.observedAt, valueKm });
    const key = `${s.unitExternalId}|${s.kind}|${s.observedAt.getTime()}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.valueKm.eq(valueKm)) duplicates += 1;
      else conflicts += 1;
      continue;
    }
    byKey.set(key, { unitExternalId: s.unitExternalId, kind: s.kind, valueKm, observedAt: new Date(s.observedAt.getTime()), sourceReference, providerReference });
  }
  const samples = [...byKey.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.kind.localeCompare(b.kind));
  return { samples, rejected, duplicates, conflicts };
}

/** Échantillons carburant valides des unités attendues (litres ou pourcentage exigé), triés par instant. */
export function normalizeFuelSamples(raw: readonly FuelSample[], options: { unitExternalIds: ReadonlySet<string>; now: Date }): NormalizationReport<NormalizedFuelSample> {
  const rejected: Record<string, number> = {};
  const byKey = new Map<string, NormalizedFuelSample>();
  let duplicates = 0;
  let conflicts = 0;
  for (const s of raw) {
    if (!options.unitExternalIds.has(s.unitExternalId)) {
      count(rejected, 'unité non demandée');
      continue;
    }
    if (s.kind !== 'NIVEAU_CAN' && s.kind !== 'NIVEAU_SONDE' && s.kind !== 'CONSOMMATION_CAN') {
      count(rejected, 'nature de carburant inconnue');
      continue;
    }
    if (!validInstant(s.observedAt)) {
      count(rejected, 'horodatage fournisseur absent');
      continue;
    }
    if (s.observedAt.getTime() > options.now.getTime() + FUTURE_TOLERANCE_MS) {
      count(rejected, 'horodatage dans le futur');
      continue;
    }
    const liters = s.liters === null ? null : parseDecimal(s.liters);
    const percent = s.percent === null ? null : parseDecimal(s.percent);
    if ((s.liters !== null && !liters) || (s.percent !== null && !percent) || (!liters && !percent) || (percent && percent.gt(100))) {
      count(rejected, 'niveau de carburant invalide');
      continue;
    }
    const speedKmh = s.speedKmh === null ? null : parseDecimal(s.speedKmh);
    if (s.speedKmh !== null && !speedKmh) {
      count(rejected, 'vitesse invalide');
      continue;
    }
    const key = `${s.unitExternalId}|${s.kind}|${s.observedAt.getTime()}`;
    const existing = byKey.get(key);
    if (existing) {
      const same = String(existing.liters) === String(liters) && String(existing.percent) === String(percent);
      if (same) duplicates += 1;
      else conflicts += 1;
      continue;
    }
    byKey.set(key, { unitExternalId: s.unitExternalId, kind: s.kind, liters, percent, engineOn: typeof s.engineOn === 'boolean' ? s.engineOn : null, speedKmh, observedAt: new Date(s.observedAt.getTime()) });
  }
  const samples = [...byKey.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return { samples, rejected, duplicates, conflicts };
}

/**
 * Sous-échantillonnage carburant (CDC 8.5, 17.1 ; D-239) : au plus un échantillon stocké par unité,
 * nature et tranche de `stepMinutes` alignée sur UTC ; le dernier échantillon reçu de la tranche est
 * retenu. Renvoie l'indice de tranche de chaque échantillon retenu.
 */
export function fuelBucket(observedAt: Date, stepMinutes: number): number {
  return Math.floor(observedAt.getTime() / (Math.max(1, stepMinutes) * 60_000));
}

export function downsampleFuel<T extends { observedAt: Date }>(samples: readonly T[], stepMinutes: number): Array<{ sample: T; bucket: number }> {
  const byBucket = new Map<number, T>();
  for (const s of [...samples].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())) byBucket.set(fuelBucket(s.observedAt, stepMinutes), s);
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, sample]) => ({ sample, bucket }));
}

/** Fusionne des compteurs de motifs. */
export function mergeCounts(target: Record<string, number>, source: Record<string, number>): Record<string, number> {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
  return target;
}

/** Résumé français expurgé des motifs d'écart (« 3 horodatage dans le futur ; 1 conflit de valeur »). */
export function summarizeCounts(counts: Record<string, number>, max = 12): string | null {
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([k, v]) => `${v} × ${k}`);
  return parts.length > 0 ? parts.join(' ; ') : null;
}
