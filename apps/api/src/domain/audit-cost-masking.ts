/**
 * Montants dans les valeurs avant/après du journal d'audit (CDC 2.2, 16.1 ; D-109, D-266) : un lecteur du
 * journal sans costs.read sur la société de l'événement (chef de parc dont la permission a été retirée)
 * ne doit lire aucun montant, pas plus que sur les écrans de coûts. Les valeurs des clés de montant sont
 * remplacées ; les indicateurs booléens (amountMismatch, noCost…) et les statuts textuels (costStatus)
 * ne sont pas des montants et restent lisibles.
 */

/** Valeur affichée à la place d'un montant pour un lecteur sans costs.read. */
export const COST_MASKED = '[montant masqué]';

/**
 * Clés portant un montant : total(s), coût au km, écart de montant, et toute clé terminée par
 * amount(s), price(s), cost(s), montant(s) ou prix (amount, totalAmount, unitPrice, lineAmounts,
 * signedAmount, operatingCost, linkedCost…). Comparaison sans tenir compte de la casse.
 */
const COST_KEY_PATTERN =
  /^(?:total|totals|costPerKm|amountMismatchValue)$|(?:amounts?|prices?|costs?|montants?|prix)$/i;

/** Vrai si la clé d'une valeur d'audit porte un montant. */
export function isCostAuditKey(key: string): boolean {
  return COST_KEY_PATTERN.test(key);
}

const MAX_DEPTH = 20;

/**
 * Valeur d'audit sans montant : à toute profondeur, la valeur d'une clé de montant (nombre, chaîne,
 * tableau ou objet) est remplacée par COST_MASKED ; null et booléens sont conservés. Les autres valeurs
 * sont recopiées telles quelles.
 */
export function maskAuditCosts(value: unknown): unknown {
  return walk(value, 0);
}

function walk(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return COST_MASKED;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      isCostAuditKey(k) && v !== null && v !== undefined && typeof v !== 'boolean'
        ? COST_MASKED
        : walk(v, depth + 1);
  }
  return out;
}
