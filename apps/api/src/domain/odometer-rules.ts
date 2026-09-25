import { Decimal } from 'decimal.js';
import { formatLocalDateTime } from './civil-date.js';
import { kmLabel } from './km-display.js';

/**
 * Règles de kilométrage (CDC 5.1 à 5.4, 5.6) — implémentation unique, sans dépendance à la base.
 *
 *  - Segment de compteur : kmCumules = kmCumulesDebutSegment + (compteurPhysique - compteurPhysiqueDebutSegment).
 *  - Chronologie : un relevé est contrôlé contre ses voisins acceptés (précédent et suivant selon la date
 *    d'observation) dans le même segment ; seuls les relevés non estimés (manuels, import, CAN) comptent.
 *  - Diminution inexpliquée : refusée pour un relevé manuel ; mise en attente pour un relevé automatique.
 *  - Hausse supérieure au seuil de plausibilité rapporté à la durée écoulée : mise en attente avec explication.
 *  - Même instant : même valeur = idempotent ; valeur différente = conflit.
 */

export type ReadingOrigin = 'MANUAL' | 'IMPORT' | 'TELEMATICS';

export interface SegmentBase {
  startPhysicalKm: Decimal;
  startCumulativeKm: Decimal;
}

export interface NeighborReading {
  id: string;
  physicalKm: Decimal;
  observedAt: Date;
}

export interface PlausibilityPolicy {
  /** Distance maximale plausible par période de 24 h (filtre administratif, pas une limite physique). */
  maxKmPerDay: Decimal;
  /** Tolérance minimale quelle que soit la durée écoulée (relevés rapprochés). */
  minAllowanceKm: Decimal;
}

export type Evaluation =
  | { outcome: 'ACCEPT' }
  | { outcome: 'IDEMPOTENT'; existingId: string }
  | { outcome: 'PENDING'; code: AnomalyCode; reason: string }
  | { outcome: 'REJECT'; code: AnomalyCode; reason: string }
  | { outcome: 'CONFLICT'; code: AnomalyCode; reason: string; existingId: string };

export type AnomalyCode =
  | 'VALEUR_NEGATIVE'
  | 'DATE_FUTURE'
  | 'DIMINUTION'
  | 'CHRONOLOGIE_SUIVANT'
  | 'HAUSSE_IMPLAUSIBLE'
  | 'CONFLIT_MEME_INSTANT'
  | 'AVANT_DEBUT_SEGMENT'
  | 'INFERIEUR_DEBUT_SEGMENT';

/**
 * Champ de saisie concerné par une anomalie (erreurs de champ des API de saisie et de correction) :
 * date d'observation pour une date future ou antérieure au compteur, valeur du compteur sinon.
 */
export function readingFieldForAnomaly(code: string): 'physicalKm' | 'observedAt' {
  return code === 'DATE_FUTURE' || code === 'AVANT_DEBUT_SEGMENT' ? 'observedAt' : 'physicalKm';
}

export function cumulativeKm(segment: SegmentBase, physicalKm: Decimal): Decimal {
  return segment.startCumulativeKm.plus(physicalKm.minus(segment.startPhysicalKm));
}

/** Libellé « … km » tronqué (règle unique : domain/km-display.ts). */
export function formatKm(value: Decimal): string {
  return kmLabel(value);
}

const DAY_MS = 24 * 3600 * 1000;

/** Hausse maximale plausible entre deux instants. */
export function allowedIncrease(policy: PlausibilityPolicy, from: Date, to: Date): Decimal {
  const days = Math.max(0, to.getTime() - from.getTime()) / DAY_MS;
  const byRate = policy.maxKmPerDay.times(days);
  return Decimal.max(policy.minAllowanceKm, byRate);
}

/**
 * Segment 1 d'initialisation ordinaire (D-167) : créé automatiquement au premier relevé du personnel (ou,
 * provisoirement, à la première soumission conducteur), cumul égal au compteur physique, sans relevé
 * d'initialisation explicite. Son début n'est pas une valeur déclarée : c'est le premier relevé accepté.
 * Un segment initialisé explicitement (base cumulée, cumul incomplet, date d'installation) ou issu d'un
 * remplacement n'est jamais ordinaire.
 */
