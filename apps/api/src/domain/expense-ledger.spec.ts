import { describe, expect, it } from 'vitest';
import {
  COUNTED_EXPENSE_STATUS,
  amountRejection,
  countsInTotals,
  defaultExcludedFromOperatingCost,
  isVehicleOptional,
  type LedgerRow,
  netAmount,
  normalizeReference,
  signedAmount,
  summarizeLedger,
} from './expense-ledger.js';

const row = (overrides: Partial<LedgerRow>): LedgerRow => ({ category: 'ENTRETIEN_REPARATION', kind: 'DEPENSE', status: 'VALIDEE', amount: '0', vehicleId: 'v1', excludedFromOperatingCost: false, ...overrides });

describe('registre des dépenses : règles pures (CDC 8.4, D-229, D-230, D-233)', () => {
  it('un avoir saisi en positif est soustrait ; un net négatif reste négatif', () => {
    expect(signedAmount('DEPENSE', '120.500').toFixed(3)).toBe('120.500');
    expect(signedAmount('AVOIR', '20.250').toFixed(3)).toBe('-20.250');
    expect(netAmount([{ kind: 'DEPENSE', amount: '100' }, { kind: 'AVOIR', amount: '30.001' }]).toFixed(3)).toBe('69.999');
    expect(netAmount([{ kind: 'AVOIR', amount: '15' }]).toFixed(3)).toBe('-15.000');
    expect(netAmount([]).toFixed(3)).toBe('0.000');
  });

  it('additionne sans perte de précision (aucun flottant)', () => {
    const rows = Array.from({ length: 10 }, () => ({ kind: 'DEPENSE' as const, amount: '0.1' }));
    expect(netAmount(rows).toFixed(3)).toBe('1.000');
    expect(netAmount([{ kind: 'DEPENSE', amount: '999999999999999.999' }, { kind: 'DEPENSE', amount: '0.001' }]).toFixed(3)).toBe('1000000000000000.000');
    // Au-delà de 20 chiffres significatifs (précision par défaut de decimal.js), aucun arrondi.
    const huge = Array.from({ length: 1000 }, () => ({ kind: 'DEPENSE' as const, amount: '999999999999999.999' }));
    expect(netAmount([...huge, { kind: 'AVOIR', amount: '0.001' }]).toFixed(3)).toBe('999999999999999998.999');
    const summary = summarizeLedger(huge.map((h) => row({ amount: h.amount })));
    expect(summary.operating.net.toFixed(3)).toBe('999999999999999999.000');
    expect(summary.byCategory[0]?.expenses.toFixed(3)).toBe('999999999999999999.000');
  });

  it('seules les dépenses validées comptent', () => {
    expect(countsInTotals('VALIDEE')).toBe(true);
    expect(countsInTotals('ANNULEE')).toBe(false);
    expect(countsInTotals('REMPLACEE')).toBe(false);
  });

  it('dépense sans véhicule : assurance, taxes, location et autre uniquement (D-230)', () => {
    expect(['ASSURANCE', 'TAXES', 'LOCATION', 'AUTRE'].every((c) => isVehicleOptional(c as LedgerRow['category']))).toBe(true);
    for (const c of ['ENTRETIEN_REPARATION', 'CARBURANT', 'PEAGE', 'STATIONNEMENT', 'ACHAT_VEHICULE'] as const) expect(isVehicleOptional(c), c).toBe(false);
  });

  it('achat de véhicule exclu du coût d’exploitation par défaut, selon le paramètre (D-233)', () => {
    expect(defaultExcludedFromOperatingCost('ACHAT_VEHICULE', true)).toBe(true);
    expect(defaultExcludedFromOperatingCost('ACHAT_VEHICULE', false)).toBe(false);
    expect(defaultExcludedFromOperatingCost('ASSURANCE', true)).toBe(false);
  });

  it('montant saisi : strictement positif, trois décimales au plus, jamais arrondi en silence', () => {
    expect(amountRejection('125.5')).toBeNull();
    expect(amountRejection('0.001')).toBeNull();
    expect(amountRejection('0')).toMatch(/strictement positif/);
    expect(amountRejection('0.000')).toMatch(/strictement positif/);
    expect(amountRejection('12.3456')).toMatch(/trois décimales/);
    expect(amountRejection('-5')).toMatch(/Montant invalide/);
    expect(amountRejection('1e3')).toMatch(/Montant invalide/);
    expect(amountRejection('999999999999999.999')).toBeNull();
    expect(amountRejection('1000000000000000')).toMatch(/Montant invalide/);
    expect(amountRejection(' 12')).toMatch(/Montant invalide/);
    expect(amountRejection('')).toMatch(/Montant invalide/);
  });

  it('référence : espaces superflus retirés, vide → absente', () => {
    expect(normalizeReference('  FAC  2026-001 ')).toBe('FAC 2026-001');
    expect(normalizeReference('   ')).toBeNull();
    expect(normalizeReference(undefined)).toBeNull();
  });

  it('synthèse : par catégorie, ligne « Non ventilé », exclusions et statuts non comptés', () => {
    const summary = summarizeLedger([
      row({ category: 'ENTRETIEN_REPARATION', amount: '191.250' }),
      row({ category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', amount: '41.250' }),
      row({ category: 'CARBURANT', amount: '80.000' }),
      row({ category: 'ASSURANCE', amount: '1200.000', vehicleId: null }),
      row({ category: 'ASSURANCE', amount: '100.000', vehicleId: null, kind: 'AVOIR' }),
      row({ category: 'ACHAT_VEHICULE', amount: '45000.000', excludedFromOperatingCost: true }),
      row({ category: 'CARBURANT', amount: '999.000', status: 'ANNULEE' }),
      row({ category: 'CARBURANT', amount: '888.000', status: 'REMPLACEE' }),
    ]);
    expect(summary.byCategory.map((c) => [c.category, c.expenses.toFixed(3), c.credits.toFixed(3), c.net.toFixed(3), c.count])).toEqual([
      ['ENTRETIEN_REPARATION', '191.250', '41.250', '150.000', 2],
      ['CARBURANT', '80.000', '0.000', '80.000', 1],
      ['ASSURANCE', '1200.000', '100.000', '1100.000', 2],
    ]);
    expect(summary.operating.net.toFixed(3)).toBe('1330.000');
    expect(summary.operating.count).toBe(5);
    expect(summary.unallocated.net.toFixed(3)).toBe('1100.000');
    expect(summary.unallocated.count).toBe(2);
    expect(summary.excluded.net.toFixed(3)).toBe('45000.000');
    expect(summary.excluded.byCategory.map((c) => c.category)).toEqual(['ACHAT_VEHICULE']);
  });

  it('lignes agrégées en base (rapports paginés, CDC 17.2) : même synthèse que les dépenses une à une', () => {
    const individual = [
      row({ category: 'ENTRETIEN_REPARATION', amount: '191.250' }),
      row({ category: 'ENTRETIEN_REPARATION', amount: '8.750' }),
      row({ category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', amount: '41.250' }),
      row({ category: 'ASSURANCE', amount: '1200.000', vehicleId: null }),
      row({ category: 'ASSURANCE', amount: '300.000', vehicleId: null }),
      row({ category: 'ACHAT_VEHICULE', amount: '45000.000', excludedFromOperatingCost: true }),
      row({ category: 'CARBURANT', amount: '999.000', status: 'ANNULEE' }),
    ];
    const aggregated = [
      row({ category: 'ENTRETIEN_REPARATION', amount: '200.000', count: 2 }),
      row({ category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', amount: '41.250', count: 1 }),
      row({ category: 'ASSURANCE', amount: '1500.000', vehicleId: null, count: 2 }),
      row({ category: 'ACHAT_VEHICULE', amount: '45000.000', excludedFromOperatingCost: true, count: 1 }),
      row({ category: 'CARBURANT', amount: '999.000', status: 'ANNULEE', count: 1 }),
    ];
    const view = (s: ReturnType<typeof summarizeLedger>) => JSON.stringify(s, (_k, v: unknown) => (v !== null && typeof v === 'object' && 'toFixed' in v ? (v as { toFixed(n: number): string }).toFixed(3) : v));
    expect(view(summarizeLedger(aggregated))).toBe(view(summarizeLedger(individual)));
    expect(summarizeLedger(aggregated).operating.count).toBe(5);
    expect(summarizeLedger(aggregated).unallocated.count).toBe(2);
    expect(countsInTotals(COUNTED_EXPENSE_STATUS)).toBe(true);
  });

  it('synthèse vide : zéros exacts', () => {
    const summary = summarizeLedger([]);
    expect(summary.byCategory).toEqual([]);
    expect(summary.operating.net.toFixed(3)).toBe('0.000');
    expect(summary.unallocated.count).toBe(0);
  });
});
