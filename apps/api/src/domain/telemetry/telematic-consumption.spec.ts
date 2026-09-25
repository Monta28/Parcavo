import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { type TelematicContext, type TelematicIntervalInput, type TelematicSample, formatDeviation, telematicInterval, telematicKindOf, telematicTotal } from './telematic-consumption.js';

const d = (v: number | string) => new Decimal(v);
const T0 = Date.parse('2026-09-24T08:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000);

function sample(minute: number, liters: number | null, kind: TelematicSample['kind'] = 'NIVEAU_SONDE', percent: number | null = null): TelematicSample {
  return { observedAt: at(minute), kind, liters: liters === null ? null : d(liters), percent: percent === null ? null : d(percent) };
}

const interval: TelematicIntervalInput = { startEntryId: 'A', endEntryId: 'B', startAt: at(0), endAt: at(600), distanceKm: d(400), declaredLiters: d(50), declaredRetained: true };

/** Sonde toutes les 5 min : 60 L après A (08:05), −0,5 L/5 min, plein intermédiaire de 20 L à 13:00, 23 L avant B (17:55). */
function probeContext(options: { gapFrom?: number; gapTo?: number } = {}): TelematicContext {
  const samples: TelematicSample[] = [];
  for (let m = -10; m <= 625; m += 5) {
    if (options.gapFrom !== undefined && m > options.gapFrom && m < (options.gapTo ?? m)) continue;
    let level: number;
    if (m < 0) level = 20;
    else if (m === 0) level = 40;
    else if (m === 5) level = 60;
    else if (m <= 290) level = 60 - 0.5 * ((m - 5) / 5);
    else if (m === 295) level = 31.5;
    else if (m === 300) level = 41.5;
    else if (m === 305) level = 51.5;
    else if (m <= 590) level = 51.5 - 0.5 * ((m - 305) / 5);
    else if (m === 595) level = 23;
    else if (m === 600) level = 38;
    else level = 53;
    samples.push(sample(m, level));
  }
  return {
    samples,
    refills: [
      { startAt: at(-10), endAt: at(35), liters: d(40), fuelEntryId: 'A' },
      { startAt: at(270), endAt: at(330), liters: d(18), fuelEntryId: 'MID' },
      { startAt: at(570), endAt: at(625), liters: d(28), fuelEntryId: 'B' },
    ],
    declaredKinds: ['NIVEAU_SONDE'],
    tankCapacityLiters: d(80),
  };
}

describe('Consommation télématique en parallèle (CDC 8.5 ; D-234, D-236 ; R-8.5-10)', () => {
  it('nature retenue : compteur de consommation CAN de préférence, puis sonde, parmi les mesures reçues avant les natures seulement déclarées ; jamais la jauge CAN seule', () => {
    expect(telematicKindOf({ samples: [], declaredKinds: ['NIVEAU_SONDE', 'CONSOMMATION_CAN'] })).toBe('CONSOMMATION_CAN');
    expect(telematicKindOf({ samples: [sample(0, 40)], declaredKinds: [] })).toBe('NIVEAU_SONDE');
    expect(telematicKindOf({ samples: [sample(0, 40, 'NIVEAU_CAN')], declaredKinds: ['NIVEAU_CAN'] })).toBeNull();
    expect(telematicKindOf({ samples: [], declaredKinds: [] })).toBeNull();
    // Compteur CAN déclaré mais jamais reçu, sonde reçue : la mesure disponible est retenue (pas un N/D).
    expect(telematicKindOf({ samples: [sample(0, 40)], declaredKinds: ['CONSOMMATION_CAN', 'NIVEAU_SONDE'] })).toBe('NIVEAU_SONDE');
    expect(telematicKindOf({ samples: [sample(0, 40), sample(5, 1000, 'CONSOMMATION_CAN')], declaredKinds: ['NIVEAU_SONDE'] })).toBe('CONSOMMATION_CAN');
  });

  it('sonde : pic après A − creux avant B + remplissages mesurés entre les deux = 57 L → 14,25 L/100 km, écart +14 %', () => {
    const r = telematicInterval(interval, 'NIVEAU_SONDE', probeContext());
    expect(r).toMatchObject({ kind: 'NIVEAU_SONDE', available: true, reasons: [] });
    expect(r.liters?.toString()).toBe('57');
    expect(r.ratio?.toString()).toBe('14.25');
    expect(r.deviationPercent?.toString()).toBe('14');
    expect(formatDeviation(r.deviationPercent as Decimal)).toBe('+14.0');
  });

  it('sonde : trou de plus de 60 min → N/D ; remplissage A ou B non rapproché → N/D ; pourcentage sans capacité → N/D', () => {
    expect(telematicInterval(interval, 'NIVEAU_SONDE', probeContext({ gapFrom: 120, gapTo: 200 })).reasons).toEqual(['TROU_ECHANTILLONS']);
    const noA = { ...probeContext(), refills: probeContext().refills.filter((r) => r.fuelEntryId !== 'A') };
    expect(telematicInterval(interval, 'NIVEAU_SONDE', noA)).toMatchObject({ available: false, liters: null, reasons: ['REMPLISSAGE_NON_DETECTE'] });
    const percentOnly: TelematicContext = { ...probeContext(), samples: probeContext().samples.map((s) => ({ ...s, liters: null, percent: (s.liters as Decimal).div(80).times(100) })), tankCapacityLiters: null };
    expect(telematicInterval(interval, 'NIVEAU_SONDE', percentOnly).reasons).toEqual(['VOLUME_INCONNU']);
    const withCapacity = { ...percentOnly, tankCapacityLiters: d(80) };
    expect(telematicInterval(interval, 'NIVEAU_SONDE', withCapacity).liters?.toString()).toBe('57');
  });

  it('compteur CAN : différence entre le premier et le dernier échantillon de [A, B], contrôles de trou et de couverture', () => {
    const counter = (minutesList: number[], start = 1000, total = 51): TelematicContext => ({
      samples: minutesList.map((m) => sample(m, start + (total * Math.min(Math.max(m, 0), 600)) / 600, 'CONSOMMATION_CAN')),
      refills: [],
      declaredKinds: ['CONSOMMATION_CAN'],
      tankCapacityLiters: null,
    });
    const every30 = Array.from({ length: 21 }, (_, i) => i * 30);
    const ok = telematicInterval(interval, 'CONSOMMATION_CAN', counter(every30));
    expect([ok.available, ok.liters?.toString(), ok.ratio?.toString(), ok.deviationPercent?.toString()]).toEqual([true, '51', '12.75', '2']);
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', counter(every30.filter((m) => m < 200 || m > 290))).reasons).toEqual(['TROU_ECHANTILLONS']);
    // Échantillons toutes les 55 min, premier 50 min après A : aucun trou > 60 min mais couverture < 90 %.
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', counter([50, 105, 160, 215, 270, 325, 380, 435, 490, 545])).reasons).toEqual(['COUVERTURE_INSUFFISANTE']);
    const reset = counter(every30);
    reset.samples = reset.samples.map((s, i) => (i === reset.samples.length - 1 ? { ...s, liters: d(3) } : s));
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', reset).reasons).toEqual(['BILAN_INCOHERENT']);
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', counter([])).reasons).toEqual(['ECHANTILLONS_ABSENTS']);
    // Intervalle déclaré exclu : litres télématiques affichés, aucun écart ; sans plein de référence : N/D.
    expect(telematicInterval({ ...interval, declaredRetained: false }, 'CONSOMMATION_CAN', counter(every30)).deviationPercent).toBeNull();
    expect(telematicInterval({ ...interval, startEntryId: null, startAt: null }, 'CONSOMMATION_CAN', counter(every30)).reasons).toEqual(['ECHANTILLONS_ABSENTS']);
    expect(telematicInterval({ ...interval, distanceKm: null }, 'CONSOMMATION_CAN', counter(every30))).toMatchObject({ available: false, reasons: ['DISTANCE_NON_VALIDE'] });
  });

  it('changement de boîtier dans l’intervalle : mesures de deux boîtiers jamais combinées (N/D motivé, aucune valeur fabriquée)', () => {
    const every30 = Array.from({ length: 21 }, (_, i) => i * 30);
    // Compteur de l'ancien boîtier (1 000 → 1 025 L) jusqu'à 12:00, puis compteur du nouveau (48 000 → 48 026 L) :
    // la différence dernier − premier donnerait 47 026 L.
    const counters: TelematicContext = {
      samples: every30.map((m) => ({ ...sample(m, m <= 240 ? 1000 + (25 * m) / 240 : 48000 + (26 * (m - 270)) / 330, 'CONSOMMATION_CAN'), unitId: m <= 240 ? 'U-OLD' : 'U-NEW' })),
      refills: [],
      declaredKinds: ['CONSOMMATION_CAN'],
      tankCapacityLiters: null,
    };
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', counters)).toMatchObject({ available: false, liters: null, deviationPercent: null, reasons: ['BILAN_INCOHERENT'] });
    const single: TelematicContext = { ...counters, samples: counters.samples.map((s) => ({ ...s, unitId: 'U-OLD' })) };
    expect(telematicInterval(interval, 'CONSOMMATION_CAN', single).available).toBe(true);
    // Sonde : pic de l'ancien boîtier après A, creux du nouveau avant B.
    const probes = probeContext();
    const swapped: TelematicContext = { ...probes, samples: probes.samples.map((s) => ({ ...s, unitId: s.observedAt.getTime() < at(300).getTime() ? 'U-OLD' : 'U-NEW' })) };
    expect(telematicInterval(interval, 'NIVEAU_SONDE', swapped)).toMatchObject({ available: false, liters: null, reasons: ['BILAN_INCOHERENT'] });
    const sameProbe: TelematicContext = { ...probes, samples: probes.samples.map((s) => ({ ...s, unitId: 'U-OLD' })) };
    expect(telematicInterval(interval, 'NIVEAU_SONDE', sameProbe).liters?.toString()).toBe('57');
  });

  it('synthèse : seuls les intervalles comparables (déclaré retenu, télématique disponible), mêmes bornes ; sinon N/D avec les motifs', () => {
    const good = { input: interval, result: telematicInterval(interval, 'NIVEAU_SONDE', probeContext()) };
    const excluded = { input: { ...interval, endEntryId: 'C', declaredRetained: false }, result: { kind: 'NIVEAU_SONDE' as const, available: true, liters: d(100), ratio: d(25), deviationPercent: null, reasons: [] } };
    const missing = { input: { ...interval, endEntryId: 'D' }, result: { kind: 'NIVEAU_SONDE' as const, available: false, liters: null, ratio: null, deviationPercent: null, reasons: ['TROU_ECHANTILLONS' as const] } };
    const total = telematicTotal('NIVEAU_SONDE', [good, excluded, missing]);
    expect([total.available, total.comparedCount, total.liters?.toString(), total.declaredLiters?.toString(), total.ratio?.toString(), total.declaredRatio?.toString(), total.deviationPercent?.toString()]).toEqual([true, 1, '57', '50', '14.25', '12.5', '14']);
    const none = telematicTotal('NIVEAU_SONDE', [missing]);
    expect(none).toMatchObject({ available: false, comparedCount: 0, liters: null, reasons: ['TROU_ECHANTILLONS'] });
    expect([formatDeviation(d('-3.04')), formatDeviation(d('-0.04')), formatDeviation(d('4.25'))]).toEqual(['-3.0', '0.0', '+4.3']);
  });
});
