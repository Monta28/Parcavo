import { describe, expect, it } from 'vitest';
import {
  canDeclareNoShow,
  immobilizationSlot,
  interventionReservationOverlaps,
  interventionSlot,
  isInterventionLate,
  noShowAllowedFrom,
  reservationEditScope,
  slotViolation,
  slotsOverlap,
  truncateToMinute,
} from './reservation-rules.js';

const d = (iso: string) => new Date(iso);
const now = d('2026-09-24T10:00:00Z');

describe('réservations : bornes du créneau (D-137)', () => {
  it('tronque les bornes à la minute', () => {
    expect(truncateToMinute(d('2026-09-24T10:07:59.999Z')).toISOString()).toBe('2026-09-24T10:07:00.000Z');
    expect(truncateToMinute(d('2026-09-24T10:07:00.000Z')).toISOString()).toBe('2026-09-24T10:07:00.000Z');
  });
  it('fin après le début, sinon INTERVALLE_INVALIDE (fin = début refusée)', () => {
    expect(slotViolation(d('2026-09-24T12:00:00Z'), d('2026-09-24T12:00:00Z'), now, { checkStart: true })?.code).toBe('INTERVALLE_INVALIDE');
    expect(slotViolation(d('2026-09-24T12:00:00Z'), d('2026-09-24T11:00:00Z'), now, { checkStart: true })?.field).toBe('endAt');
  });
  it('début accepté jusqu’à maintenant − 15 min, refusé au-delà (DEBUT_TROP_ANCIEN)', () => {
    expect(slotViolation(d('2026-09-24T09:45:00Z'), d('2026-09-24T12:00:00Z'), now, { checkStart: true })).toBeNull();
    expect(slotViolation(d('2026-09-24T09:44:00Z'), d('2026-09-24T12:00:00Z'), now, { checkStart: true })).toMatchObject({ code: 'DEBUT_TROP_ANCIEN', field: 'startAt' });
    // Début inchangé d'une réservation commencée : seule la fin est contrôlée.
    expect(slotViolation(d('2026-09-24T06:00:00Z'), d('2026-09-24T12:00:00Z'), now, { checkStart: false })).toBeNull();
  });
  it('fin passée refusée (INTERVALLE_PASSE)', () => {
    expect(slotViolation(d('2026-09-24T09:50:00Z'), d('2026-09-24T10:00:00Z'), now, { checkStart: true })?.code).toBe('INTERVALLE_PASSE');
    expect(slotViolation(d('2026-09-24T06:00:00Z'), d('2026-09-24T09:00:00Z'), now, { checkStart: false })?.code).toBe('INTERVALLE_PASSE');
  });
});

