import { Decimal } from 'decimal.js';
import { FUEL_ENERGIES, type FuelEnergy } from './fuel-rules.js';

/**
 * Consommation estimée à partir des pleins saisis (CDC 8.3 ; D-222, D-225, D-227, D-228) — calcul unique.
 *
 * Un intervalle relie deux pleins complets consécutifs A et B de même énergie, tous deux VALIDE.
 * Litres consommés = somme des litres achetés après A, B inclus (le carburant de A est exclu) ;
 * consommation = litres / (kmB − kmA) × 100. L'intervalle vaut N/D, avec ses motifs, dès qu'un signal
 * rend la base non fiable : jamais de litres retirés ni de distance inventée. La consommation d'une
 * période additionne litres et kilomètres des seuls intervalles retenus dont B tombe dans la période.
 * Résultat présenté comme une estimation fondée sur les saisies, jamais comme une mesure télématique.
 */

/** Unité et nature du résultat (8.3) : une estimation fondée sur les saisies, jamais une mesure télématique. */
export const CONSUMPTION_UNIT = 'L/100 km';
export const CONSUMPTION_NATURE = 'Estimation fondée sur les pleins saisis, pas une mesure télématique.';

export const CONSUMPTION_UNAVAILABLE_REASONS = [
  'PAS_DE_PLEIN_DE_REFERENCE',
  'PLEIN_INTERMEDIAIRE_SOUMIS',
  'COMPTEUR_NON_VALIDE',
  'BORNE_ESTIMEE',
  'CAPACITE_NON_CONFIRMEE',
  'DISTANCE_NULLE',
  'PERIODE_ACHATS_INCOMPLETS',
  'ENERGIE_DIFFERENTE',
  'REMPLISSAGE_SANS_TICKET',
  'ECART_TICKET_NON_QUALIFIE',
  'HISTORIQUE_INSUFFISANT',
] as const;
export type ConsumptionUnavailableReason = (typeof CONSUMPTION_UNAVAILABLE_REASONS)[number];

export const CONSUMPTION_REASON_LABELS: Record<ConsumptionUnavailableReason, string> = {
  PAS_DE_PLEIN_DE_REFERENCE: 'Aucun plein complet validé de référence avant ce plein.',
  PLEIN_INTERMEDIAIRE_SOUMIS: 'Un plein de l’intervalle est encore une soumission à valider.',
  COMPTEUR_NON_VALIDE: 'Un plein de l’intervalle n’a pas de relevé compteur validé.',
  BORNE_ESTIMEE: 'Une borne de l’intervalle repose sur un kilométrage estimé.',
  CAPACITE_NON_CONFIRMEE: 'Des litres dépassent la capacité du réservoir sans confirmation du chef de parc.',
  DISTANCE_NULLE: 'Distance nulle ou négative entre les deux pleins complets.',
  PERIODE_ACHATS_INCOMPLETS: 'L’intervalle recoupe une période déclarée « achats incomplets ».',
  ENERGIE_DIFFERENTE: 'Un achat d’une autre énergie a eu lieu dans l’intervalle.',
  REMPLISSAGE_SANS_TICKET: 'Un remplissage détecté par la télématique n’a pas de ticket dans l’intervalle.',
  ECART_TICKET_NON_QUALIFIE: 'Un écart ticket / télématique reste à qualifier dans l’intervalle.',
  HISTORIQUE_INSUFFISANT: 'Historique insuffisant : aucun couple de pleins complets dans la période.',
};

export interface ConsumptionOdometer {
  /** Statut du relevé retenu pour le plein (lié, ou relevé accepté au même instant après régularisation). */
  status: 'ACCEPTE' | 'EN_ATTENTE' | 'REJETE' | 'REMPLACE';
  cumulativeKm: Decimal | null;
  isEstimate: boolean;
}

