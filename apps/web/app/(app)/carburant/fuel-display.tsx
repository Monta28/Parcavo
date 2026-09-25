'use client';

import { useMemo } from 'react';
import { ENERGY_LABELS, READING_STATUS_LABELS } from '@parc-auto/contracts';
import { rightsIn } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { StatusBadge } from '@/components/status-badge';
import { formatMoney } from '@/lib/format';
import { type FuelEntryView, fuelStatusLabel } from '@/lib/fuel-types';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function toneForFuelStatus(status: string): Tone {
  switch (status) {
    case 'SOUMIS':
      return 'warning';
    case 'VALIDE':
      return 'success';
    case 'REJETE':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function FuelStatusBadge({ status }: { status: string }) {
  return <StatusBadge label={fuelStatusLabel(status)} tone={toneForFuelStatus(status)} />;
}

export function energyLabel(energy: string | null | undefined): string {
  if (!energy) return '—';
  return ENERGY_LABELS[energy as keyof typeof ENERGY_LABELS] ?? energy;
}

/** Litres renvoyés par l'API (chaîne à 3 décimales) : affichage français sans arrondi. */
export function formatFuelLiters(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(n)} L`;
}

/** Consommation déjà arrondie par l'API (une décimale) : seule la virgule française est appliquée. */
export function formatConsumption(value: string | null | undefined, unit: string): string {
  if (value === null || value === undefined || value === '') return 'N/D';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/D';
  return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)} ${unit}`;
}

/** Montant TND renvoyé par l'API (null sans costs.read : jamais deviné). */
export function useMoney(): (value: string | null | undefined) => string {
  const { session } = useAppScope();
  return (value) => formatMoney(value, session.currency, session.currencyDecimals);
}

export interface FuelRights {
  /** Saisie directe d'un plein : rôle opérationnel et costs.write (POST /fuel-entries). */
  write: boolean;
  /** Validation ou rejet d'une soumission : costs.write seul (POST :id/validate, :id/reject, D-266). */
  decide: boolean;
  /** Annulation, correction, confirmation de capacité, période « achats incomplets » : chef ou administrateur. */
  manager: boolean;
  /** Consultation des montants et du ticket (costs.read). */
  readCosts: boolean;
}

/**
 * Droits d'affichage sur la société du plein ou du véhicule : ils masquent seulement des boutons, l'API
 * reste seule juge (403/404/409/422 affichés tels quels).
 */
export function useFuelRights(companyId: string | null): FuelRights {
  const { session } = useAppScope();
  return useMemo(() => {
    const r = rightsIn(session, companyId);
    return { write: r.operational && r.can('costs.write'), decide: r.can('costs.write'), manager: r.manager, readCosts: r.can('costs.read') };
  }, [session, companyId]);
}

/** Sociétés où l'utilisateur peut saisir un plein (rôle opérationnel et costs.write), pour filtrer les véhicules proposés. */
export function useFuelWriteCompanyIds(): string[] {
  const { session } = useAppScope();
  return useMemo(() => {
    const active = session.companies.filter((c) => c.status !== 'ARCHIVE');
    if (session.isAdmin) return active.map((c) => c.id);
    return active.filter((c) => {
      const r = rightsIn(session, c.id);
      return r.operational && r.can('costs.write');
    }).map((c) => c.id);
  }, [session]);
}

/** Pastilles d'anomalie d'un plein, telles que signalées par l'API (jamais uniquement une couleur). */
export function FuelAnomalyBadges({ entry }: { entry: FuelEntryView }) {
  const badges: Array<{ key: string; label: string; tone: Tone }> = [];
  if (entry.amountMismatch) badges.push({ key: 'ecart', label: 'Écart montant', tone: 'warning' });
  if (entry.tankCapacityExceeded) badges.push(entry.capacityConfirmedAt ? { key: 'capacite', label: 'Capacité confirmée', tone: 'info' } : { key: 'capacite', label: 'Capacité dépassée', tone: 'danger' });
  if (entry.readingStatus === 'EN_ATTENTE') badges.push({ key: 'compteur', label: 'Compteur à valider', tone: 'warning' });
  else if (entry.readingStatus === 'REJETE') badges.push({ key: 'compteur', label: 'Compteur rejeté', tone: 'danger' });
  else if (entry.readingId === null && entry.declaredPhysicalKm === null) badges.push({ key: 'compteur', label: 'Sans compteur', tone: 'neutral' });
  if (badges.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <StatusBadge key={b.key} label={b.label} tone={b.tone} />
      ))}
    </div>
  );
}

/**
 * Avertissements renvoyés par l'API pour un plein : écart litres × prix / total (jamais corrigé), capacité
 * du réservoir dépassée, relevé du ticket en attente ou rejeté, admissibilité à la consommation.
 */
export function FuelWarnings({ entry, money }: { entry: FuelEntryView; money: (value: string | null | undefined) => string }) {
  const lines: Array<{ key: string; text: string }> = [];
  if (entry.amountMismatch) {
    lines.push({
      key: 'ecart',
      text: `Écart entre litres × prix unitaire et montant total${entry.amountMismatchValue ? ` : ${money(entry.amountMismatchValue)}` : ''}. Le total saisi est conservé tel quel, il n’est jamais recalculé.`,
    });
  }
  if (entry.tankCapacityExceeded) {
    lines.push({ key: 'capacite', text: entry.capacityConfirmedAt ? 'Capacité du réservoir dépassée, confirmée par le chef de parc.' : 'Litres supérieurs à la capacité du réservoir enregistrée sur la fiche du véhicule.' });
  }
  if (entry.readingStatus && entry.readingStatus !== 'ACCEPTE') {
    const label = READING_STATUS_LABELS[entry.readingStatus as keyof typeof READING_STATUS_LABELS] ?? entry.readingStatus;
    lines.push({ key: 'releve', text: `Relevé du compteur : ${label.toLowerCase()}${entry.readingStatusReason ? ` (${entry.readingStatusReason})` : ''}.` });
  }
  if (entry.consumptionEligibility !== 'ADMISSIBLE') lines.push({ key: 'conso', text: entry.consumptionEligibilityLabel });
  if (lines.length === 0) return null;
  return (
    <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="font-medium">Avertissements du serveur</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {lines.map((l) => (
          <li key={l.key}>{l.text}</li>
        ))}
      </ul>
    </div>
  );
}
