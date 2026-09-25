import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { historizationReason, planThresholds } from './historization.js';

const d = (v: number) => new Decimal(v);
const base = { timezone: 'Africa/Tunis', firstAfterMappingOrSilence: false, minIntervalMinutes: 60, thresholdsKm: [] as Decimal[] };

describe('Historisation des relevés automatiques (CDC 5.6, D-181 — T42)', () => {
  const last = { km: d(89_000), observedAt: new Date('2026-09-24T08:00:00Z') };
  it('premier échantillon après confirmation du mapping', () => {
    expect(historizationReason({ ...base, sampleKm: d(89_000), observedAt: new Date('2026-09-24T08:00:00Z'), lastHistorized: null })).toBe('PREMIER');
  });
  it('au plus une fois par heure s’il a progressé ; rien sinon', () => {
    expect(historizationReason({ ...base, sampleKm: d(89_010), observedAt: new Date('2026-09-24T08:30:00Z'), lastHistorized: last })).toBeNull();
    expect(historizationReason({ ...base, sampleKm: d(89_010), observedAt: new Date('2026-09-24T09:00:00Z'), lastHistorized: last })).toBe('HORAIRE');
    expect(historizationReason({ ...base, sampleKm: d(89_000), observedAt: new Date('2026-09-24T10:00:00Z'), lastHistorized: last })).toBeNull();
  });
  it('premier échantillon du jour local, même sans progression (00:30 à Tunis = 23:30 UTC la veille)', () => {
    expect(historizationReason({ ...base, sampleKm: d(89_000), observedAt: new Date('2026-09-24T23:30:00Z'), lastHistorized: last })).toBe('QUOTIDIEN');
  });
  it('T42 — le franchissement d’un seuil d’entretien est historisé immédiatement (89 500 puis 90 000)', () => {
    const thresholds = planThresholds(d(90_000), d(500));
    expect(thresholds.map(String)).toEqual(['89500', '90000', '90001']);
    const l = { km: d(89_400), observedAt: new Date('2026-09-24T08:00:00Z') };
    expect(historizationReason({ ...base, thresholdsKm: thresholds, sampleKm: d(89_500), observedAt: new Date('2026-09-24T08:10:00Z'), lastHistorized: l })).toBe('SEUIL');
    const l2 = { km: d(89_500), observedAt: new Date('2026-09-24T08:10:00Z') };
    expect(historizationReason({ ...base, thresholdsKm: thresholds, sampleKm: d(90_000), observedAt: new Date('2026-09-24T08:20:00Z'), lastHistorized: l2 })).toBe('SEUIL');
  });
  it('échantillon en désordre ignoré', () => {
    expect(historizationReason({ ...base, sampleKm: d(90_000), observedAt: new Date('2026-09-24T07:00:00Z'), lastHistorized: last })).toBeNull();
  });
});