export interface ConsumptionEntry {
  id: string;
  filledAt: Date;
  createdAt: Date;
  /** Seuls les achats SOUMIS ou VALIDE existent pour le calcul ; rejetés, annulés et remplacés n'en sont pas. */
  status: 'SOUMIS' | 'VALIDE';
  energy: FuelEnergy;
  isFullTank: boolean;
  liters: Decimal;
  odometer: ConsumptionOdometer | null;
  tankCapacityExceeded: boolean;
  capacityConfirmed: boolean;
}

/** Admissibilité d'un plein pour la consommation (D-222 consumptionEligibility, calculée à la volée). */
export type EntryEligibility = 'ADMISSIBLE' | 'NON_VALIDE' | 'COMPTEUR_NON_VALIDE' | 'BORNE_ESTIMEE' | 'CAPACITE_NON_CONFIRMEE';

export const ENTRY_ELIGIBILITY_LABELS: Record<EntryEligibility, string> = {
  ADMISSIBLE: 'Admissible au calcul de consommation.',
  NON_VALIDE: 'Plein non validé : exclu du calcul de consommation.',
  COMPTEUR_NON_VALIDE: 'Compteur non validé : coût compté, plein exclu de la consommation jusqu’à régularisation.',
  BORNE_ESTIMEE: 'Kilométrage estimé : exclu du calcul de consommation.',
  CAPACITE_NON_CONFIRMEE: 'Capacité du réservoir dépassée : exclu tant que le chef de parc n’a pas confirmé.',
};

export function entryEligibility(entry: { status: string } & Pick<ConsumptionEntry, 'odometer' | 'tankCapacityExceeded' | 'capacityConfirmed'>): EntryEligibility {
  if (entry.status !== 'VALIDE') return 'NON_VALIDE';
  if (!entry.odometer || entry.odometer.status !== 'ACCEPTE' || entry.odometer.cumulativeKm === null) return 'COMPTEUR_NON_VALIDE';
  if (entry.odometer.isEstimate) return 'BORNE_ESTIMEE';
  if (entry.tankCapacityExceeded && !entry.capacityConfirmed) return 'CAPACITE_NON_CONFIRMEE';
  return 'ADMISSIBLE';
}

export interface PurchaseGap {
  startsAt: Date;
  endsAt: Date;
}

export interface TelemetrySignal {
  at: Date;
  kind: 'REMPLISSAGE_SANS_TICKET' | 'ECART_TICKET_NON_QUALIFIE';
}

/**
 * Événement carburant F11 qui rend un intervalle non fiable (D-227, D-228) : remplissage détecté sans
 * ticket rattaché et non écarté par qualification, ou écart ticket non encore qualifié.
 */
export function telemetrySignalOf(event: {
  type: 'REMPLISSAGE_DETECTE' | 'BAISSE_ANORMALE' | 'ECART_TICKET';
  detectedAt: Date;
  fuelEntryId: string | null;
  status: 'A_QUALIFIER' | 'QUALIFIE';
  qualification: 'JUSTIFIE' | 'ANOMALIE_CONFIRMEE' | 'ERREUR_CAPTEUR' | null;
}): TelemetrySignal | null {
  if (event.type === 'REMPLISSAGE_DETECTE' && event.fuelEntryId === null) {
    const dismissed = event.status === 'QUALIFIE' && (event.qualification === 'JUSTIFIE' || event.qualification === 'ERREUR_CAPTEUR');
    return dismissed ? null : { at: event.detectedAt, kind: 'REMPLISSAGE_SANS_TICKET' };
  }
  if (event.type === 'ECART_TICKET' && event.status === 'A_QUALIFIER') return { at: event.detectedAt, kind: 'ECART_TICKET_NON_QUALIFIE' };
  return null;
}

export interface ConsumptionInterval {
  energy: FuelEnergy;
  /** Plein complet de référence A (null : aucun plein complet validé avant B). */
  startEntryId: string | null;
  endEntryId: string;
  startAt: Date | null;
  endAt: Date;
  /** Kilométrages cumulés validés des bornes (null si non validés). */
  startKm: Decimal | null;
  endKm: Decimal | null;
  distanceKm: Decimal | null;
  /** Litres achetés après A, B inclus (pleins validés de même énergie). */
  liters: Decimal;
  /** Achats de ]A, B] pris en compte ou examinés (toutes énergies et statuts). */
  entryIds: string[];
  retained: boolean;
  reasons: ConsumptionUnavailableReason[];
  /** L/100 km exact (intervalle retenu uniquement). */
  ratio: Decimal | null;
}

