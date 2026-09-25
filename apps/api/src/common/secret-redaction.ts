/**
 * Assainissement des textes journalisés, renvoyés par l'API ou stockés (résumés d'erreur) — CDC 14.6,
 * D-304, T44 : aucun secret fournisseur (jeton, mot de passe, identifiant de session) ne doit sortir
 * du processus. Deux mécanismes complémentaires :
 *  - motifs génériques : paramètres d'URL sensibles (token, sid, password...), identifiants intégrés
 *    aux URL (https://user:pass@hôte), en-têtes Bearer/Basic, champs JSON sensibles, y compris encodés
 *    dans une URL (paramètre params de Wialon) ;
 *  - valeurs connues : les secrets déchiffrés en mémoire le temps d'un appel fournisseur sont suivis
 *    (trackSensitiveValues) et remplacés partout où ils apparaîtraient, sous leurs formes usuelles
 *    (brute, encodée URL, base64, échappée JSON).
 */

export const REDACTED = '[expurgé]';

/** Longueur minimale d'une valeur secrète remplacée littéralement (évite de mutiler un texte ordinaire). */
const MIN_SECRET_LENGTH = 4;

const SENSITIVE_PARAM = '(?:access_token|refresh_token|id_token|token|authtoken|auth_token|sid|eid|session|sessionid|password|passwd|pwd|pass|secret|client_secret|api_?key|apikey|key|authorization|auth|signature|sig)';
const SENSITIVE_JSON_KEY = '(?:access_token|refresh_token|token|authtoken|password|passwd|pwd|pass|secret|client_secret|sid|eid|api_?key|apikey|authorization|privateKey|private_key|passphrase)';

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Identifiants intégrés à une URL : scheme://utilisateur:motdepasse@hôte
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]*@/gi, `$1${REDACTED}@`],
  // Paramètres d'URL ou de formulaire sensibles : ?token=..., &sid=..., ;password=...
  [new RegExp(`([?&;]${SENSITIVE_PARAM}=)[^&#\\s"'<>]*`, 'gi'), `$1${REDACTED}`],
  // En-têtes d'autorisation.
  [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=:-]{4,}/gi, `$1 ${REDACTED}`],
  // Champs JSON sensibles : "token":"...", "password": "..."
  [new RegExp(`("${SENSITIVE_JSON_KEY}"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1${REDACTED}"`],
  // Mêmes champs JSON encodés dans une URL : %22token%22%3A%22...%22
  [new RegExp(`(%22${SENSITIVE_JSON_KEY}%22%3A%22)(?:(?!%22).)*%22`, 'gi'), `$1${REDACTED}%22`],
  // Formes « clé=valeur » ou « clé: valeur » libres dans un message (password=..., token: ...).
  [new RegExp(`\\b(${SENSITIVE_JSON_KEY}\\s*[=:]\\s*)(?!${escapeRegExp(REDACTED)})[^\\s,;&"'}]{4,}`, 'gi'), `$1${REDACTED}`],
];

/** Secrets déchiffrés actuellement utilisés par un appel fournisseur (comptage de références). */
const tracked = new Map<string, number>();

/**
 * Déclare des valeurs secrètes présentes en mémoire le temps d'un appel ; elles sont expurgées de tout
 * texte assaini jusqu'à l'appel de la fonction de libération renvoyée.
 */
export function trackSensitiveValues(values: Iterable<string>): () => void {
  const variants = secretVariants(values);
  for (const v of variants) tracked.set(v, (tracked.get(v) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const v of variants) {
      const n = (tracked.get(v) ?? 0) - 1;
      if (n <= 0) tracked.delete(v);
      else tracked.set(v, n);
    }
  };
}

/**
 * Formes sous lesquelles un secret peut apparaître dans un texte : brute, encodée URL, base64 (en-tête
 * Basic), échappée JSON ; pour un secret composite (JSON ou « identifiant:mot de passe »), les parties
 * secrètes sont aussi prises isolément.
 */
export function secretVariants(values: Iterable<string>): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    if (value.length < MIN_SECRET_LENGTH) return;
    out.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out.add(encoded);
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    out.add(b64);
    out.add(b64.replace(/=+$/, ''));
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) out.add(jsonEscaped);
  };
  for (const raw of values) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    add(raw);
    const trimmed = raw.trim();
    if (trimmed !== raw) add(trimmed);
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined) {
      for (const leaf of sensitiveJsonLeaves(parsed)) add(leaf);
    } else {
      const colon = trimmed.indexOf(':');
      if (colon > 0 && colon < trimmed.length - 1) add(trimmed.slice(colon + 1));
      for (const line of trimmed.split(/\r?\n/)) if (line !== trimmed) add(line.trim());
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Remplace dans un texte les secrets connus (suivis ou fournis) et les motifs sensibles génériques. */
export function redactSensitiveText(text: string, extraSecrets: Iterable<string> = []): string {
  let out = text;
  const known = new Set<string>([...secretVariants(extraSecrets), ...tracked.keys()]);
  for (const secret of [...known].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * URL assainie pour la journalisation : identifiants retirés, paramètres sensibles masqués (y compris le
 * JSON du paramètre params de Wialon). Une chaîne qui n'est pas une URL est assainie comme un texte.
 */
export function sanitizeUrl(url: string, extraSecrets: Iterable<string> = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactSensitiveText(url, extraSecrets);
  }
  parsed.username = '';
  parsed.password = '';
  const sensitive = new RegExp(`^${SENSITIVE_PARAM}$`, 'i');
  for (const key of [...parsed.searchParams.keys()]) {
    if (sensitive.test(key)) {
      parsed.searchParams.set(key, REDACTED);
    } else if (key === 'params') {
      const value = parsed.searchParams.get(key) ?? '';
      parsed.searchParams.set(key, redactSensitiveText(value, extraSecrets));
    }
  }
  return redactSensitiveText(parsed.toString(), extraSecrets);
}

/** Message d'erreur sûr (assaini et borné) pour un journal, une réponse ou un résumé stocké. */
export function describeErrorSafely(error: unknown, extraSecrets: Iterable<string> = [], maxLength = 500): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Erreur inconnue.';
  const clean = redactSensitiveText(raw, extraSecrets);
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** Assainit récursivement toutes les chaînes d'une valeur sérialisable (objets de journal JSON). */
export function redactDeep(value: unknown, extraSecrets: Iterable<string> = []): unknown {
  const secrets = [...extraSecrets];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 20) return '[profondeur maximale]';
    if (typeof v === 'string') return redactSensitiveText(v, secrets);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Error) return redactSensitiveText(`${v.name}: ${v.message}`, secrets);
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = new RegExp(`^${SENSITIVE_JSON_KEY}$`, 'i').test(k) ? REDACTED : walk(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

function tryParseJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function sensitiveJsonLeaves(value: unknown): string[] {
  const out: string[] = [];
  const keyPattern = new RegExp(`^(?:${SENSITIVE_JSON_KEY}|.*(?:pass|secret|token|key).*)$`, 'i');
  const walk = (v: unknown, sensitive: boolean) => {
    if (typeof v === 'string') {
      if (sensitive) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, sensitive);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, sensitive || keyPattern.test(k));
    }
  };
  walk(value, false);
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
