import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { evaluateDriverSubmission, exceedsTankCapacity, isInFuture, resolveFuelEnergy } from './fuel-rules.js';

const at = (iso: string) => new Date(iso);
const d = (v: string) => new Decimal(v);

describe('type de carburant et énergie du véhicule (D-225)', () => {
  it('véhicule électrique : refus, module kWh hors V1', () => {
    expect(resolveFuelEnergy('ELECTRIQUE', 'DIESEL')).toMatchObject({ ok: false, code: 'VEHICULE_ELECTRIQUE' });
    expect(resolveFuelEnergy('ELECTRIQUE', null)).toMatchObject({ ok: false, code: 'VEHICULE_ELECTRIQUE' });
  });
  it('véhicule thermique : même carburant, proposé par défaut', () => {
    expect(resolveFuelEnergy('DIESEL', null)).toEqual({ ok: true, energy: 'DIESEL' });
    expect(resolveFuelEnergy('GPL', 'GPL')).toEqual({ ok: true, energy: 'GPL' });
    expect(resolveFuelEnergy('DIESEL', 'ESSENCE')).toMatchObject({ ok: false, code: 'ENERGIE_INCOMPATIBLE' });
    expect(resolveFuelEnergy('ESSENCE', 'GPL')).toMatchObject({ ok: false, code: 'ENERGIE_INCOMPATIBLE' });
  });
  it('hybride : essence ou diesel, à préciser ; GPL refusé', () => {
    expect(resolveFuelEnergy('HYBRIDE', 'ESSENCE')).toEqual({ ok: true, energy: 'ESSENCE' });
    expect(resolveFuelEnergy('HYBRIDE', 'DIESEL')).toEqual({ ok: true, energy: 'DIESEL' });
    expect(resolveFuelEnergy('HYBRIDE', 'GPL')).toMatchObject({ ok: false, code: 'ENERGIE_INCOMPATIBLE' });
    expect(resolveFuelEnergy('HYBRIDE', null)).toMatchObject({ ok: false, code: 'ENERGIE_REQUISE' });
  });
  it('énergie AUTRE ou inconnue : carburant obligatoire, aucune incompatibilité inventée', () => {
    expect(resolveFuelEnergy(null, null)).toMatchObject({ ok: false, code: 'ENERGIE_REQUISE' });
    expect(resolveFuelEnergy(null, 'GPL')).toEqual({ ok: true, energy: 'GPL' });
    expect(resolveFuelEnergy('AUTRE', 'DIESEL')).toEqual({ ok: true, energy: 'DIESEL' });
  });
});

describe('capacité du réservoir (D-225)', () => {
  it('avertit au-delà de 105 % de la capacité connue seulement', () => {
    expect(exceedsTankCapacity(d('63'), d('60'))).toBe(false);
    expect(exceedsTankCapacity(d('63.001'), d('60'))).toBe(true);
    expect(exceedsTankCapacity(d('500'), null)).toBe(false);
  });
});

describe('horodatage non futur à 5 minutes près (D-223)', () => {
  const now = at('2026-09-24T10:00:00Z');
  it('tolère 5 minutes d’avance d’horloge', () => {
    expect(isInFuture(at('2026-09-24T10:05:00Z'), now)).toBe(false);
    expect(isInFuture(at('2026-09-24T10:05:00.001Z'), now)).toBe(true);
    expect(isInFuture(at('2026-09-20T10:00:00Z'), now)).toBe(false);
  });
});

describe('périmètre d’une soumission conducteur (D-226)', () => {
  const now = at('2026-09-24T10:00:00Z');
  const running = { status: 'EN_COURS' as const, checkedOutAt: at('2026-09-24T08:00:00Z'), returnedAt: null };
  const ended = { status: 'TERMINEE' as const, checkedOutAt: at('2026-09-20T08:00:00Z'), returnedAt: at('2026-09-20T18:00:00Z') };
  const base = { now, lateSubmissionDays: 7, responsibleForVehicle: false };

  it('utilisation en cours : ticket postérieur à la remise − 1 h accepté', () => {
    expect(evaluateDriverSubmission({ ...base, usages: [running], filledAt: at('2026-09-24T07:00:00Z') })).toEqual({ allowed: true });
    expect(evaluateDriverSubmission({ ...base, usages: [running], filledAt: at('2026-09-24T09:30:00Z') })).toEqual({ allowed: true });
    expect(evaluateDriverSubmission({ ...base, usages: [running], filledAt: at('2026-09-24T06:59:59Z') })).toEqual({ allowed: false, reason: 'HORS_UTILISATION' });
  });
  it('utilisation terminée depuis moins de 7 jours : fenêtre [remise − 1 h, restitution + 1 h]', () => {
    expect(evaluateDriverSubmission({ ...base, usages: [ended], filledAt: at('2026-09-20T19:00:00Z') })).toEqual({ allowed: true });
    expect(evaluateDriverSubmission({ ...base, usages: [ended], filledAt: at('2026-09-20T19:00:01Z') })).toEqual({ allowed: false, reason: 'HORS_UTILISATION' });
    expect(evaluateDriverSubmission({ ...base, usages: [ended], filledAt: at('2026-09-20T07:00:00Z') })).toEqual({ allowed: true });
  });
  it('utilisation terminée depuis plus longtemps que le délai paramétré : véhicule hors droits', () => {
    const later = at('2026-09-27T18:00:01Z');
    expect(evaluateDriverSubmission({ ...base, now: later, usages: [ended], filledAt: at('2026-09-20T12:00:00Z') })).toEqual({ allowed: false, reason: 'HORS_DROITS' });
    expect(evaluateDriverSubmission({ ...base, lateSubmissionDays: 3, now: at('2026-09-23T17:59:59Z'), usages: [ended], filledAt: at('2026-09-20T12:00:00Z') })).toEqual({ allowed: true });
    expect(evaluateDriverSubmission({ ...base, lateSubmissionDays: 0, usages: [ended], filledAt: at('2026-09-20T12:00:00Z') })).toEqual({ allowed: false, reason: 'HORS_DROITS' });
  });
  it('aucune utilisation : hors droits ; responsable habituel avec le paramètre activé (D-268) : ticket récent accepté', () => {
    expect(evaluateDriverSubmission({ ...base, usages: [], filledAt: at('2026-09-24T09:00:00Z') })).toEqual({ allowed: false, reason: 'HORS_DROITS' });
    expect(evaluateDriverSubmission({ ...base, responsibleForVehicle: true, usages: [], filledAt: at('2026-09-24T09:00:00Z') })).toEqual({ allowed: true });
    // Au-delà du délai de soumission tardive : refus motivé.
    expect(evaluateDriverSubmission({ ...base, responsibleForVehicle: true, usages: [], filledAt: at('2026-09-10T09:00:00Z') })).toEqual({ allowed: false, reason: 'HORS_UTILISATION' });
    // Hors fenêtre d'une utilisation terminée mais responsable habituel : accepté.
    expect(evaluateDriverSubmission({ ...base, responsibleForVehicle: true, usages: [ended], filledAt: at('2026-09-22T09:00:00Z') })).toEqual({ allowed: true });
  });
});