export function isOrdinaryFirstSegment(
  segment: { sequence: number; cumulativeKnown: boolean; startPhysicalKm: Decimal; startCumulativeKm: Decimal },
  hasInitialisationReading: boolean,
): boolean {
  return segment.sequence === 1 && segment.cumulativeKnown && segment.startCumulativeKm.equals(segment.startPhysicalKm) && !hasInitialisationReading;
}

/**
 * Début d'un segment 1 ordinaire (D-167) aligné sur son premier relevé accepté (physique = cumulé) : la
 * valeur de début suit ce relevé (relevé antérieur, correction du premier relevé, soumission rejetée
 * remplacée par un relevé du personnel) et la période couverte ne recule jamais. Null : rien à changer.
 */
export function ordinaryFirstSegmentStart(
  current: { startedAt: Date; startPhysicalKm: Decimal },
  earliestAccepted: { observedAt: Date; physicalKm: Decimal } | null,
): { startedAt: Date; startPhysicalKm: Decimal } | null {
  if (!earliestAccepted) return null;
  const startedAt = earliestAccepted.observedAt < current.startedAt ? earliestAccepted.observedAt : current.startedAt;
  if (startedAt.getTime() === current.startedAt.getTime() && earliestAccepted.physicalKm.equals(current.startPhysicalKm)) return null;
  return { startedAt, startPhysicalKm: earliestAccepted.physicalKm };
}

export interface EvaluateInput {
  origin: ReadingOrigin;
  physicalKm: Decimal;
  observedAt: Date;
  now: Date;
  /** Fuseau de l'organisation : les dates citées dans les motifs sont affichées en heure locale. */
  timezone: string;
  /**
   * `ordinary` : segment 1 d'initialisation ordinaire (isOrdinaryFirstSegment) ; son début n'étant que le
   * premier relevé accepté, seuls les voisins acceptés contraignent le relevé (ni AVANT_DEBUT_SEGMENT ni
   * INFERIEUR_DEBUT_SEGMENT).
   */
  segment: SegmentBase & { startedAt: Date; ordinary?: boolean };
  /** Relevé accepté non estimé au même instant, s'il existe. */
  sameInstant: NeighborReading | null;
  previous: NeighborReading | null;
  next: NeighborReading | null;
  policy: PlausibilityPolicy;
  /** Tolérance d'horloge pour la date future (défaut : 5 minutes). */
  futureToleranceMs?: number;
}

/**
 * Évalue un relevé candidat. Le résultat décide du statut ; la politique d'auteur (conducteur → attente)
 * est appliquée ensuite par le service d'ingestion.
 */
/**
 * Fenêtre « même instant » (D-149) : observedAt tronqué à la minute pour MANUAL et IMPORT, à la
 * seconde pour TELEMATICS. Sert à l'idempotence et au conflit de même instant.
 */
export function instantWindow(origin: 'MANUAL' | 'IMPORT' | 'TELEMATICS', observedAt: Date): { gte: Date; lt: Date } {
  const step = origin === 'TELEMATICS' ? 1000 : 60_000;
  const start = Math.floor(observedAt.getTime() / step) * step;
  return { gte: new Date(start), lt: new Date(start + step) };
}

