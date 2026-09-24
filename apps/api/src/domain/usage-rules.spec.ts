import { describe, expect, it } from 'vitest';
import { returnDelay } from './return-delay.js';
import { conversionWindow, isInConversionWindow, isInReturnRegularizationWindow, isReturnLate, lateReturnCutoff, occupancyEnd, pickReservationToConvert, returnRegularizationBlock } from './usage-rules.js';

const d = (iso: string) => new Date(iso);

describe('retard au retour : règle unique (CDC 4.5, D-135)', () => {
  const now = d('2026-09-24T14:00:00Z');

  it('sans tolérance : en retard dès que le retour prévu est strictement passé', () => {
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T13:59:59.999Z') }, now, 0)).toBe(true);
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T14:00:00Z') }, now, 0)).toBe(false);
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T15:00:00Z') }, now, 0)).toBe(false);
  });

  it('avec tolérance : pas de retard tant que la tolérance n’est pas dépassée', () => {
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T13:30:00Z') }, now, 30)).toBe(false);
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T13:29:59.999Z') }, now, 30)).toBe(true);
    expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: d('2026-09-24T13:00:00Z') }, now, 120)).toBe(false);
  });

  it('une utilisation terminée n’est jamais en retard', () => {
    expect(isReturnLate({ status: 'TERMINEE', expectedReturnAt: d('2026-09-20T00:00:00Z') }, now, 0)).toBe(false);
  });

  it('la borne du filtre SQL coïncide avec la règle (retour prévu < borne ⇔ en retard)', () => {
    for (const tolerance of [0, 15, 60, 1440]) {
      const cutoff = lateReturnCutoff(now, tolerance);
      expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: cutoff }, now, tolerance)).toBe(false);
      expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt: new Date(cutoff.getTime() - 1) }, now, tolerance)).toBe(true);
    }
    expect(lateReturnCutoff(now, 45).toISOString()).toBe('2026-09-24T13:15:00.000Z');
    // Une tolérance négative (paramètre invalide) n'avance jamais le retard.
    expect(lateReturnCutoff(now, -10).toISOString()).toBe(now.toISOString());
  });

  it('coïncide avec returnDelay (rapports) pour une utilisation en cours : une seule règle de retard', () => {
    for (const tolerance of [-5, 0, 1, 30, 1440]) {
      const cutoff = lateReturnCutoff(now, tolerance).getTime();
      for (const offsetMs of [-3_600_000, -60_001, -1, 0, 1, 60_000, 3_600_000]) {
        const expectedReturnAt = new Date(cutoff + offsetMs);
        const late = returnDelay({ expectedReturnAt, returnedAt: null, now, toleranceMinutes: tolerance }).late;
        expect(isReturnLate({ status: 'EN_COURS', expectedReturnAt }, now, tolerance)).toBe(late);
        // Condition SQL du filtre late=true : expectedReturnAt < borne.
        expect(expectedReturnAt.getTime() < cutoff).toBe(late);
      }
    }
  });
});

describe('occupation réelle d’une utilisation ouverte (D-140)', () => {
  it('s’étend jusqu’au retour prévu, ou jusqu’à maintenant si le retour prévu est dépassé', () => {
    const now = d('2026-09-24T14:00:00Z');
    expect(occupancyEnd(d('2026-09-24T18:00:00Z'), now).toISOString()).toBe('2026-09-24T18:00:00.000Z');
    expect(occupancyEnd(d('2026-09-24T12:00:00Z'), now).toISOString()).toBe('2026-09-24T14:00:00.000Z');
  });
});

