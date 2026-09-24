import { Decimal } from 'decimal.js';
import { roundMoney } from '../common/decimal.js';

/**
 * Règles pures des interventions (CDC 6.3, 6.4 ; D-203, D-204, D-206, D-215). Seule définition côté
 * backend : statut initial et cohérence statut / dates prévues, montant d'une ligne, total et état du
 * coût (clôture et saisie ultérieure), rattachement à un incident.
 */

export type InterventionStatusKey = 'BROUILLON' | 'PLANIFIEE' | 'EN_COURS' | 'TERMINEE' | 'ANNULEE';
export type InterventionCostStatusKey = 'A_SAISIR' | 'SAISI' | 'SANS_COUT';
export type IncidentStatusKey = 'OUVERT' | 'EN_TRAITEMENT' | 'RESOLU' | 'CLOTURE';

/** Règle enfreinte : code stable, message français et champ concerné. */
export interface RuleViolation {
  code: string;
  message: string;
  field?: string;
}

// ---------------------------------------------------------------------------
// Statut et dates prévues (6.3, D-204)

/** Statut à la création : PLANIFIEE si un début prévu est fourni, sinon BROUILLON. */
export function statusAtCreation(plannedStartAt: Date | null): 'BROUILLON' | 'PLANIFIEE' {
  return plannedStartAt ? 'PLANIFIEE' : 'BROUILLON';
}

/**
 * Dates prévues résultant d'une création ou d'une modification (PATCH). Une modification ne change
 * jamais le statut (seules les actions plan, start, complete, cancel et reopen le font) :
 *  - la fin prévue ne précède pas le début prévu ;
 *  - une intervention PLANIFIEE garde un début prévu : l'effacer est refusé, car aucune transition
 *    PLANIFIEE → BROUILLON n'existe (D-204) — replanifiez-la (nouvelle date) ou annulez-la ;
 *  - un BROUILLON peut porter des dates indicatives et reste BROUILLON tant que l'action
 *    « Planifier » n'est pas exécutée.
 */
export function checkPlannedDates(status: InterventionStatusKey, start: Date | null, end: Date | null): RuleViolation | null {
  if (status === 'PLANIFIEE' && !start) {
    return { code: 'DATE_PREVUE_REQUISE', field: 'plannedStartAt', message: 'Une intervention planifiée garde un début prévu : indiquez une nouvelle date (replanification) ou annulez l’intervention.' };
  }
  if (start && end && end.getTime() < start.getTime()) {
    return { code: 'DATES_INCOHERENTES', field: 'plannedEndAt', message: 'La fin prévue précède le début prévu.' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coût (D-203, D-206, D-233)

/** Montant TTC d'une ligne : quantité × prix unitaire, arrondi demi vers le haut à 3 décimales. */
export function costLineAmount(quantity: Decimal, unitPrice: Decimal): Decimal {
  return roundMoney(quantity.times(unitPrice));
}

export interface CostEntry {
  /** Montants des lignes pièces / main-d'œuvre saisies (vide : aucune ligne). */
  lineAmounts: readonly Decimal[];
  /** Total TTC saisi sans lignes (chaîne décimale), absent sinon. */
  totalAmount?: string;
  /** « Sans coût » déclaré explicitement. */
  noCost: boolean;
  /** Une facture est jointe à la saisie. */
  invoice: boolean;
  /** Saisie obligatoire (POST :id/cost). À la clôture, l'absence de coût laisse le coût « à saisir ». */
  required: boolean;
}

export type CostResolution = { ok: true; total: Decimal | null; costStatus: InterventionCostStatusKey } | { ok: false; violation: RuleViolation };

/**
 * Total et état du coût (D-203, D-206) : total = somme des lignes s'il y en a, sinon total saisi ;
 * « sans coût » explicite ou total nul → SANS_COUT (aucune dépense) ; total positif → SAISI (dépense
 * unique) ; rien à la clôture → A_SAISIR. Une facture jointe exige un coût non nul : jointe à un
 * total nul ou « sans coût », elle est refusée (jamais ignorée).
 */
export function resolveCost(entry: CostEntry): CostResolution {
  const hasLines = entry.lineAmounts.length > 0;
  const hasCost = hasLines || entry.totalAmount !== undefined;
  if (entry.noCost && hasCost) return fail('COUT_CONTRADICTOIRE', 'Une intervention « sans coût » ne porte ni lignes ni total.');
  if (entry.required && !entry.noCost && !hasCost) return fail('COUT_REQUIS', 'Indiquez les lignes, le total ou « sans coût ».');
  if (hasLines && entry.totalAmount !== undefined) return fail('TOTAL_CALCULE', 'Avec des lignes, le total est leur somme : ne saisissez pas de total séparé.', 'totalAmount');
  const total = hasLines ? entry.lineAmounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0)) : entry.totalAmount !== undefined ? roundMoney(entry.totalAmount) : null;
  if (total && total.isNegative()) return fail('MONTANT_NEGATIF', 'Le total ne peut pas être négatif.', 'totalAmount');
  const costStatus: InterventionCostStatusKey = entry.noCost || (total !== null && total.isZero()) ? 'SANS_COUT' : total !== null ? 'SAISI' : 'A_SAISIR';
  if (entry.invoice && costStatus !== 'SAISI') {
    return fail('FACTURE_SANS_COUT', 'Une facture ne peut être jointe qu’à un coût non nul : un total à 0 équivaut à « sans coût » et ne crée aucune dépense. Retirez la facture ou corrigez le montant.', 'invoiceAttachmentId');
  }
  return { ok: true, total, costStatus };
}

function fail(code: string, message: string, field?: string): CostResolution {
  return { ok: false, violation: field ? { code, message, field } : { code, message } };
}

// ---------------------------------------------------------------------------
// Incident source (6.3, D-215)

/**
 * Une intervention peut être ouverte depuis un incident, ou lui être rattachée, tant qu'il n'est pas
 * clôturé : CLOTURE est final (D-215). Un incident RESOLU l'admet encore ; sa clôture attendra alors
 * que l'intervention soit terminée ou annulée.
 */
export function incidentAcceptsIntervention(status: IncidentStatusKey): boolean {
  return status !== 'CLOTURE';
}
