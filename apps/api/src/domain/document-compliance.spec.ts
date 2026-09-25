import { describe, expect, it } from 'vitest';
import { blockingNonCompliantTypeIds, type ComplianceTypeRule } from './document-compliance.js';

describe('non-conformité documentaire bloquante (CDC 7.2, 11.1 ; D-210, D-269)', () => {
  const base = { ownerType: 'VEHICULE' as const, vehicleCategoryIds: [] as string[], companyIds: [] as string[], hasExpiry: true, required: true, noticeDays: [30, 15, 7] };
  const assurance: ComplianceTypeRule = { ...base, id: 'assurance', blocksCheckout: true };
  const visite: ComplianceTypeRule = { ...base, id: 'visite', blocksCheckout: true, vehicleCategoryIds: ['PL'] };
  const vignette: ComplianceTypeRule = { ...base, id: 'vignette', blocksCheckout: false };
  const owner = { ownerType: 'VEHICULE' as const, companyId: 'A', categoryId: 'VP' };
  const today = '2026-09-24';

  it('document bloquant manquant ou expiré : non conforme', () => {
    expect(blockingNonCompliantTypeIds([assurance], [], owner, today)).toEqual(['assurance']);
    expect(blockingNonCompliantTypeIds([assurance], [{ id: 'v1', documentTypeId: 'assurance', validFrom: '2025-09-24', validTo: '2026-09-23' }], owner, today)).toEqual(['assurance']);
  });

  it('date de fin valable jusqu’à la fin du jour local, préavis sans effet sur la conformité', () => {
    expect(blockingNonCompliantTypeIds([assurance], [{ id: 'v1', documentTypeId: 'assurance', validFrom: '2025-09-24', validTo: '2026-09-24' }], owner, today)).toEqual([]);
    expect(blockingNonCompliantTypeIds([assurance], [{ id: 'v1', documentTypeId: 'assurance', validFrom: '2025-09-24', validTo: '2026-10-01' }], owner, today)).toEqual([]);
  });

  it('ignore les types non bloquants, non applicables (catégorie) et les versions d’un autre type', () => {
    expect(blockingNonCompliantTypeIds([vignette, visite], [], owner, today)).toEqual([]);
    expect(blockingNonCompliantTypeIds([assurance], [{ id: 'v1', documentTypeId: 'vignette', validFrom: null, validTo: '2027-01-01' }], owner, today)).toEqual(['assurance']);
    expect(blockingNonCompliantTypeIds([visite], [], { ...owner, categoryId: 'PL' }, today)).toEqual(['visite']);
  });
});
