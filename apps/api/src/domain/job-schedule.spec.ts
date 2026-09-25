import { describe, expect, it } from 'vitest';
import { DAY_MS, MINUTE_MS, catchUpPeriodMs, scheduledRunKey, slotStart } from './job-schedule.js';

describe('créneaux des traitements planifiés (D-200, D-257)', () => {
  it('rattrapage toutes les 15 minutes aligné sur :00, :15, :30, :45 UTC', () => {
    const p = 15 * MINUTE_MS;
    expect(slotStart(new Date('2026-09-24T10:14:59.999Z'), p).toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(slotStart(new Date('2026-09-24T10:15:00.000Z'), p).toISOString()).toBe('2026-09-24T10:15:00.000Z');
    expect(slotStart(new Date('2026-09-24T10:44:10.000Z'), p).toISOString()).toBe('2026-09-24T10:30:00.000Z');
    expect(() => slotStart(new Date(), 0)).toThrow();
  });

  it('créneau quotidien : jour UTC', () => {
    expect(slotStart(new Date('2026-09-24T23:59:59.000Z'), DAY_MS).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(slotStart(new Date('2026-09-25T00:00:00.000Z'), DAY_MS).toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('clé de déduplication stable par tâche, portée et créneau', () => {
    const slot = new Date('2026-09-24T10:15:00.000Z');
    expect(scheduledRunKey('alertes-rattrapage', slot, 'org-1')).toBe('planifie:alertes-rattrapage:org-1:2026-09-24T10:15:00.000Z');
    expect(scheduledRunKey('purge-quotidienne', slot)).toBe('planifie:purge-quotidienne:2026-09-24T10:15:00.000Z');
  });

  it('intervalle de rattrapage borné de 5 à 60 minutes', () => {
    expect(catchUpPeriodMs(15)).toBe(15 * MINUTE_MS);
    expect(catchUpPeriodMs(1)).toBe(5 * MINUTE_MS);
    expect(catchUpPeriodMs(600)).toBe(60 * MINUTE_MS);
    expect(catchUpPeriodMs(Number.NaN)).toBe(15 * MINUTE_MS);
  });
});