export function evaluateReading(input: EvaluateInput): Evaluation {
  const automatic = input.origin === 'TELEMATICS';
  const tolerance = input.futureToleranceMs ?? 5 * 60 * 1000;
  if (input.physicalKm.isNegative()) {
    return { outcome: 'REJECT', code: 'VALEUR_NEGATIVE', reason: 'La valeur du compteur ne peut pas être négative.' };
  }
  if (input.observedAt.getTime() > input.now.getTime() + tolerance) {
    return { outcome: 'REJECT', code: 'DATE_FUTURE', reason: 'La date d’observation ne peut pas être dans le futur.' };
  }
  if (!input.segment.ordinary && input.observedAt.getTime() < input.segment.startedAt.getTime()) {
    const reason = 'La date d’observation précède le début du compteur courant : saisissez le relevé sur le segment concerné.';
    return automatic ? { outcome: 'PENDING', code: 'AVANT_DEBUT_SEGMENT', reason } : { outcome: 'REJECT', code: 'AVANT_DEBUT_SEGMENT', reason };
  }
  if (input.sameInstant) {
    if (input.sameInstant.physicalKm.eq(input.physicalKm)) return { outcome: 'IDEMPOTENT', existingId: input.sameInstant.id };
    const reason = `Un relevé accepté de ${formatKm(input.sameInstant.physicalKm)} existe déjà au même instant.`;
    return automatic
      ? { outcome: 'PENDING', code: 'CONFLIT_MEME_INSTANT', reason }
      : { outcome: 'CONFLICT', code: 'CONFLIT_MEME_INSTANT', reason, existingId: input.sameInstant.id };
  }
  if (input.previous && input.physicalKm.lt(input.previous.physicalKm)) {
    const reason = `Diminution inexpliquée : ${formatKm(input.physicalKm)} après ${formatKm(input.previous.physicalKm)} relevé le ${formatLocalDateTime(input.previous.observedAt, input.timezone, { sentence: true })}. Une correction ou un remplacement de compteur est nécessaire.`;
    return automatic ? { outcome: 'PENDING', code: 'DIMINUTION', reason } : { outcome: 'REJECT', code: 'DIMINUTION', reason };
  }
  if (!input.segment.ordinary && !input.previous && input.physicalKm.lt(input.segment.startPhysicalKm)) {
    const reason = `La valeur est inférieure à la valeur initiale du compteur (${formatKm(input.segment.startPhysicalKm)}). Un changement de compteur doit être enregistré explicitement.`;
    return automatic ? { outcome: 'PENDING', code: 'INFERIEUR_DEBUT_SEGMENT', reason } : { outcome: 'REJECT', code: 'INFERIEUR_DEBUT_SEGMENT', reason };
  }
  if (input.next && input.physicalKm.gt(input.next.physicalKm)) {
    const reason = `Chronologie rompue : ${formatKm(input.physicalKm)} dépasse le relevé suivant de ${formatKm(input.next.physicalKm)} (${formatLocalDateTime(input.next.observedAt, input.timezone, { sentence: true })}).`;
    return automatic ? { outcome: 'PENDING', code: 'CHRONOLOGIE_SUIVANT', reason } : { outcome: 'REJECT', code: 'CHRONOLOGIE_SUIVANT', reason };
  }
  if (input.previous) {
    const increase = input.physicalKm.minus(input.previous.physicalKm);
    const allowed = allowedIncrease(input.policy, input.previous.observedAt, input.observedAt);
    if (increase.gt(allowed)) {
      return {
        outcome: 'PENDING',
        code: 'HAUSSE_IMPLAUSIBLE',
        reason: `Hausse de ${formatKm(increase)} depuis le relevé précédent, au-delà du seuil de plausibilité (${formatKm(allowed)} pour la durée écoulée) : validation requise.`,
      };
    }
  }
  return { outcome: 'ACCEPT' };
}

/**
 * Compteur courant (5.3, 5.6) : le relevé accepté le plus récent selon la date d'observation, toutes sources
 * confondues ; à date égale, le relevé saisi le plus tard. Un relevé historique ne fait pas reculer le compteur.
 */
export function pickCurrent<T extends { observedAt: Date; enteredAt: Date }>(accepted: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of accepted) {
    if (!best || r.observedAt > best.observedAt || (r.observedAt.getTime() === best.observedAt.getTime() && r.enteredAt > best.enteredAt)) best = r;
  }
  return best;
}

/** Distance entre deux relevés cumulés (11.3) : null si l'un manque ou si le résultat serait négatif. */
export function distanceBetween(start: Decimal | null, end: Decimal | null): Decimal | null {
  if (start === null || end === null) return null;
  const d = end.minus(start);
  return d.isNegative() ? null : d;
}
