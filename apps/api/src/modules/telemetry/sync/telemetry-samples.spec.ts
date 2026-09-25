import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { FuelSample, OdometerSample } from '../telemetry-provider.interface.js';
import { downsampleFuel, fallbackSourceReference, normalizeFuelSamples, normalizeOdometerSamples, summarizeCounts } from './telemetry-samples.js';

const NOW = new Date('2026-09-24T10:00:00Z');
const units = new Set(['U-1']);

function odo(overrides: Partial<OdometerSample> = {}): OdometerSample {
  return { unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '50000.000', observedAt: new Date('2026-09-24T09:00:00Z'), sourceReference: null, ...overrides };
}

describe('Normalisation des échantillons télématiques (D-184, D-195, D-239, D-294)', () => {
  it('référence de repli déterministe : même unité, nature, instant et valeur → même clé ; valeur différente → autre clé', () => {
    const base = { providerId: 'p', unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', observedAt: new Date('2026-09-24T09:00:00Z') };
    const a = fallbackSourceReference({ ...base, valueKm: new Decimal('50000') });
    expect(a).toBe(fallbackSourceReference({ ...base, valueKm: new Decimal('50000.000') }));
    expect(a).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(a).not.toBe(fallbackSourceReference({ ...base, valueKm: new Decimal('50000.001') }));
    expect(a).not.toBe(fallbackSourceReference({ ...base, providerId: 'q', valueKm: new Decimal('50000') }));
  });

  it('écarte sans les remplacer les valeurs invalides, l’horodatage absent ou futur et les unités non demandées ; compte doublons et conflits', () => {
    const report = normalizeOdometerSamples(
      [
        odo({ sourceReference: 'ref-1' }),
        odo({ sourceReference: 'ref-1' }),
        odo({ valueKm: '50001', observedAt: new Date('2026-09-24T09:00:00Z') }),
        odo({ observedAt: new Date('2026-09-24T09:30:00Z'), valueKm: '-3' }),
        odo({ observedAt: new Date('2026-09-24T09:31:00Z'), valueKm: '12.3456' }),
        odo({ observedAt: new Date('invalid') }),
        odo({ observedAt: new Date('2026-09-24T10:30:00Z') }),
        odo({ unitExternalId: 'U-9' }),
        odo({ kind: 'DISTANCE_GPS', valueKm: '12000', observedAt: new Date('2026-09-24T08:00:00Z') }),
      ],
      { providerId: 'p', unitExternalIds: units, now: NOW },
    );
    expect(report.samples.map((s) => [s.kind, s.valueKm.toString(), s.observedAt.toISOString(), s.providerReference])).toEqual([
      ['DISTANCE_GPS', '12000', '2026-09-24T08:00:00.000Z', false],
      ['COMPTEUR_CAN', '50000', '2026-09-24T09:00:00.000Z', true],
    ]);
    expect(report.samples[1]?.sourceReference).toBe('ref-1');
    expect(report.samples[0]?.sourceReference).toMatch(/^fp:/);
    expect(report.duplicates).toBe(1);
    expect(report.conflicts).toBe(1);
    expect(report.rejected).toEqual({ 'valeur kilométrique invalide': 2, 'horodatage fournisseur absent': 1, 'horodatage dans le futur': 1, 'unité non demandée': 1 });
  });

  it('carburant : litres ou pourcentage exigés, pourcentage ≤ 100, contact et vitesse conservés tels quels', () => {
    const fuel = (o: Partial<FuelSample>): FuelSample => ({ unitExternalId: 'U-1', kind: 'NIVEAU_SONDE', liters: '60', percent: null, engineOn: false, speedKmh: '0', observedAt: new Date('2026-09-24T09:00:00Z'), sourceReference: null, ...o });
    const report = normalizeFuelSamples(
      [fuel({}), fuel({ observedAt: new Date('2026-09-24T09:05:00Z'), liters: null, percent: '120' }), fuel({ observedAt: new Date('2026-09-24T09:10:00Z'), liters: null, percent: null }), fuel({ observedAt: new Date('2026-09-24T09:15:00Z'), engineOn: null, speedKmh: null })],
      { unitExternalIds: units, now: NOW },
    );
    expect(report.samples).toHaveLength(2);
    expect(report.samples[1]).toMatchObject({ engineOn: null, speedKmh: null });
    expect(report.rejected).toEqual({ 'niveau de carburant invalide': 2 });
  });

  it('sous-échantillonnage : au plus un échantillon par tranche de 5 min, le dernier de la tranche', () => {
    const points = ['09:00:00', '09:02:00', '09:04:59', '09:05:00', '09:12:00'].map((t) => ({ observedAt: new Date(`2026-09-24T${t}Z`) }));
    expect(downsampleFuel(points, 5).map((k) => k.sample.observedAt.toISOString().slice(11, 19))).toEqual(['09:04:59', '09:05:00', '09:12:00']);
  });

  it('résumé des motifs trié et borné, sans contenu brut', () => {
    expect(summarizeCounts({ b: 1, a: 3, c: 0 })).toBe('3 × a ; 1 × b');
    expect(summarizeCounts({})).toBeNull();
  });
});
