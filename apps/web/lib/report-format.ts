// Mise en forme des cellules de rapport (CDC 11.2, 11.3) : affichage seul des valeurs renvoyées par l'API,
// sans arrondi ni recalcul (les décimaux arrivent en chaînes déjà arrondies selon meta.columns).
import { formatDate, formatDateTime } from './format';
import type { ReportColumn } from './reports-types';

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Nombre décimal exact en français : milliers séparés par une espace fine insécable, virgule décimale.
 * La chaîne est reprise chiffre à chiffre (aucune conversion en flottant, aucun arrondi).
 */
export function formatDecimalText(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = NUMBER_TEXT.exec(text);
  if (!match) return text;
  const [, sign = '', integer = '', fraction] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${grouped}${fraction ? `,${fraction}` : ''}`;
}

/** En-tête d'une colonne avec son unité, comme dans l'export (D-270). */
export function reportHeader(column: Pick<ReportColumn, 'label' | 'unit'>): string {
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

export type CellDisplay =
  /** Valeur présente, mise en forme ; `numeric` : alignée à droite. */
  | { kind: 'value'; text: string; numeric: boolean }
  /** Valeur d'énumération signalant une estimation. */
  | { kind: 'estimate'; text: string }
  /** Valeur absente : libellé fourni par l'API (N/D, Inconnu…) ou tiret. */
  | { kind: 'missing'; text: string }
  /** Colonne de coût retirée de cette ligne par l'API (pas de costs.read sur sa société). */
  | { kind: 'hidden' };

/** Affichage d'une cellule selon la colonne décrite par l'API. */
export function reportCellDisplay(column: ReportColumn, item: Record<string, unknown>, timezone: string): CellDisplay {
  if (!(column.key in item)) return column.cost ? { kind: 'hidden' } : { kind: 'missing', text: column.missing ?? '—' };
  const value = item[column.key];
  if (value === null || value === undefined || value === '') return { kind: 'missing', text: column.missing ?? '—' };
  switch (column.kind) {
    case 'decimal':
    case 'money':
    case 'integer':
      return typeof value === 'string' || typeof value === 'number' ? { kind: 'value', text: formatDecimalText(value), numeric: true } : { kind: 'value', text: String(value), numeric: true };
    case 'boolean':
      return { kind: 'value', text: value === true ? 'Oui' : 'Non', numeric: false };
    case 'date':
      return { kind: 'value', text: formatDate(String(value), timezone), numeric: false };
    case 'datetime':
      return { kind: 'value', text: formatDateTime(String(value), timezone), numeric: false };
    case 'enum': {
      const code = String(value);
      const text = column.labels?.[code] ?? code;
      // Estimation (borne GPS, distance ou coût/km estimés — D-276) : valeurs désignées par l'API dans meta.columns.
      return column.estimates?.includes(code) ? { kind: 'estimate', text } : { kind: 'value', text, numeric: false };
    }
    default:
      return { kind: 'value', text: String(value), numeric: false };
  }
}

/** Nom de fichier annoncé par l'API (Content-Disposition ; forme UTF-8 de la RFC 5987 prioritaire). */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Forme étendue mal encodée : on se rabat sur la forme simple.
    }
  }
  const simple = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return simple?.[1]?.trim() || fallback;
}