describe('réservations : modification et non-présentation (D-137)', () => {
  it('avant le début tout est modifiable ; à partir du début, seulement la fin', () => {
    expect(reservationEditScope(d('2026-09-24T10:01:00Z'), now)).toBe('COMPLETE');
    expect(reservationEditScope(d('2026-09-24T10:00:00Z'), now)).toBe('FIN_SEULEMENT');
    expect(reservationEditScope(d('2026-09-24T08:00:00Z'), now)).toBe('FIN_SEULEMENT');
  });
  it('constat de non-présentation à partir du début + délai de grâce', () => {
    const start = d('2026-09-24T09:00:00Z');
    expect(noShowAllowedFrom(start, 60).toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(canDeclareNoShow(start, d('2026-09-24T09:59:59Z'), 60)).toBe(false);
    expect(canDeclareNoShow(start, now, 60)).toBe(true);
    expect(canDeclareNoShow(start, d('2026-09-24T09:00:00Z'), 0)).toBe(true);
    expect(noShowAllowedFrom(start, -5).toISOString()).toBe(start.toISOString());
  });
});

describe('planning : créneaux et chevauchements (4.5, D-205)', () => {
  it('[début, fin[ : consécutifs sans chevauchement ; fin inconnue = ouverte', () => {
    expect(slotsOverlap({ start: d('2026-10-01T08:00:00Z'), end: d('2026-10-01T12:00:00Z') }, { start: d('2026-10-01T12:00:00Z'), end: d('2026-10-01T14:00:00Z') })).toBe(false);
    expect(slotsOverlap({ start: d('2026-10-01T08:00:00Z'), end: d('2026-10-01T12:00:00Z') }, { start: d('2026-10-01T11:59:00Z'), end: d('2026-10-01T14:00:00Z') })).toBe(true);
    expect(slotsOverlap({ start: d('2026-10-01T08:00:00Z'), end: null }, { start: d('2026-12-01T08:00:00Z'), end: d('2026-12-01T09:00:00Z') })).toBe(true);
    expect(slotsOverlap({ start: d('2026-10-01T08:00:00Z'), end: null }, { start: d('2026-09-01T08:00:00Z'), end: d('2026-10-01T08:00:00Z') })).toBe(false);
  });
  it('immobilisation : fin prévue dépassée prolongée jusqu’à maintenant, fin inconnue ouverte', () => {
    const start = d('2026-09-20T08:00:00Z');
    expect(immobilizationSlot(start, d('2026-09-30T08:00:00Z'), now)).toEqual({ start, end: d('2026-09-30T08:00:00Z') });
    expect(immobilizationSlot(start, d('2026-09-22T08:00:00Z'), now)).toEqual({ start, end: now });
    expect(immobilizationSlot(start, null, now)).toEqual({ start, end: null });
  });
  it('créneau d’une intervention selon son statut', () => {
    const planned = { status: 'PLANIFIEE', plannedStartAt: d('2026-10-01T08:00:00Z'), plannedEndAt: d('2026-10-01T17:00:00Z'), startedAt: null };
    expect(interventionSlot(planned)).toEqual({ start: planned.plannedStartAt, end: planned.plannedEndAt });
    expect(interventionSlot({ ...planned, plannedEndAt: null })).toEqual({ start: planned.plannedStartAt, end: null });
    expect(interventionSlot({ ...planned, status: 'EN_COURS', startedAt: d('2026-10-01T09:00:00Z') })).toEqual({ start: d('2026-10-01T09:00:00Z'), end: planned.plannedEndAt });
    // Démarrée après la fin prévue : fin inconnue.
    expect(interventionSlot({ ...planned, status: 'EN_COURS', startedAt: d('2026-10-01T18:00:00Z') })).toEqual({ start: d('2026-10-01T18:00:00Z'), end: null });
    expect(interventionSlot({ ...planned, status: 'PLANIFIEE', plannedStartAt: null })).toBeNull();
    for (const status of ['BROUILLON', 'TERMINEE', 'ANNULEE']) expect(interventionSlot({ ...planned, status })).toBeNull();
  });
  it('intervention en retard : fin prévue passée sans clôture', () => {
    const i = { status: 'EN_COURS', plannedStartAt: d('2026-09-23T08:00:00Z'), plannedEndAt: d('2026-09-24T09:00:00Z'), startedAt: d('2026-09-23T08:00:00Z') };
    expect(isInterventionLate(i, now)).toBe(true);
    expect(isInterventionLate({ ...i, plannedEndAt: d('2026-09-24T11:00:00Z') }, now)).toBe(false);
    expect(isInterventionLate({ ...i, plannedEndAt: null }, now)).toBe(false);
    expect(isInterventionLate({ ...i, status: 'TERMINEE' }, now)).toBe(false);
  });
  it('avertit pour une intervention qui chevauche une réservation CONFIRMEE du même véhicule seulement', () => {
    const intervention = { id: 'i1', vehicleId: 'v1', slot: { start: d('2026-10-01T08:00:00Z'), end: d('2026-10-01T17:00:00Z') } };
    const reservations = [
      { id: 'r1', vehicleId: 'v1', status: 'CONFIRMEE', slot: { start: d('2026-10-01T16:00:00Z'), end: d('2026-10-01T18:00:00Z') } },
      { id: 'r2', vehicleId: 'v1', status: 'CONVERTIE', slot: { start: d('2026-10-01T09:00:00Z'), end: d('2026-10-01T10:00:00Z') } },
      { id: 'r3', vehicleId: 'v2', status: 'CONFIRMEE', slot: { start: d('2026-10-01T09:00:00Z'), end: d('2026-10-01T10:00:00Z') } },
      { id: 'r4', vehicleId: 'v1', status: 'CONFIRMEE', slot: { start: d('2026-10-01T17:00:00Z'), end: d('2026-10-01T19:00:00Z') } },
    ];
    expect(interventionReservationOverlaps([intervention], reservations).map((p) => p.reservation.id)).toEqual(['r1']);
  });
});
