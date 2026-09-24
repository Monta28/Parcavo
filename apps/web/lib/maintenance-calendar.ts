// Mise en page du calendrier des échéances (/entretiens, onglet « Calendrier ») : grille des jours du mois
// et regroupement par date des éléments renvoyés par GET /maintenance-calendar. Aucune règle d'échéance ni
// de statut ici : dates et statuts sont ceux calculés par l'API (14.2).
import type { MaintenanceCalendarView } from './maintenance-types';
import { addDays, startOfMonth, startOfWeek, todayCivil } from './zoned-time';

export type CalendarDueItem = MaintenanceCalendarView['dueItems'][number];
export type CalendarIntervention = MaintenanceCalendarView['interventions'][number];

export interface CalendarDay {
  date: string;
  inMonth: boolean;
  due: CalendarDueItem[];
  interventions: CalendarIntervention[];
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isCalendarMonth(value: string): boolean {
  return MONTH.test(value);
}

/** Mois civil courant (AAAA-MM) dans le fuseau de l'organisation. */
export function currentMonth(timezone: string, now: Date = new Date()): string {
  return todayCivil(timezone, now).slice(0, 7);
}

/** Mois décalé de `delta` mois (AAAA-MM). */
export function shiftMonth(month: string, delta: number): string {
  return startOfMonth(`${month}-01`, delta).slice(0, 7);
}

/** Libellé français du mois : « octobre 2026 ». */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, m - 1, 1)));
}

/**
 * Semaines (lundi → dimanche) couvrant le mois, avec les éléments du calendrier rangés à leur date.
 * Les jours hors du mois complètent la première et la dernière semaine (inMonth = false, sans élément).
 */
export function buildMonthGrid(calendar: Pick<MaintenanceCalendarView, 'month' | 'dueItems' | 'interventions'>): CalendarDay[][] {
  const first = `${calendar.month}-01`;
  const nextMonth = startOfMonth(first, 1);
  const byDate = groupByDate(calendar);
  const weeks: CalendarDay[][] = [];
  let cursor = startOfWeek(first);
  while (cursor < nextMonth) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i += 1) {
      const inMonth = cursor.startsWith(calendar.month);
      const items = inMonth ? byDate.get(cursor) : undefined;
      week.push({ date: cursor, inMonth, due: items?.due ?? [], interventions: items?.interventions ?? [] });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Jours du mois ayant au moins un élément, dans l'ordre chronologique (vue liste sur petit écran). */
export function agendaDays(calendar: Pick<MaintenanceCalendarView, 'month' | 'dueItems' | 'interventions'>): CalendarDay[] {
  return [...groupByDate(calendar).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, inMonth: true, ...items }));
}

function groupByDate(calendar: Pick<MaintenanceCalendarView, 'dueItems' | 'interventions'>): Map<string, { due: CalendarDueItem[]; interventions: CalendarIntervention[] }> {
  const byDate = new Map<string, { due: CalendarDueItem[]; interventions: CalendarIntervention[] }>();
  const slot = (date: string) => {
    let s = byDate.get(date);
    if (!s) {
      s = { due: [], interventions: [] };
      byDate.set(date, s);
    }
    return s;
  };
  for (const d of calendar.dueItems) slot(d.date).due.push(d);
  for (const i of calendar.interventions) slot(i.date).interventions.push(i);
  return byDate;
}
