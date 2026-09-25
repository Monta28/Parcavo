import { SETTING_DESCRIPTORS, type SettingDescriptor, type SettingKey } from '@parc-auto/contracts';

/**
 * Écran Administration › Paramètres (CDC 17.1) : types des réponses de GET /settings et
 * GET /settings/:key/history, et conversions d'affichage et de saisie. Aucune règle métier ici :
 * bornes, types et droits sont contrôlés par l'API (PUT /settings/:key), dont les erreurs sont affichées.
 */

export type SettingSource = 'defaut' | 'groupe' | 'societe';

/** Paramètre effectif (GET /settings?companyId=). */
export interface EffectiveSetting {
  key: string;
  label: string;
  unit: string | null;
  value: unknown;
  source: SettingSource;
  settingVersion: number | null;
  companyOverride: boolean;
  /** Faux pour une valeur fixe du produit (affichée, non modifiable). */
  editable: boolean;
}

/** Version d'un paramètre (GET /settings/:key/history). */
export interface SettingVersion {
  companyId: string | null;
  value: unknown;
  settingVersion: number;
  isCurrent: boolean;
  reason: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
}

export const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
  defaut: 'Défaut du produit',
  groupe: 'Valeur groupe',
  societe: 'Surcharge société',
};

/** Rubriques de l'écran, par préfixe de clé (ordre d'affichage). */
const SECTION_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['odometer', 'Kilométrage'],
  ['maintenance', 'Entretien'],
  ['documents', 'Documents'],
  ['usage', 'Remises et restitutions'],
  ['reservations', 'Réservations'],
  ['drivers', 'Conducteurs'],
  ['incidents', 'Incidents'],
  ['fuel', 'Carburant'],
  ['expenses', 'Dépenses'],
  ['reports', 'Rapports'],
  ['alerts', 'Alertes'],
  ['email', 'E-mails'],
  ['attachments', 'Pièces jointes'],
  ['imports', 'Imports'],
  ['telemetry', 'Télématique (F11)'],
  ['session', 'Sécurité'],
  ['pagination', 'Listes et API'],
];

export function descriptorOf(key: string): SettingDescriptor | undefined {
  return (SETTING_DESCRIPTORS as Record<string, SettingDescriptor | undefined>)[key];
}

/** Regroupe les paramètres par rubrique, dans l'ordre des rubriques puis de l'API. */
export function groupSettings<T extends { key: string }>(settings: readonly T[]): Array<{ label: string; items: T[] }> {
  const groups = SECTION_LABELS.map(([prefix, label]) => ({ label, items: settings.filter((s) => s.key.split('.')[0] === prefix) }));
  const known = new Set(SECTION_LABELS.map(([prefix]) => prefix));
  const others = settings.filter((s) => !known.has(s.key.split('.')[0] ?? ''));
  return [...groups, { label: 'Autres', items: others }].filter((g) => g.items.length > 0);
}

/** Filtre de recherche : libellé ou clé, sans tenir compte de la casse ni des accents. */
export function matchesSearch(setting: { key: string; label: string }, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return normalize(setting.label).includes(q) || normalize(setting.key).includes(q);
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

/** Valeur lisible (unités en clair, listes, oui/non) ; une valeur inattendue est montrée telle quelle. */
export function formatSettingValue(key: string, value: unknown): string {
  const d = descriptorOf(key);
  const unit = d?.unit ? ` ${d.unit}` : '';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'number') {
    const base = `${NUMBER.format(value)}${unit}`;
    if (d?.unit === 'octets') return `${base} (${NUMBER.format(value / (1024 * 1024))} Mo)`;
    if (d?.unit === 'ratio') return `${base} (${NUMBER.format(value * 100)} %)`;
    return base;
  }
  if (Array.isArray(value)) {
    if (d?.kind === 'string-list') return value.length === 0 ? 'Liste vide' : value.map(String).join(' · ');
    return `${value.map((v) => (typeof v === 'number' ? NUMBER.format(v) : String(v))).join(', ')}${unit}`;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Texte initial du champ de saisie pour une valeur. */
export function settingToInput(key: string, value: unknown): string {
  const d = descriptorOf(key);
  if (Array.isArray(value)) return d?.kind === 'string-list' ? value.map(String).join('\n') : value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Convertit la saisie en valeur JSON envoyée à l'API, sans la valider : un texte non numérique est envoyé
 * tel quel pour que le serveur réponde avec son message (« un entier est attendu. », bornes…).
 */
export function inputToSettingValue(key: string, text: string): unknown {
  const kind = descriptorOf(key)?.kind;
  const asNumber = (raw: string): number | string => {
    const t = raw.trim().replace(/\s/g, '').replace(',', '.');
    return t !== '' && /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : raw.trim();
  };
  switch (kind) {
    case 'integer':
    case 'number':
      return asNumber(text);
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text;
    case 'integer-list':
      return text
        .split(/[;,\n]+/)
        .map((v) => v.trim())
        .filter((v) => v !== '')
        .map(asNumber);
    case 'string-list':
      return text
        .split('\n')
        .map((v) => v.trim())
        .filter((v) => v !== '');
    default:
      return text.trim();
  }
}

/** Indication des bornes acceptées par l'API, affichée sous le champ. */
export function boundsHint(key: string): string | null {
  const d = descriptorOf(key);
  if (!d) return null;
  const unit = d.unit ? ` ${d.unit}` : '';
  switch (d.kind) {
    case 'integer':
    case 'number': {
      const decimalsText = d.decimals !== undefined ? `, ${d.decimals} décimales au plus` : '';
      const kindText = d.kind === 'integer' ? 'Nombre entier' : `Nombre (décimales avec une virgule ou un point${decimalsText})`;
      if (d.min !== undefined && d.max !== undefined) return `${kindText} de ${NUMBER.format(d.min)} à ${NUMBER.format(d.max)}${unit}.`;
      return `${kindText}.`;
    }
    case 'integer-list':
      return `De 1 à 10 entiers séparés par des virgules${d.min !== undefined && d.max !== undefined ? `, chacun de ${NUMBER.format(d.min)} à ${NUMBER.format(d.max)}${unit}` : ''} ; triés automatiquement, doublons retirés.`;
    case 'string-list':
      return 'Un élément par ligne (80 caractères au plus, 30 éléments au plus).';
    case 'time':
      return 'Heure locale au format HH:MM.';
    case 'boolean':
      return null;
  }
}

/**
 * Version attendue par le verrou optimiste de PUT /settings/:key pour le niveau modifié : la version de la
 * valeur de ce niveau si elle existe (groupe, ou surcharge de la société affichée), 0 sinon.
 */
export function expectedVersionFor(setting: Pick<EffectiveSetting, 'source' | 'settingVersion'>, companyId: string | null): number {
  const ownLevel = companyId ? setting.source === 'societe' : setting.source === 'groupe';
  return ownLevel ? (setting.settingVersion ?? 0) : 0;
}

/** Historique d'un niveau : groupe seul pour la vue groupe, groupe et société pour une société. */
export function historyForScope(rows: readonly SettingVersion[], companyId: string | null): SettingVersion[] {
  return companyId ? rows.filter((r) => r.companyId === null || r.companyId === companyId) : [...rows];
}

export function isSettingKey(key: string): key is SettingKey {
  return descriptorOf(key) !== undefined;
}
