'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useAppScope } from '@/components/layout/session-context';
import { PlanStatusBadge, planStatusLabel } from '@/components/maintenance/plan-display';
import { ErrorState, LoadingState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, toQuery } from '@/lib/api-client';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import { agendaDays, buildMonthGrid, currentMonth, isCalendarMonth, monthLabel, shiftMonth, type CalendarDay } from '@/lib/maintenance-calendar';
import type { MaintenanceCalendarView } from '@/lib/maintenance-types';
import { useListParams } from '@/lib/use-list-params';

const WEEKDAYS = ['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'];
const KIND_LABELS: Record<string, string> = { PREVENTIF: 'Préventive', CORRECTIF: 'Corrective' };

/**
 * Onglet « Calendrier » de /entretiens (CDC 10.2) : échéances en date des plans et interventions planifiées
 * du mois, telles que renvoyées par GET /maintenance-calendar (statut matérialisé du jour local). Le mois
 * affiché est conservé dans l'URL (?mois=AAAA-MM).
 */
export function CalendarTab() {
  const { companyId, session } = useAppScope();
  const { get, set } = useListParams();
  const rawMonth = get('mois');
  const month = isCalendarMonth(rawMonth) ? rawMonth : currentMonth(session.timezone);
  const calendar = useQuery({
    queryKey: ['maintenance-calendar', month, companyId ?? 'toutes'],
    queryFn: () => api<MaintenanceCalendarView>(`/maintenance-calendar${toQuery({ month, companyId })}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Mois précédent" onClick={() => set({ mois: shiftMonth(month, -1) })}>
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <h2 className="min-w-40 text-center text-lg font-semibold capitalize" aria-live="polite">
            {monthLabel(month)}
          </h2>
          <Button variant="outline" size="icon" aria-label="Mois suivant" onClick={() => set({ mois: shiftMonth(month, 1) })}>
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => set({ mois: '' })}>
          Mois en cours
        </Button>
      </div>
      {calendar.isPending ? (
        <LoadingState label="Chargement du calendrier…" />
      ) : calendar.isError ? (
        <ErrorState error={calendar.error} retry={() => void calendar.refetch()} />
      ) : (
        <MaintenanceCalendar calendar={calendar.data} timezone={session.timezone} onOpenPlan={(planId) => set({ plan: planId })} onShowOverdue={() => set({ onglet: '', mois: '', statut: 'EN_RETARD' })} />
      )}
    </div>
  );
}

/** Rendu du mois (grille sur grand écran, liste des jours occupés sur petit écran) à partir de la réponse de l'API. */
export function MaintenanceCalendar({ calendar, timezone, onOpenPlan, onShowOverdue }: { calendar: MaintenanceCalendarView; timezone: string; onOpenPlan: (planId: string) => void; onShowOverdue: () => void }) {
  const weeks = buildMonthGrid(calendar);
  const agenda = agendaDays(calendar);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Échéances en date des plans actifs et interventions planifiées ({calendar.dueItems.length} échéance{calendar.dueItems.length > 1 ? 's' : ''}, {calendar.interventions.length} intervention{calendar.interventions.length > 1 ? 's' : ''}). Les échéances uniquement kilométriques figurent dans l’onglet « Échéances ». Planifier une intervention ne vaut pas réalisation.
      </p>
      {calendar.overdueBeforeCount > 0 ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {calendar.overdueBeforeCount} échéance{calendar.overdueBeforeCount > 1 ? 's' : ''} en retard avant ce mois.
            <Button variant="link" className="h-auto p-0" onClick={onShowOverdue}>
              Voir les plans en retard
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {calendar.truncated ? (
        <Alert>
          <AlertDescription>Le mois contient plus d’éléments que le calendrier n’en affiche : filtrez par société depuis l’en-tête.</AlertDescription>
        </Alert>
      ) : null}

      <div className="hidden overflow-hidden rounded-md border md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Calendrier des échéances de {monthLabel(calendar.month)}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col" className="border-b bg-muted/50 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]?.date}>
                {week.map((day) => (
                  <td key={day.date} className={`h-28 border-t border-l align-top first:border-l-0 ${day.inMonth ? '' : 'bg-muted/30'}`}>
                    {day.inMonth ? <DayCell day={day} timezone={timezone} onOpenPlan={onOpenPlan} /> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {agenda.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune échéance en date ni intervention planifiée ce mois-ci.</p>
        ) : (
          agenda.map((day) => (
            <section key={day.date} aria-label={formatDate(day.date, timezone)} className="rounded-md border p-3">
              <h3 className="mb-2 text-sm font-medium">{formatDate(day.date, timezone)}</h3>
              <DayItems day={day} timezone={timezone} onOpenPlan={onOpenPlan} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function DayCell({ day, timezone, onOpenPlan }: { day: CalendarDay; timezone: string; onOpenPlan: (planId: string) => void }) {
  return (
    <div className="flex h-full flex-col gap-1 p-1.5">
      <span className="text-xs font-medium text-muted-foreground">{Number(day.date.slice(8, 10))}</span>
      <DayItems day={day} timezone={timezone} onOpenPlan={onOpenPlan} compact />
    </div>
  );
}

function DayItems({ day, timezone, onOpenPlan, compact = false }: { day: CalendarDay; timezone: string; onOpenPlan: (planId: string) => void; compact?: boolean }) {
  if (day.due.length === 0 && day.interventions.length === 0) return null;
  return (
    <ul className="space-y-1">
      {day.due.map((d) => (
        <li key={d.planId}>
          <button
            type="button"
            className="w-full rounded border px-1.5 py-1 text-left text-xs hover:bg-muted"
            onClick={() => onOpenPlan(d.planId)}
            aria-label={`Échéance ${d.maintenanceTypeLabel} du véhicule ${d.vehicleCode} : ${planStatusLabel(d.status)}`}
          >
            <span className="flex items-center gap-1 font-medium">
              <CalendarClock className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{d.vehicleCode}</span>
            </span>
            <span className="block truncate">{d.maintenanceTypeLabel}</span>
            {!compact && d.nextDueKm ? <span className="block text-muted-foreground">ou {formatKm(d.nextDueKm)}</span> : null}
            <span className="mt-0.5 block">
              <PlanStatusBadge status={d.status} />
            </span>
          </button>
        </li>
      ))}
      {day.interventions.map((i) => (
        <li key={i.id}>
          <Link href={`/interventions/${i.id}`} className="block rounded border border-dashed px-1.5 py-1 text-xs hover:bg-muted">
            <span className="flex items-center gap-1 font-medium">
              <Wrench className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{i.reference}</span>
            </span>
            <span className="block truncate">
              {i.vehicleCode} · {KIND_LABELS[i.kind] ?? i.kind} planifiée
            </span>
            {!compact ? <span className="block text-muted-foreground">{formatDateTime(i.plannedStartAt, timezone)}{i.tasks.length > 0 ? ` · ${i.tasks.join(', ')}` : ''}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
