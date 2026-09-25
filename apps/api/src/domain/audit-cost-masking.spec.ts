import { describe, expect, it } from 'vitest';
import { COST_MASKED, isCostAuditKey, maskAuditCosts } from './audit-cost-masking.js';

describe('montants du journal d’audit sans costs.read (D-266)', () => {
  it('reconnaît les clés de montant écrites par les modules de coûts', () => {
    for (const key of [
      'amount',
      'totalAmount',
      'unitPrice',
      'total',
      'totals',
      'lineAmounts',
      'signedAmount',
      'operatingCost',
      'linkedCost',
      'cost',
      'costs',
      'costPerKm',
      'amountMismatchValue',
      'Montant',
      'prix',
    ]) {
      expect(isCostAuditKey(key), key).toBe(true);
    }
  });

  it('ne vise pas les statuts, indicateurs ni grandeurs non monétaires', () => {
    for (const key of [
      'costStatus',
      'amountMismatch',
      'amountMismatchConfirmed',
      'costsComplete',
      'hasCostColumns',
      'costColumns',
      'costCompanyIds',
      'totalDistance',
      'totalMs',
      'liters',
      'physicalKm',
      'status',
      'reference',
    ]) {
      expect(isCostAuditKey(key), key).toBe(false);
    }
  });

  it('masque les montants à toute profondeur et conserve le reste', () => {
    const before = {
      status: 'VALIDEE',
      amount: '120.500',
      supplierId: 'f-1',
      lines: [{ label: 'Plaquettes', quantity: '2', unitPrice: '45.000' }],
      totals: { ht: '100.000', ttc: '119.000' },
      liters: '40.00',
      costStatus: 'SAISI',
      amountMismatch: true,
      noCost: false,
      total: null,
    };
    expect(maskAuditCosts(before)).toEqual({
      status: 'VALIDEE',
      amount: COST_MASKED,
      supplierId: 'f-1',
      lines: [{ label: 'Plaquettes', quantity: '2', unitPrice: COST_MASKED }],
      totals: COST_MASKED,
      liters: '40.00',
      costStatus: 'SAISI',
      amountMismatch: true,
      noCost: false,
      total: null,
    });
  });

  it('laisse intactes les valeurs scalaires et absentes', () => {
    expect(maskAuditCosts(null)).toBeNull();
    expect(maskAuditCosts(undefined)).toBeUndefined();
    expect(maskAuditCosts('texte')).toBe('texte');
    expect(maskAuditCosts(12)).toBe(12);
  });
});
