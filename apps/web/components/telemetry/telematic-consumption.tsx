import type { TelematicConsumption, TelematicConsumptionTotal } from '@/lib/fuel-types';

const RATIO = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DEVIATION = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });

/** L/100 km arrondi par l'API (chaîne) → « 14,3 L/100 km » ; jamais de chiffre inventé (N/D). */
function ratio(value: string | null, unit: string): string {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) ? `${RATIO.format(n)} ${unit}` : 'N/D';
}

/** Écart signé arrondi par l'API (« +14.0 ») → « +14,0 % ». */
export function formatTelematicDeviation(value: string | null): string | null {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) ? `${DEVIATION.format(n)} %` : null;
}

/**
 * Consommation télématique affichée en parallèle de la consommation déclarée (CDC 8.5 ; D-234) : nature de la
 * mesure, L/100 km sur les mêmes bornes et écart avec la consommation déclarée, tels que calculés par l'API ;
 * N/D avec ses motifs sinon. Présentée comme une mesure distincte, jamais substituée à la consommation déclarée.
 */
export function TelematicConsumptionLine({ value, unit, compact = false }: { value: TelematicConsumption | TelematicConsumptionTotal; unit: string; compact?: boolean }) {
  const deviation = formatTelematicDeviation(value.deviationPercent);
  const total = 'comparedIntervals' in value ? value : null;
  if (compact) {
    return (
      <span className="block text-xs text-muted-foreground">
        Télématique ({value.kindLabel}) : {value.available ? ratio(value.litersPer100Km, unit) : 'N/D'}
        {deviation ? `, écart ${deviation}` : ''}
      </span>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-dashed p-2 text-sm" data-testid="telematic-consumption">
      <p>
        <span className="font-medium">Télématique ({value.kindLabel})</span> : {value.available ? ratio(value.litersPer100Km, unit) : 'N/D'}
        {deviation ? `, écart ${deviation} par rapport à la consommation déclarée` : ''}
      </p>
      {total && total.available ? (
        <p className="text-xs text-muted-foreground">
          Sur {total.comparedIntervals === 1 ? '1 intervalle comparé' : `${total.comparedIntervals} intervalles comparés`} (mêmes pleins, mêmes kilomètres) : consommation déclarée de ces intervalles {ratio(total.declaredLitersPer100Km, unit)}.
        </p>
      ) : null}
      {!value.available && value.reasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {value.reasons.map((r) => (
            <li key={r.code}>{r.label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
