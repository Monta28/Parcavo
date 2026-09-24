import { Decimal } from 'decimal.js';
import { isPositiveDecimalString } from './money.js';

/**
 * Registre unique des dépenses (CDC 8.4, D-229, D-230, D-232, D-233) : règles de calcul pures.
 * Seules les dépenses VALIDEE comptent, à leur date d'origine ; un avoir (montant positif saisi)
 * réduit le coût ; une dépense sans véhicule reste dans les totaux société mais forme la ligne
 * « Non ventilé » ; une dépense exclue du coût d'exploitation (achat de véhicule par défaut) est
 * conservée à titre informatif hors du coût d'exploitation. Montants en décimal exact.
 */

export const EXPENSE_CATEGORIES = ['ENTRETIEN_REPARATION', 'CARBURANT', 'ASSURANCE', 'LOCATION', 'TAXES', 'PEAGE', 'STATIONNEMENT', 'ACHAT_VEHICULE', 'AUTRE'] as const;
export type ExpenseCategoryKey = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_KINDS = ['DEPENSE', 'AVOIR'] as const;
export type ExpenseKindKey = (typeof EXPENSE_KINDS)[number];
export const EXPENSE_STATUSES = ['VALIDEE', 'ANNULEE', 'REMPLACEE'] as const;
export type ExpenseStatusKey = (typeof EXPENSE_STATUSES)[number];

/** Catégories admises sans véhicule (coûts de flotte, D-230) : miroir de la contrainte SQL expense_vehicle_required_by_category. */
export const VEHICLE_OPTIONAL_CATEGORIES: readonly ExpenseCategoryKey[] = ['ASSURANCE', 'TAXES', 'LOCATION', 'AUTRE'];

/** Libellé d'une dépense sans véhicule dans les vues (D-230). */
export const UNALLOCATED_EXPENSE_LABEL = 'Dépense société non affectée';
/** Libellé de la ligne de synthèse regroupant les dépenses sans véhicule (D-230). */
export const UNALLOCATED_LINE_LABEL = 'Non ventilé';

/** Nombre de décimales des montants (TND, D-233). */
export const MONEY_DECIMALS = 3;

/**
 * Sommes exactes : le constructeur global de decimal.js arrondit chaque opération à 20 chiffres
 * significatifs, alors qu'un total de DECIMAL(18,3) peut en compter davantage (15 + 3 chiffres par
 * ligne, plus les retenues). Les instances restent des Decimal (prototype partagé).
 */
const Exact = Decimal.clone({ precision: 64 });

export function isVehicleOptional(category: ExpenseCategoryKey): boolean {
  return VEHICLE_OPTIONAL_CATEGORIES.includes(category);
}

/** Seules les dépenses validées comptent : une annulation ou un remplacement retire le coût de sa période d'origine (D-229). */
export function countsInTotals(status: ExpenseStatusKey): boolean {
  return status === 'VALIDEE';
}

/** Achat de véhicule : exclu par défaut du coût d'exploitation (8.4, D-233), selon le paramètre du groupe. */
export function defaultExcludedFromOperatingCost(category: ExpenseCategoryKey, vehiclePurchaseExcludedByDefault: boolean): boolean {
  return category === 'ACHAT_VEHICULE' && vehiclePurchaseExcludedByDefault;
}

/** Montant signé : un avoir est saisi en positif et soustrait (D-229). */
export function signedAmount(kind: ExpenseKindKey, amount: Decimal.Value): Decimal {
  const value = new Exact(amount instanceof Decimal ? amount.toString() : amount);
  return kind === 'AVOIR' ? value.negated() : value;
}

/** Net exact (dépenses − avoirs) ; un net négatif est rendu tel quel. */
export function netAmount(rows: ReadonlyArray<{ kind: ExpenseKindKey; amount: Decimal.Value }>): Decimal {
  return rows.reduce((sum, r) => sum.plus(signedAmount(r.kind, r.amount)), new Exact(0));
}

/**
 * Contrôle d'un montant saisi (TTC, D-233) : décimal exact strictement positif, trois décimales au
 * plus. Renvoie le motif du refus, ou null si le montant est recevable. Aucun arrondi silencieux.
 */
