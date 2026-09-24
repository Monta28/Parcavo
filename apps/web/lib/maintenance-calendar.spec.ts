import { describe, expect, it } from 'vitest';
import { agendaDays, buildMonthGrid, currentMonth, isCalendarMonth, monthLabel, shiftMonth } from './maintenance-calendar';
import type { MaintenanceCalendarView } from './maintenance-types';

const due = (planId: string, date: string, status: MaintenanceCalendarView['dueItems'][number]['status'] = 'A_JOUR') => ({ planId, companyId: 'c', vehicleId: 'v', vehicleCode: `V-${planId}`, maintenanceTypeLabel: 'Batterie', date, nextDueKm: null, status });
const planned = (id: string, date: string) => ({ id, reference: `INT-${id}`, companyId: 'c', vehicleId: 'v', vehicleCode: 'V-1', kind: 'PREVENTIF' as const, date, plannedStartAt: `${date}T07:00:00.000Z`, plannedEndAt: null, tasks: [] });

describe('calendrier des échéances : mise en page du mois (aucune règle d’échéance)', () => {
  it('octobre 2026 : semaines du lundi au dimanche, jours hors mois sans élément', () => {
    const weeks = buildMonthGrid({ month: '2026-10', dueItems: [due('a', '2026-10-15'), due('b', '2026-10-31', 'EN_RETARD')], interventions: [planned('1', '2026-10-15')] });
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // Le 1er octobre 2026 est un jeudi : la grille commence le lundi 28 septembre.
    expect(weeks[0]?.[0]).toMatchObject({ date: '2026-09-28', inMonth: false });
    expect(weeks[0]?.[3]).toMatchObject({ date: '2026-10-01', inMonth: true });
    expect(weeks[4]?.[6]).toMatchObject({ date: '2026-11-01', inMonth: false });
    const day15 = weeks.flat().find((d) => d.date === '2026-10-15');
    expect(day15?.due.map((d) => d.planId)).toEqual(['a']);
    expect(day15?.interventions.map((i) => i.id)).toEqual(['1']);
    // Le statut affiché est celui de l'API, tel quel.
    expect(weeks.flat().find((d) => d.date === '2026-10-31')?.due[0]?.status).toBe('EN_RETARD');
  });

  it('février 2027 commençant un lundi : quatre semaines exactement', () => {
    const weeks = buildMonthGrid({ month: '2027-02', dueItems: [], interventions: [] });
    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]?.date).toBe('2027-02-01');
    expect(weeks[3]?.[6]?.date).toBe('2027-02-28');
  });

  it('liste des jours occupés (petit écran) dans l’ordre chronologique', () => {
    const days = agendaDays({ month: '2026-10', dueItems: [due('b', '2026-10-31'), due('a', '2026-10-02')], interventions: [planned('1', '2026-10-20')] });
    expect(days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-20', '2026-10-31']);
  });

  it('navigation : mois courant dans le fuseau, mois précédent/suivant, libellé et validation', () => {
    // 31/10 23:30 UTC = 01/11 00:30 à Tunis.
    expect(currentMonth('Africa/Tunis', new Date('2026-10-31T23:30:00Z'))).toBe('2026-11');
    expect(currentMonth('UTC', new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-10')).toBe('octobre 2026');
    expect(isCalendarMonth('2026-10')).toBe(true);
    expect(isCalendarMonth('2026-13')).toBe(false);
    expect(isCalendarMonth('2026-1')).toBe(false);
  });
});
