import { describe, expect, it } from 'vitest';
import { ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN, checkTransferDecisions, isDocumentShareSuggested, isReservationBlocking, type TransferDecisions, type TransferExpectations } from './vehicle-transfer.js';

const at = new Date('2026-09-24T10:00:00.000Z');

const expected: TransferExpectations = { hasOpenAssignment: true, activePlanIds: ['p1', 'p2'], documentVersionIds: ['d1', 'd2'], hasWarnings: true };

const complete: TransferDecisions = {
  closeAssignment: true,
  plans: [
    { planId: 'p1', decision: 'KEEP', responsibleUserId: 'u1' },
    { planId: 'p2', decision: 'DEACTIVATE' },
  ],
  sharedDocumentVersionIds: ['d1'],
  hasTransferReading: true,
  noReadingReason: undefined,
  acknowledgeWarnings: true,
};

describe('transfert de véhicule — règles (CDC 2.4 ; D-119 à D-125)', () => {
  it('réservation bloquante : CONFIRMEE dont la fin est postérieure à l’instant du transfert', () => {
    expect(isReservationBlocking({ status: 'CONFIRMEE', endAt: new Date('2026-09-24T10:00:00.001Z') }, at)).toBe(true);
    expect(isReservationBlocking({ status: 'CONFIRMEE', endAt: new Date('2026-09-24T10:00:00.000Z') }, at)).toBe(false);
    expect(isReservationBlocking({ status: 'ANNULEE', endAt: new Date('2026-10-01T10:00:00Z') }, at)).toBe(false);
    expect(isReservationBlocking({ status: 'CONVERTIE', endAt: new Date('2026-10-01T10:00:00Z') }, at)).toBe(false);
  });

  it('documents présélectionnés : versions valables ou futures au jour local du transfert', () => {
    expect(isDocumentShareSuggested({ validTo: null }, '2026-09-24')).toBe(true);
    expect(isDocumentShareSuggested({ validTo: '2026-09-24' }, '2026-09-24')).toBe(true);
    expect(isDocumentShareSuggested({ validTo: '2027-01-01' }, '2026-09-24')).toBe(true);
    expect(isDocumentShareSuggested({ validTo: '2026-09-23' }, '2026-09-24')).toBe(false);
  });

  it('décisions complètes : aucune erreur', () => {
    expect(checkTransferDecisions(expected, complete)).toEqual({});
    expect(checkTransferDecisions({ hasOpenAssignment: false, activePlanIds: [], documentVersionIds: [], hasWarnings: false }, { closeAssignment: undefined, plans: [], sharedDocumentVersionIds: [], hasTransferReading: false, noReadingReason: 'Compteur illisible', acknowledgeWarnings: undefined })).toEqual({});
  });

  it('affectation active non clôturée : refus', () => {
    expect(checkTransferDecisions(expected, { ...complete, closeAssignment: false })).toHaveProperty(['assignment.closeCurrent']);
    expect(checkTransferDecisions(expected, { ...complete, closeAssignment: undefined })).toHaveProperty(['assignment.closeCurrent']);
  });

  it('une décision par plan actif, ni plus ni moins', () => {
    const missing = checkTransferDecisions(expected, { ...complete, plans: [{ planId: 'p1', decision: 'KEEP' }] });
    expect(missing['plans']?.[0]).toContain('1 plan(s)');
    const unknown = checkTransferDecisions(expected, { ...complete, plans: [...complete.plans, { planId: 'p9', decision: 'KEEP' }] });
    expect(unknown).toHaveProperty(['plans.2.planId']);
    const duplicate = checkTransferDecisions(expected, { ...complete, plans: [...complete.plans, { planId: 'p1', decision: 'DEACTIVATE' }] });
    expect(duplicate['plans.2.planId']).toEqual(['Une seule décision par plan.']);
    const deactivatedWithOwner = checkTransferDecisions(expected, { ...complete, plans: [complete.plans[0]!, { planId: 'p2', decision: 'DEACTIVATE', responsibleUserId: 'u1' }] });
    expect(deactivatedWithOwner).toHaveProperty(['plans.1.responsibleUserId']);
  });

  it('documents partagés : uniquement des versions du véhicule', () => {
    expect(checkTransferDecisions(expected, { ...complete, sharedDocumentVersionIds: ['d1', 'autre'] })).toHaveProperty(['sharedDocumentVersionIds']);
  });

  it('relevé de transfert ou motif obligatoire, pas les deux', () => {
    expect(checkTransferDecisions(expected, { ...complete, hasTransferReading: false, noReadingReason: '  ' })).toHaveProperty(['noReadingReason']);
    expect(checkTransferDecisions(expected, { ...complete, hasTransferReading: false, noReadingReason: 'Véhicule au garage' })).toEqual({});
    expect(checkTransferDecisions(expected, { ...complete, hasTransferReading: true, noReadingReason: 'Véhicule au garage' })).toHaveProperty(['noReadingReason']);
  });

  it('alertes conservées par la société d’origine : événements datés encore ouverts (incident, relevé, plein, anomalie carburant)', () => {
    expect([...ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN].sort()).toEqual(['FuelEntry', 'FuelEvent', 'Incident', 'OdometerReading']);
    // Les alertes du véhicule et des objets repris par la cible sont résolues puis recalculées.
    for (const objectType of ['Vehicle', 'VehicleMaintenancePlan', 'DocumentVersion', 'TelemetryVehicleMapping']) expect(ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN).not.toContain(objectType);
  });

  it('avertissements à acquitter explicitement', () => {
    expect(checkTransferDecisions(expected, { ...complete, acknowledgeWarnings: undefined })).toHaveProperty(['acknowledgeWarnings']);
    expect(checkTransferDecisions({ ...expected, hasWarnings: false }, { ...complete, acknowledgeWarnings: undefined })).toEqual({});
  });
});