export function amountRejection(input: string): string | null {
  // Règle unique des montants saisis (domain/money.ts) : chaîne décimale exacte, > 0, DECIMAL(18,3).
  if (isPositiveDecimalString(input, MONEY_DECIMALS)) return null;
  if (/^0{1,15}(\.0{1,3})?$/.test(input)) return 'Le montant TTC doit être strictement positif.';
  return 'Montant invalide : nombre positif, trois décimales au plus (ex. 125.500).';
}

/** Référence fournisseur normalisée (espaces superflus retirés) ; vide → absente. La comparaison d'unicité ignore la casse (D-232). */
export function normalizeReference(reference: string | null | undefined): string | null {
  if (reference === null || reference === undefined) return null;
  const cleaned = reference.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

export interface LedgerRow {
  category: ExpenseCategoryKey;
  kind: ExpenseKindKey;
  status: ExpenseStatusKey;
  amount: Decimal.Value;
  vehicleId: string | null;
  excludedFromOperatingCost: boolean;
}

export interface LedgerBucket {
  /** Somme des dépenses (DEPENSE). */
  expenses: Decimal;
  /** Somme des avoirs (AVOIR), en positif. */
  credits: Decimal;
  /** Dépenses − avoirs. */
  net: Decimal;
  count: number;
}

export interface LedgerSummary {
  /** Coût d'exploitation par catégorie (ordre des catégories du CDC). */
  byCategory: Array<{ category: ExpenseCategoryKey } & LedgerBucket>;
  /** Coût d'exploitation total (inclut les dépenses sans véhicule). */
  operating: LedgerBucket;
  /** Part du coût d'exploitation sans véhicule : ligne « Non ventilé », jamais répartie. */
  unallocated: LedgerBucket;
  /** Dépenses conservées à titre informatif, hors coût d'exploitation (achats de véhicules par défaut). */
  excluded: LedgerBucket & { byCategory: Array<{ category: ExpenseCategoryKey } & LedgerBucket> };
}

function emptyBucket(): LedgerBucket {
  return { expenses: new Exact(0), credits: new Exact(0), net: new Exact(0), count: 0 };
}

function add(bucket: LedgerBucket, row: LedgerRow): void {
  const amount = new Exact(row.amount instanceof Decimal ? row.amount.toString() : row.amount);
  if (row.kind === 'AVOIR') bucket.credits = bucket.credits.plus(amount);
  else bucket.expenses = bucket.expenses.plus(amount);
  bucket.net = bucket.net.plus(signedAmount(row.kind, amount));
  bucket.count += 1;
}

function orderedCategories(map: Map<ExpenseCategoryKey, LedgerBucket>): Array<{ category: ExpenseCategoryKey } & LedgerBucket> {
  return EXPENSE_CATEGORIES.filter((c) => map.has(c)).map((c) => ({ category: c, ...(map.get(c) as LedgerBucket) }));
}

/** Synthèse du registre : les dépenses non validées sont ignorées ; aucune ligne n'est comptée deux fois. */
export function summarizeLedger(rows: readonly LedgerRow[]): LedgerSummary {
  const operating = emptyBucket();
  const unallocated = emptyBucket();
  const excluded = emptyBucket();
  const byCategory = new Map<ExpenseCategoryKey, LedgerBucket>();
  const excludedByCategory = new Map<ExpenseCategoryKey, LedgerBucket>();
  for (const row of rows) {
    if (!countsInTotals(row.status)) continue;
    if (row.excludedFromOperatingCost) {
      add(excluded, row);
      if (!excludedByCategory.has(row.category)) excludedByCategory.set(row.category, emptyBucket());
      add(excludedByCategory.get(row.category) as LedgerBucket, row);
      continue;
    }
    add(operating, row);
    if (!byCategory.has(row.category)) byCategory.set(row.category, emptyBucket());
    add(byCategory.get(row.category) as LedgerBucket, row);
    if (row.vehicleId === null) add(unallocated, row);
  }
  return { byCategory: orderedCategories(byCategory), operating, unallocated, excluded: { ...excluded, byCategory: orderedCategories(excludedByCategory) } };
}
