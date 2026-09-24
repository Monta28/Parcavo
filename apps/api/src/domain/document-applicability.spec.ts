import { describe, expect, it } from 'vitest';
import { documentAlertSeverity, isDocumentTypeApplicable } from './document-applicability.js';

describe('Portée des types de documents (D-210)', () => {
  const vehicleType = { ownerType: 'VEHICULE' as const, vehicleCategoryIds: [], companyIds: [] };
  it('s’applique au bon propriétaire, avec restrictions facultatives de catégorie et de société', () => {
    expect(isDocumentTypeApplicable(vehicleType, { ownerType: 'VEHICULE', companyId: 'A', categoryId: 'VP' })).toBe(true);
    expect(isDocumentTypeApplicable(vehicleType, { ownerType: 'CONDUCTEUR', companyId: 'A' })).toBe(false);
    expect(isDocumentTypeApplicable({ ...vehicleType, vehicleCategoryIds: ['PL'] }, { ownerType: 'VEHICULE', companyId: 'A', categoryId: 'VP' })).toBe(false);
    expect(isDocumentTypeApplicable({ ...vehicleType, companyIds: ['B'] }, { ownerType: 'VEHICULE', companyId: 'A', categoryId: 'VP' })).toBe(false);
    expect(isDocumentTypeApplicable({ ownerType: 'CONDUCTEUR', vehicleCategoryIds: ['PL'], companyIds: [] }, { ownerType: 'CONDUCTEUR', companyId: 'A' })).toBe(true);
  });
});

describe('Gravité des alertes d’échéance documentaire (D-212)', () => {
  it('paliers 30/15/7 : INFO, ATTENTION, URGENT ; expiration CRITIQUE si bloquant', () => {
    expect(documentAlertSeverity([30, 15, 7], 30, false, false)).toBe('INFO');
    expect(documentAlertSeverity([30, 15, 7], 15, false, false)).toBe('ATTENTION');
    expect(documentAlertSeverity([30, 15, 7], 7, false, true)).toBe('URGENT');
    expect(documentAlertSeverity([30, 15, 7], null, true, true)).toBe('CRITIQUE');
    expect(documentAlertSeverity([30, 15, 7], null, true, false)).toBe('URGENT');
    expect(documentAlertSeverity([10], 10, false, false)).toBe('URGENT');
  });
});
