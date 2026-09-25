import { describe, expect, it } from 'vitest';
import { freshnessWhere } from './vehicle-conditions.js';

describe('filtre de fraîcheur de la liste des véhicules (D-269)', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  const thresholds = new Map([
    ['A', 7],
    ['B', 30],
    ['C', 7],
  ]);

  it('INCONNU : aucun relevé accepté, quel que soit le seuil', () => {
    expect(freshnessWhere('INCONNU', thresholds, now)).toEqual({ odometerReadings: { none: { status: 'ACCEPTE' } } });
  });

  it('regroupe les sociétés par seuil et applique la limite staleBefore (instant inclus = à jour)', () => {
    const recent7 = { status: 'ACCEPTE', observedAt: { gte: new Date('2026-09-17T10:00:00Z') } };
    const recent30 = { status: 'ACCEPTE', observedAt: { gte: new Date('2026-08-25T10:00:00Z') } };
    expect(freshnessWhere('A_JOUR', thresholds, now)).toEqual({
      OR: [
        { companyId: { in: ['A', 'C'] }, odometerReadings: { some: recent7 } },
        { companyId: { in: ['B'] }, odometerReadings: { some: recent30 } },
      ],
    });
    expect(freshnessWhere('A_ACTUALISER', thresholds, now)).toEqual({
      OR: [
        { companyId: { in: ['A', 'C'] }, AND: [{ odometerReadings: { some: { status: 'ACCEPTE' } } }, { odometerReadings: { none: recent7 } }] },
        { companyId: { in: ['B'] }, AND: [{ odometerReadings: { some: { status: 'ACCEPTE' } } }, { odometerReadings: { none: recent30 } }] },
      ],
    });
  });

  it('périmètre vide : aucun véhicule', () => {
    expect(freshnessWhere('A_JOUR', new Map(), now)).toEqual({ id: { in: [] } });
  });
});
