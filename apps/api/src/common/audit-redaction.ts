import { REDACTED, redactSensitiveText } from './secret-redaction.js';

/**
 * Expurgation des valeurs d'audit (CDC 16.1 ; D-109) : aucune valeur avant/après ne doit porter un mot de
 * passe, un jeton, une empreinte, un chiffré ou une clé. La même règle de clés sert à l'écriture
 * (infra/audit.service.ts) et, défensivement, à la lecture (GET /audit) : un événement écrit par un autre
 * chemin (traitement différé, script, version antérieure) ne peut pas faire sortir de secret.
 */

/**
 * Noms de clés sensibles, comparés sans tenir compte de la casse : mots de passe, jetons, secrets,
 * empreintes (hash), chiffrés et vecteurs, en-têtes d'autorisation, cookies, identifiants de connexion,
 * clés d'API ou privées, signatures. Les clés d'identification métier (« key » d'un paramètre, « kind »)
 * ne sont pas visées.
 */
const SENSITIVE_KEY_PATTERN =
  /passw(?:or)?d|passphrase|^pass$|^pwd$|secret|token|hash|cipher|auth_?tag|authorization|cookie|credentials?$|^credential_?value$|api_?key|private_?key|access_?key|secret_?key|signature|^iv$|^sid$|^otp$|^pin$/i;

/** Vrai si une clé d'objet d'audit doit voir sa valeur masquée. */
export function isSensitiveAuditKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Empreintes de mot de passe (Argon2, bcrypt, scrypt, PBKDF2) et jetons JWT reconnus à leur forme. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^\$(?:argon2(?:id|i|d)|2[abxy]?|scrypt|pbkdf2(?:-sha\d+)?)\$/i,
  /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/,
];

/** Vrai si la chaîne a la forme d'une empreinte de mot de passe ou d'un jeton signé. */
export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return SECRET_VALUE_PATTERNS.some((p) => p.test(trimmed));
}

const MAX_DEPTH = 20;

/**
 * Valeur d'audit assainie pour la lecture : clés sensibles masquées à toute profondeur, chaînes passées au
 * filtre de secrets (identifiants dans une URL, en-têtes Bearer/Basic, « password=… », JSON embarqué) et
 * empreintes/jetons reconnus masqués. Les nombres, booléens et null sont conservés.
 */
export function sanitizeAuditValue(value: unknown): unknown {
  return walk(value, 0);
}

function walk(value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return null;
  if (depth > MAX_DEPTH) return '[profondeur maximale]';
  if (typeof value === 'string')
    return looksLikeSecretValue(value) ? REDACTED : redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveAuditKey(k) ? REDACTED : walk(v, depth + 1);
    }
    return out;
  }
  return null;
}
