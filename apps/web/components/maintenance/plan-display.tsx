import { AlertTriangle } from 'lucide-react';
import { PLAN_STATUS_LABELS } from '@parc-auto/contracts';
import { StatusBadge, toneForPlan } from '@/components/status-badge';
import { formatDate, formatKm } from '@/lib/format';
import { BASE_MODE_LABELS, KM_SOURCE_LABELS, PLAN_WARNING_LABELS, type MaintenancePlanView, type PlanStatus } from '@/lib/maintenance-types';

/**
 * Affichage des plans d'entretien : mise en forme des valeurs calculées par l'API (échéances, restes,
 * statuts, avertissements). Aucun calcul d'échéance ni de statut n'est fait ici.
 */
type Intervals = Pick<MaintenancePlanView, 'intervalKm' | 'intervalMonths' | 'intervalDays'>;
type Notices = Pick<MaintenancePlanView, 'noticeKm' | 'noticeDays'>;

export function planStatusLabel(status: string): string {
  return PLAN_STATUS_LABELS[status as PlanStatus] ?? status;
}

export function PlanStatusBadge({ status, prefix }: { status: string; prefix?: string }) {
  const label = planStatusLabel(status);
  return <StatusBadge label={prefix ? `${prefix} : ${label}` : label} tone={toneForPlan(status)} />;
}

export function formatIntervals(p: Intervals): string {
  const parts: string[] = [];
  if (p.intervalKm) parts.push(`tous les ${formatKm(p.intervalKm)}`);
  if (p.intervalMonths) parts.push(p.intervalMonths === 1 ? 'tous les mois' : `tous les ${p.intervalMonths} mois`);
  if (p.intervalDays) parts.push(p.intervalDays === 1 ? 'tous les jours' : `tous les ${p.intervalDays} jours`);
  return parts.length > 0 ? parts.join(' ou ') : '—';
}

export function formatNotices(p: Notices): string {
  const parts: string[] = [];
  if (p.noticeKm) parts.push(formatKm(p.noticeKm));
  if (p.noticeDays !== null && p.noticeDays !== undefined) parts.push(`${p.noticeDays} j`);
  return parts.length > 0 ? parts.join(' / ') : '—';
}

/** Base de calcul retenue par l'API : mode, puis km et date de la base (opération ou base initiale). */
export function formatBase(p: Pick<MaintenancePlanView, 'baseMode' | 'baseKm' | 'baseDate'>, timezone: string): string {
  const parts = [BASE_MODE_LABELS[p.baseMode] ?? p.baseMode];
  if (p.baseKm) parts.push(formatKm(p.baseKm));
  if (p.baseDate) parts.push(formatDate(p.baseDate, timezone));
  return parts.join(' · ');
}

export function PlanBase({ plan, timezone }: { plan: MaintenancePlanView; timezone: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{BASE_MODE_LABELS[plan.baseMode] ?? plan.baseMode}</p>
      {plan.baseKm ? <p>{formatKm(plan.baseKm)}</p> : null}
      {plan.baseDate ? <p>{formatDate(plan.baseDate, timezone)}</p> : null}
    </div>
  );
}

/** Reste renvoyé par l'API (négatif : échéance dépassée). */
export function formatRemainingKm(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return 'échéance atteinte';
  return n > 0 ? `reste ${formatKm(n)}` : `dépassée de ${formatKm(Math.abs(n))}`;
}

export function formatRemainingDays(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return 'échéance aujourd’hui';
  return value > 0 ? `dans ${value} j` : `dépassée de ${Math.abs(value)} j`;
}

/** Prochaine échéance km et/ou date avec les restes correspondants. */
export function PlanDue({ plan, timezone }: { plan: MaintenancePlanView; timezone: string }) {
  if (!plan.nextDueKm && !plan.nextDueDate) return <span className="text-muted-foreground">Non calculable</span>;
  return (
    <div className="space-y-0.5">
      {plan.nextDueKm ? (
        <p>
          <span className="font-medium">{formatKm(plan.nextDueKm)}</span>
          {plan.remainingKm !== null ? <span className="text-muted-foreground"> · {formatRemainingKm(plan.remainingKm)}</span> : null}
        </p>
      ) : null}
      {plan.nextDueDate ? (
        <p>
          <span className="font-medium">{formatDate(plan.nextDueDate, timezone)}</span>
          {plan.remainingDays !== null ? <span className="text-muted-foreground"> · {formatRemainingDays(plan.remainingDays)}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** Échéance kilométrique seule et reste (colonne triable par reste km). */
export function PlanDueKm({ plan }: { plan: Pick<MaintenancePlanView, 'nextDueKm' | 'remainingKm'> }) {
  if (!plan.nextDueKm) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{formatKm(plan.nextDueKm)}</p>
      {plan.remainingKm !== null ? <p className="text-xs text-muted-foreground">{formatRemainingKm(plan.remainingKm)}</p> : null}
    </div>
  );
}

/** Échéance calendaire seule et reste en jours (colonne triable par reste jours). */
export function PlanDueDate({ plan, timezone }: { plan: Pick<MaintenancePlanView, 'nextDueDate' | 'remainingDays'>; timezone: string }) {
  if (!plan.nextDueDate) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{formatDate(plan.nextDueDate, timezone)}</p>
      {plan.remainingDays !== null ? <p className="text-xs text-muted-foreground">{formatRemainingDays(plan.remainingDays)}</p> : null}
    </div>
  );
}

export function PlanCurrentKm({ plan }: { plan: MaintenancePlanView }) {
  if (!plan.currentKm) return <span className="text-muted-foreground">Kilométrage inconnu</span>;
  return (
    <span>
      {formatKm(plan.currentKm)}
      {plan.currentKmSource ? (
        <span className={plan.currentKmSource === 'ESTIME_GPS' ? 'block text-xs font-medium text-warning-foreground' : 'block text-xs text-muted-foreground'}>{KM_SOURCE_LABELS[plan.currentKmSource]}</span>
      ) : null}
    </span>
  );
}

export function warningLabel(code: string): string {
  return PLAN_WARNING_LABELS[code] ?? code;
}

/** Données manquantes ou anciennes, affichées séparément du statut (6.2). */
export function PlanWarnings({ warnings, compact = false }: { warnings: string[]; compact?: boolean }) {
  if (warnings.length === 0) return compact ? <span className="text-muted-foreground">—</span> : null;
  return (
    <ul className="space-y-1" aria-label="Avertissements">
      {warnings.map((w) => (
        <li key={w} className="flex items-start gap-1.5 text-xs text-warning-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{warningLabel(w)}</span>
        </li>
      ))}
    </ul>
  );
}