export interface ConsumptionTotal {
  energy: FuelEnergy;
  available: boolean;
  liters: Decimal | null;
  distanceKm: Decimal | null;
  ratio: Decimal | null;
  reasons: ConsumptionUnavailableReason[];
  retainedCount: number;
  excludedCount: number;
}

export interface ConsumptionResult {
  /** Intervalles dont B tombe dans la période, retenus et exclus, dans l'ordre chronologique. */
  intervals: ConsumptionInterval[];
  /** Consommation par énergie (jamais additionnée entre carburants différents). */
  totals: ConsumptionTotal[];
  available: boolean;
  reasons: ConsumptionUnavailableReason[];
}

export interface ConsumptionInput {
  entries: readonly ConsumptionEntry[];
  gaps: readonly PurchaseGap[];
  signals: readonly TelemetrySignal[];
  /** Bornes incluses de la période (instants) ; null = non bornée. */
  period: { from: Date | null; to: Date | null };
}

/** Ordre des pleins : filledAt, puis createdAt (D-223), puis identifiant pour un résultat déterministe. */
export function compareEntries(a: Pick<ConsumptionEntry, 'filledAt' | 'createdAt' | 'id'>, b: Pick<ConsumptionEntry, 'filledAt' | 'createdAt' | 'id'>): number {
  return a.filledAt.getTime() - b.filledAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function validatedKm(entry: ConsumptionEntry): Decimal | null {
  return entry.odometer && entry.odometer.status === 'ACCEPTE' ? entry.odometer.cumulativeKm : null;
}

function boundReason(entry: ConsumptionEntry): ConsumptionUnavailableReason | null {
  const eligibility = entryEligibility(entry);
  if (eligibility === 'COMPTEUR_NON_VALIDE' || eligibility === 'BORNE_ESTIMEE') return eligibility;
  return null;
}

function counted(entry: ConsumptionEntry, energy: FuelEnergy): boolean {
  return entry.status === 'VALIDE' && entry.energy === energy;
}

function buildInterval(a: ConsumptionEntry | null, b: ConsumptionEntry, between: readonly ConsumptionEntry[], input: ConsumptionInput): ConsumptionInterval {
  const energy = b.energy;
  const reasons = new Set<ConsumptionUnavailableReason>();
  if (a === null) {
    // Sans plein complet de référence, l'intervalle n'a pas de début : c'est le seul motif pertinent.
    reasons.add('PAS_DE_PLEIN_DE_REFERENCE');
  } else {
    const r = boundReason(a);
    if (r) reasons.add(r);
    // B et les achats intermédiaires : leurs litres sont comptés, ils doivent tous être admissibles.
    const endEligibility = entryEligibility(b);
    if (endEligibility !== 'ADMISSIBLE' && endEligibility !== 'NON_VALIDE') reasons.add(endEligibility);
    for (const m of between) {
      if (m.status === 'SOUMIS') reasons.add('PLEIN_INTERMEDIAIRE_SOUMIS');
      if (m.energy !== energy) {
        reasons.add('ENERGIE_DIFFERENTE');
        continue;
      }
      const eligibility = entryEligibility(m);
      if (eligibility !== 'ADMISSIBLE' && eligibility !== 'NON_VALIDE') reasons.add(eligibility);
    }
  }
  const examined = a === null ? between.filter((m) => m.energy === energy) : between;
  const liters = [...examined.filter((m) => counted(m, energy)), b].reduce((sum, e) => sum.plus(e.liters), new Decimal(0));
  const startKm = a ? validatedKm(a) : null;
  const endKm = validatedKm(b);
  const distanceKm = startKm !== null && endKm !== null ? endKm.minus(startKm) : null;
  if (a !== null) {
    if (distanceKm !== null && distanceKm.lte(0)) reasons.add('DISTANCE_NULLE');
    const from = a.filledAt.getTime();
    const to = b.filledAt.getTime();
    if (input.gaps.some((g) => g.startsAt.getTime() < to && g.endsAt.getTime() > from)) reasons.add('PERIODE_ACHATS_INCOMPLETS');
    for (const s of input.signals) if (s.at.getTime() > from && s.at.getTime() <= to) reasons.add(s.kind);
  }
  const ordered = CONSUMPTION_UNAVAILABLE_REASONS.filter((r) => reasons.has(r));
  const retained = ordered.length === 0 && distanceKm !== null && distanceKm.gt(0);
  return {
    energy,
    startEntryId: a?.id ?? null,
    endEntryId: b.id,
    startAt: a?.filledAt ?? null,
    endAt: b.filledAt,
    startKm,
    endKm,
    distanceKm,
    liters,
    entryIds: [...examined.map((m) => m.id), b.id],
    retained,
    reasons: ordered,
    ratio: retained && distanceKm ? per100Km(liters, distanceKm) : null,
  };
}

/** L/100 km exact : litres / km × 100. Appelé uniquement avec une distance strictement positive. */
export function per100Km(liters: Decimal, distanceKm: Decimal): Decimal {
  return liters.div(distanceKm).times(100);
}

/** Arrondi d'affichage (1 décimale à l'écran, 2 à l'export ; demi vers le haut). */
export function formatRatio(ratio: Decimal, decimals: 1 | 2): string {
  return ratio.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

function inPeriod(instant: Date, period: ConsumptionInput['period']): boolean {
  const t = instant.getTime();
  return (period.from === null || t >= period.from.getTime()) && (period.to === null || t <= period.to.getTime());
}

export function computeConsumption(input: ConsumptionInput): ConsumptionResult {
  const ordered = [...input.entries].sort(compareEntries);
  const intervals: ConsumptionInterval[] = [];
  for (const energy of FUEL_ENERGIES) {
    let reference: { entry: ConsumptionEntry; index: number } | null = null;
    ordered.forEach((entry, index) => {
      if (entry.energy !== energy || entry.status !== 'VALIDE' || !entry.isFullTank) return;
      const between = ordered.slice(reference ? reference.index + 1 : 0, index);
      const interval = buildInterval(reference?.entry ?? null, entry, between, input);
      if (inPeriod(entry.filledAt, input.period)) intervals.push(interval);
      reference = { entry, index };
    });
  }
  intervals.sort((x, y) => x.endAt.getTime() - y.endAt.getTime());

  const totals: ConsumptionTotal[] = [];
  for (const energy of FUEL_ENERGIES) {
    const own = intervals.filter((i) => i.energy === energy);
    if (own.length === 0) continue;
    const retained = own.filter((i) => i.retained);
    if (retained.length === 0) {
      const reasons = new Set(own.flatMap((i) => i.reasons));
      totals.push({ energy, available: false, liters: null, distanceKm: null, ratio: null, reasons: CONSUMPTION_UNAVAILABLE_REASONS.filter((r) => reasons.has(r)), retainedCount: 0, excludedCount: own.length });
      continue;
    }
    const liters = retained.reduce((sum, i) => sum.plus(i.liters), new Decimal(0));
    const distanceKm = retained.reduce((sum, i) => sum.plus(i.distanceKm ?? 0), new Decimal(0));
    totals.push({ energy, available: true, liters, distanceKm, ratio: per100Km(liters, distanceKm), reasons: [], retainedCount: retained.length, excludedCount: own.length - retained.length });
  }

  const available = totals.some((t) => t.available);
  let reasons: ConsumptionUnavailableReason[] = [];
  if (intervals.length === 0) reasons = ['HISTORIQUE_INSUFFISANT'];
  else if (!available) {
    const all = new Set(totals.flatMap((t) => t.reasons));
    reasons = CONSUMPTION_UNAVAILABLE_REASONS.filter((r) => all.has(r));
  }
  return { intervals, totals, available, reasons };
}
