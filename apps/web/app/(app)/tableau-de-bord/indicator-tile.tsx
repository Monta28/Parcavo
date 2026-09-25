'use client';

import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DashboardIndicator } from './dashboard-types';
import { JustificationLink, linkHref } from './justification-sheet';

type Tone = NonNullable<Parameters<typeof StatusBadge>[0]['tone']>;

/** Couleur d'appoint par indicateur : le libellé reste toujours affiché (CDC 10.1). */
const TONES: Record<string, Tone> = {
  'vehicles.active': 'success',
  'vehicles.available': 'success',
  'vehicles.inUse': 'info',
  'vehicles.immobilized': 'danger',
  'vehicles.outOfService': 'neutral',
  'maintenance.urgent': 'warning',
  'documents.expired': 'danger',
  'documents.missing': 'warning',
  'odometer.stale': 'warning',
  'odometer.unknown': 'neutral',
  'usages.returnDue': 'info',
  'interventions.completed': 'neutral',
  'costs.operating': 'neutral',
  'alerts.critical': 'danger',
  'alerts.urgent': 'danger',
  'alerts.attention': 'warning',
  'alerts.info': 'info',
};

/** Libellés des unités de comptage renvoyées par l'API (singulier, pluriel). */
const UNIT_LABELS: Record<string, readonly [string, string]> = {
  vehicules: ['véhicule', 'véhicules'],
  plans: ['plan d’entretien', 'plans d’entretien'],
  documents: ['document', 'documents'],
  utilisations: ['utilisation', 'utilisations'],
  interventions: ['intervention', 'interventions'],
  alertes: ['alerte', 'alertes'],
};

const COUNT_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export function toneFor(key: string): Tone {
  return TONES[key] ?? 'neutral';
}

function unitLabel(unit: string, count: number): string {
  const labels = UNIT_LABELS[unit];
  if (!labels) return unit;
  return count <= 1 ? labels[0] : labels[1];
}

/** Valeur mise en forme et complément (« sur 12 véhicules actifs », « plans d’entretien »), sans aucun calcul. */
function measure(indicator: DashboardIndicator, currencyDecimals: number): { value: string; suffix: string } {
  if (typeof indicator.value === 'string') return { value: formatMoney(indicator.value, indicator.unit, currencyDecimals), suffix: '' };
  const value = COUNT_FORMAT.format(indicator.value);
  if (indicator.denominator) return { value, suffix: `sur ${COUNT_FORMAT.format(indicator.denominator.value)} ${indicator.denominator.label}` };
  return { value, suffix: unitLabel(indicator.unit, indicator.value) };
}

/** Horodatage d'un état ou période d'un flux, dans le fuseau de l'organisation. */
export function whenText(indicator: Pick<DashboardIndicator, 'asOf' | 'period'>, timezone: string): string {
  if (indicator.asOf) return `au ${formatDateTime(indicator.asOf, timezone)}`;
  if (indicator.period) return `du ${formatDate(indicator.period.from)} au ${formatDate(indicator.period.to)}`;
  return '';
}

interface MeasureProps {
  indicator: DashboardIndicator;
  timezone: string;
  currencyDecimals: number;
  compact?: boolean;
}

/** « 3 sur 12 véhicules actifs, au 24/09/2026 14:05 » : valeur, dénominateur et horodatage ou période. */
export function IndicatorMeasure({ indicator, timezone, currencyDecimals, compact }: MeasureProps) {
  const { value, suffix } = measure(indicator, currencyDecimals);
  const when = whenText(indicator, timezone);
  return (
    <p>
      <span className={cn('font-semibold tabular-nums', compact ? 'text-2xl' : 'text-3xl')}>{value}</span>
      {suffix ? <span className="text-sm text-muted-foreground"> {suffix}</span> : null}
      {when ? <span className="block text-xs text-muted-foreground">{when}</span> : null}
    </p>
  );
}

/** Sous-ensembles « dont … » d'un indicateur, chacun avec sa valeur, son dénominateur et sa liste. */
export function SubIndicatorList({ parent, items, timezone, currencyDecimals }: { parent: DashboardIndicator; items: DashboardIndicator[]; timezone: string; currencyDecimals: number }) {
  if (items.length === 0) return null;
  const parentWhen = whenText(parent, timezone);
  return (
    <ul className="space-y-1 text-sm">
      {items.map((item) => {
        const { value, suffix } = measure(item, currencyDecimals);
        const when = whenText(item, timezone);
        return (
          <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span>
              <span className="text-muted-foreground">{item.label} :</span> <span className="font-semibold tabular-nums">{value}</span>
              {suffix ? ` ${suffix}` : ''}
              {when && when !== parentWhen ? <span className="text-xs text-muted-foreground"> ({when})</span> : null}
            </span>
            <JustificationLink indicator={item} timezone={timezone} currencyDecimals={currencyDecimals} label="Voir" className="h-auto p-0 text-xs font-medium underline-offset-4 hover:underline" />
          </li>
        );
      })}
    </ul>
  );
}

/** Définition du calcul et liste justificative côté API (aucun indicateur opaque, CDC 11.1). */
export function IndicatorDefinition({ indicator, items = [] }: { indicator: DashboardIndicator; items?: DashboardIndicator[] }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium">Définition et source</summary>
      <dl className="mt-2 space-y-2">
        {[indicator, ...items].map((i) => (
          <div key={i.key}>
            <dt className="font-medium text-foreground">{i.label}</dt>
            <dd>{i.definition}</dd>
            <dd>
              Liste justificative (API) : <code className="break-all">GET {linkHref(i.justification)}</code>, champ « {i.justification.field} »
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Tuile d'indicateur : libellé, valeur, dénominateur, horodatage ou période, définition et lien vers la liste justificative. */
export function IndicatorTile({ indicator, items = [], timezone, currencyDecimals, compact }: MeasureProps & { items?: DashboardIndicator[] }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          <h3>
            <StatusBadge label={indicator.label} tone={toneFor(indicator.key)} />
          </h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        <IndicatorMeasure indicator={indicator} timezone={timezone} currencyDecimals={currencyDecimals} compact={compact} />
        <SubIndicatorList parent={indicator} items={items} timezone={timezone} currencyDecimals={currencyDecimals} />
        <IndicatorDefinition indicator={indicator} items={items} />
        <div className="mt-auto text-sm">
          <JustificationLink indicator={indicator} timezone={timezone} currencyDecimals={currencyDecimals} />
        </div>
      </CardContent>
    </Card>
  );
}

export function IndicatorTileSkeleton() {
  return (
    <Card className="gap-3 py-4" aria-hidden="true">
      <CardHeader className="px-4">
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}
