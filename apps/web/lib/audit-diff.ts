// Mise en regard des valeurs avant/après d'un événement d'audit, pour l'affichage uniquement. Les valeurs
// arrivent déjà expurgées par l'API (GET /audit) ; rien n'est recalculé ni interprété ici.

export type AuditChange = 'AJOUTE' | 'RETIRE' | 'MODIFIE' | 'INCHANGE';

export const AUDIT_CHANGE_LABELS: Readonly<Record<AuditChange, string>> = {
  AJOUTE: 'Ajouté',
  RETIRE: 'Retiré',
  MODIFIE: 'Modifié',
  INCHANGE: 'Inchangé',
};

export interface AuditDiffRow {
  key: string;
  before: unknown;
  after: unknown;
  hasBefore: boolean;
  hasAfter: boolean;
  change: AuditChange;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Représentation canonique (clés triées) : deux objets égaux au contenu près de l'ordre des clés. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Lignes champ par champ (premier niveau) lorsque avant et après sont des objets, ou absents (création,
 * suppression). Renvoie null si l'une des valeurs n'est pas un objet : l'écran montre alors le JSON brut.
 */
export function auditDiff(before: unknown, after: unknown): AuditDiffRow[] | null {
  const b = before === null || before === undefined ? {} : isPlainObject(before) ? before : null;
  const a = after === null || after === undefined ? {} : isPlainObject(after) ? after : null;
  if (b === null || a === null) return null;
  const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !Object.hasOwn(b, k))];
  return keys.map((key) => {
    const hasBefore = Object.hasOwn(b, key);
    const hasAfter = Object.hasOwn(a, key);
    const change: AuditChange = !hasBefore ? 'AJOUTE' : !hasAfter ? 'RETIRE' : canonical(b[key]) === canonical(a[key]) ? 'INCHANGE' : 'MODIFIE';
    return { key, before: b[key], after: a[key], hasBefore, hasAfter, change };
  });
}

/** Texte lisible d'une valeur JSON : chaîne telle quelle, objets et tableaux indentés. */
export function formatAuditValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** JSON indenté d'une valeur avant/après complète (null si absente). */
export function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, null, 2);
}
