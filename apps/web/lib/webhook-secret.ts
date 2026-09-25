// Génération du secret de signature d'un webhook fournisseur (D-298) dans le navigateur de
// l'administrateur : 32 octets du générateur cryptographique (Web Crypto), encodés en base64url et
// préfixés. Le secret est affiché une seule fois pour être communiqué au fournisseur, puis déposé en
// écriture seule (PUT /telemetry/providers/:id/credentials/SIGNATURE_WEBHOOK) : l'API le chiffre au
// repos et ne le renvoie jamais. La conformité (longueur, caractères) est vérifiée par l'API.

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Nouveau secret aléatoire ; `random` injectable pour les tests (Web Crypto par défaut). */
export function generateWebhookSecret(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  return `${WEBHOOK_SECRET_PREFIX}${toBase64Url(random(new Uint8Array(SECRET_BYTES)))}`;
}
