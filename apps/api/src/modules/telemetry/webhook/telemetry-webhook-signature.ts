import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentification des lots poussés par un fournisseur (CDC 14.4, 14.6 ; D-298 ; R-14.4-X01) — règles
 * uniques et pures :
 *  - signature = HMAC-SHA256(secret, « <horodatage>.<corps brut> ») en hexadécimal, transmise dans
 *    l'en-tête X-Webhook-Signature sous la forme « sha256=<hex> » (plusieurs valeurs séparées par des
 *    virgules admises, pour la rotation côté fournisseur) ;
 *  - horodatage = secondes Unix (UTC) dans l'en-tête X-Webhook-Timestamp, couvert par la signature :
 *    hors de la fenêtre de tolérance (passé ou futur), la requête est refusée (rejeu tardif) ;
 *  - comparaison en temps constant ; aucune valeur (secret, signature attendue) n'est jamais renvoyée
 *    ni journalisée.
 */

export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
export const WEBHOOK_SIGNATURE_SCHEME = 'sha256';
/** Nombre maximal de signatures candidates examinées dans l'en-tête. */
const MAX_SIGNATURES = 5;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

/** Motifs de refus (401) ; « INVALIDE » couvre aussi un fournisseur inconnu, sans révéler son existence. */
export type SignatureFailure = 'SIGNATURE_ABSENTE' | 'HORODATAGE_INVALIDE' | 'SIGNATURE_EXPIREE' | 'SIGNATURE_INVALIDE';

export interface SignedHeaders {
  /** Horodatage tel que signé (chaîne exacte de l'en-tête). */
  timestamp: string;
  signedAt: Date;
  /** Signatures candidates (32 octets chacune). */
  signatures: Buffer[];
}

/** Signature hexadécimale d'un corps brut pour un horodatage donné (également utilisée par les tests et la documentation). */
export function webhookSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(rawBody).digest('hex');
}

/** Valeur complète de l'en-tête X-Webhook-Signature. */
export function webhookSignatureHeader(secret: string, timestamp: string, rawBody: Buffer): string {
  return `${WEBHOOK_SIGNATURE_SCHEME}=${webhookSignature(secret, timestamp, rawBody)}`;
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Contrôle des en-têtes avant toute vérification cryptographique : présence, format, fenêtre de
 * tolérance autour de l'horloge du serveur.
 */
export function checkSignedHeaders(
  timestampHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  now: Date,
  toleranceSeconds: number,
): { ok: true; headers: SignedHeaders } | { ok: false; reason: SignatureFailure } {
  const timestamp = single(timestampHeader);
  const signature = single(signatureHeader);
  if (timestamp === null || signature === null) return { ok: false, reason: 'SIGNATURE_ABSENTE' };
  if (!TIMESTAMP_PATTERN.test(timestamp)) return { ok: false, reason: 'HORODATAGE_INVALIDE' };
  const signedAtMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(signedAtMs)) return { ok: false, reason: 'HORODATAGE_INVALIDE' };
  if (Math.abs(now.getTime() - signedAtMs) > toleranceSeconds * 1000) return { ok: false, reason: 'SIGNATURE_EXPIREE' };
  const signatures: Buffer[] = [];
  for (const part of signature.split(',').slice(0, MAX_SIGNATURES)) {
    const match = SIGNATURE_PATTERN.exec(part.trim());
    if (match?.[1]) signatures.push(Buffer.from(match[1].toLowerCase(), 'hex'));
  }
  if (signatures.length === 0) return { ok: false, reason: 'SIGNATURE_INVALIDE' };
  return { ok: true, headers: { timestamp, signedAt: new Date(signedAtMs), signatures } };
}

/**
 * Vrai si l'une des signatures reçues correspond à l'un des secrets admis (secret actif, puis secret
 * remplacé encore dans sa période de recouvrement). Chaque comparaison est en temps constant.
 */
export function matchesAnySecret(secrets: readonly string[], headers: SignedHeaders, rawBody: Buffer): boolean {
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(webhookSignature(secret, headers.timestamp, rawBody), 'hex');
    for (const candidate of headers.signatures) {
      // Pas de sortie anticipée : même nombre de comparaisons quel que soit le rang de la correspondance.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
    }
  }
  return matched;
}

function single(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