describe('fenêtre de conversion d’une réservation (D-140, D-142)', () => {
  const r = { id: 'r1', startAt: d('2026-09-24T10:00:00Z'), endAt: d('2026-09-24T12:00:00Z') };

  it('[début − 120 min, fin[ : bornes incluse puis exclue', () => {
    expect(isInConversionWindow(r, d('2026-09-24T07:59:59.999Z'), 120)).toBe(false);
    expect(isInConversionWindow(r, d('2026-09-24T08:00:00Z'), 120)).toBe(true);
    expect(isInConversionWindow(r, d('2026-09-24T11:59:59.999Z'), 120)).toBe(true);
    expect(isInConversionWindow(r, d('2026-09-24T12:00:00Z'), 120)).toBe(false);
  });

  it('bornes de la fenêtre exposées pour les messages', () => {
    const w = conversionWindow(r, 120);
    expect(w.opensAt.toISOString()).toBe('2026-09-24T08:00:00.000Z');
    expect(w.closesAt.toISOString()).toBe('2026-09-24T12:00:00.000Z');
  });

  it('respecte une avance paramétrée différente', () => {
    expect(isInConversionWindow(r, d('2026-09-24T09:30:00Z'), 0)).toBe(false);
    expect(isInConversionWindow(r, d('2026-09-24T09:30:00Z'), 30)).toBe(true);
  });

  it('choisit la réservation commencée, sinon la plus proche ; aucune hors fenêtre', () => {
    const next = { id: 'r2', startAt: d('2026-09-24T12:00:00Z'), endAt: d('2026-09-24T14:00:00Z') };
    // 11 h : r1 est commencée, r2 est dans sa fenêtre d'avance → r1.
    expect(pickReservationToConvert([next, r], d('2026-09-24T11:00:00Z'), 120)?.id).toBe('r1');
    // 9 h : seule r1 est dans sa fenêtre (r2 ouvre à 10 h).
    expect(pickReservationToConvert([next, r], d('2026-09-24T09:00:00Z'), 120)?.id).toBe('r1');
    // 12 h 30 : r1 est finie, r2 commencée.
    expect(pickReservationToConvert([r, next], d('2026-09-24T12:30:00Z'), 120)?.id).toBe('r2');
    // 7 h : aucune fenêtre ouverte.
    expect(pickReservationToConvert([r, next], d('2026-09-24T07:00:00Z'), 120)).toBeNull();
    expect(pickReservationToConvert([], d('2026-09-24T11:00:00Z'), 120)).toBeNull();
  });
});

describe('régularisation du relevé de retour (CDC 4.4)', () => {
  const base = { status: 'TERMINEE', checkoutWithoutReading: false, checkoutReadingStatus: 'ACCEPTE', returnReadingStatus: null };
  it('possible après un retour sans relevé ou avec un relevé rejeté, départ accepté', () => {
    expect(returnRegularizationBlock(base)).toBeNull();
    expect(returnRegularizationBlock({ ...base, returnReadingStatus: 'REJETE' })).toBeNull();
  });
  it('refusée avant la restitution, sans relevé de départ, déjà validée ou relevé en attente', () => {
    expect(returnRegularizationBlock({ ...base, status: 'EN_COURS' })).toBe('NON_RESTITUEE');
    expect(returnRegularizationBlock({ ...base, checkoutWithoutReading: true, checkoutReadingStatus: null })).toBe('DEPART_SANS_RELEVE');
    expect(returnRegularizationBlock({ ...base, checkoutReadingStatus: 'REJETE' })).toBe('DEPART_SANS_RELEVE');
    expect(returnRegularizationBlock({ ...base, returnReadingStatus: 'ACCEPTE' })).toBe('DEJA_VALIDEE');
    expect(returnRegularizationBlock({ ...base, returnReadingStatus: 'EN_ATTENTE' })).toBe('RELEVE_EN_ATTENTE');
  });
  it('fenêtre : du retour à la remise suivante incluse, jamais dans le futur', () => {
    const returnedAt = new Date('2026-09-24T16:00:00Z');
    const next = new Date('2026-09-25T08:00:00Z');
    const now = new Date('2026-09-26T10:00:00Z');
    expect(isInReturnRegularizationWindow(returnedAt, returnedAt, next, now)).toBe(true);
    expect(isInReturnRegularizationWindow(next, returnedAt, next, now)).toBe(true);
    expect(isInReturnRegularizationWindow(new Date('2026-09-24T15:59:59Z'), returnedAt, next, now)).toBe(false);
    expect(isInReturnRegularizationWindow(new Date('2026-09-25T08:00:01Z'), returnedAt, next, now)).toBe(false);
    expect(isInReturnRegularizationWindow(new Date('2026-09-26T09:00:00Z'), returnedAt, null, now)).toBe(true);
    expect(isInReturnRegularizationWindow(new Date('2026-09-26T10:00:01Z'), returnedAt, null, now)).toBe(false);
  });
});
