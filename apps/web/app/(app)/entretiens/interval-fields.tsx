'use client';

import { FieldError } from '@/components/forms/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { MaintenancePlanView } from '@/lib/maintenance-types';

export type TimeUnit = 'MOIS' | 'JOURS';

/** Saisie des intervalles et préavis d'un plan ou d'une ligne de modèle (6.1, D-197). */
export interface IntervalsForm {
  intervalKm: string;
  timeValue: string;
  timeUnit: TimeUnit;
  noticeKm: string;
  noticeDays: string;
}

export const EMPTY_INTERVALS: IntervalsForm = { intervalKm: '', timeValue: '', timeUnit: 'MOIS', noticeKm: '', noticeDays: '' };

export function intervalsFrom(p: Pick<MaintenancePlanView, 'intervalKm' | 'intervalMonths' | 'intervalDays' | 'noticeKm' | 'noticeDays'>): IntervalsForm {
  return {
    intervalKm: p.intervalKm ?? '',
    timeValue: p.intervalDays ? String(p.intervalDays) : p.intervalMonths ? String(p.intervalMonths) : '',
    timeUnit: p.intervalDays ? 'JOURS' : 'MOIS',
    noticeKm: p.noticeKm ?? '',
    noticeDays: p.noticeDays !== null && p.noticeDays !== undefined ? String(p.noticeDays) : '',
  };
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Corps envoyé à l'API. Les champs vides valent null (préavis vide : la valeur paramétrée s'applique,
 * côté API, au seul composant présent). L'API valide et renvoie les erreurs par champ.
 */
export function intervalsPayload(form: IntervalsForm): { intervalKm: string | null; intervalMonths: number | null; intervalDays: number | null; noticeKm: string | null; noticeDays: number | null } {
  const time = intOrNull(form.timeValue);
  return {
    intervalKm: textOrNull(form.intervalKm),
    intervalMonths: form.timeUnit === 'MOIS' ? time : null,
    intervalDays: form.timeUnit === 'JOURS' ? time : null,
    noticeKm: textOrNull(form.noticeKm),
    noticeDays: intOrNull(form.noticeDays),
  };
}

/** Variante sans les champs vides (création : l'API applique ses valeurs par défaut). */
export function intervalsPayloadWithoutEmpty(form: IntervalsForm): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(intervalsPayload(form))) if (v !== null) out[k] = v;
  return out;
}

export function IntervalFields({
  value,
  onChange,
  errors,
  idPrefix,
  errorPrefix = '',
  disabled,
}: {
  value: IntervalsForm;
  onChange: (patch: Partial<IntervalsForm>) => void;
  errors: Record<string, string[]>;
  idPrefix: string;
  errorPrefix?: string;
  disabled?: boolean;
}) {
  const key = (name: string) => `${errorPrefix}${name}`;
  const timeKey = key('intervalTime');
  const timeErrors = { [timeKey]: [...(errors[key('intervalMonths')] ?? []), ...(errors[key('intervalDays')] ?? [])] };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-intervalKm`}>Intervalle en km</Label>
        <Input
          id={`${idPrefix}-intervalKm`}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={value.intervalKm}
          disabled={disabled}
          onChange={(e) => onChange({ intervalKm: e.target.value })}
          aria-invalid={errors[key('intervalKm')] ? true : undefined}
          aria-describedby={`${key('intervalKm')}-error`}
        />
        <FieldError errors={errors} name={key('intervalKm')} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-timeValue`}>Intervalle en temps</Label>
        <div className="flex gap-2">
          <Input
            id={`${idPrefix}-timeValue`}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="min-w-0 flex-1"
            value={value.timeValue}
            disabled={disabled}
            onChange={(e) => onChange({ timeValue: e.target.value })}
            aria-invalid={timeErrors[timeKey]!.length > 0 ? true : undefined}
            aria-describedby={`${timeKey}-error`}
          />
          <Select value={value.timeUnit} onValueChange={(v) => onChange({ timeUnit: v as TimeUnit })} disabled={disabled}>
            <SelectTrigger className="w-28" aria-label="Unité de l’intervalle en temps">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MOIS">mois</SelectItem>
              <SelectItem value="JOURS">jours</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <FieldError errors={timeErrors} name={timeKey} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-noticeKm`}>Préavis en km</Label>
        <Input
          id={`${idPrefix}-noticeKm`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value.noticeKm}
          disabled={disabled}
          onChange={(e) => onChange({ noticeKm: e.target.value })}
          aria-invalid={errors[key('noticeKm')] ? true : undefined}
          aria-describedby={`${idPrefix}-notice-hint ${key('noticeKm')}-error`}
        />
        <FieldError errors={errors} name={key('noticeKm')} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-noticeDays`}>Préavis en jours</Label>
        <Input
          id={`${idPrefix}-noticeDays`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value.noticeDays}
          disabled={disabled}
          onChange={(e) => onChange({ noticeDays: e.target.value })}
          aria-invalid={errors[key('noticeDays')] ? true : undefined}
          aria-describedby={`${idPrefix}-notice-hint ${key('noticeDays')}-error`}
        />
        <FieldError errors={errors} name={key('noticeDays')} />
      </div>
      <p id={`${idPrefix}-notice-hint`} className="text-xs text-muted-foreground sm:col-span-2">
        Au moins un intervalle en km ou en temps (mois ou jours, pas les deux). Préavis vide : la valeur paramétrée s’applique au seul composant présent. Aucun intervalle universel n’est imposé.
      </p>
    </div>
  );
}
